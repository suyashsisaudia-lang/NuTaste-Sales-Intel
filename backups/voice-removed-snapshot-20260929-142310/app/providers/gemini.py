"""
Google Gemini backend, called over plain HTTPS.

No vendor SDK: the generateContent endpoint is a single POST, and a direct
httpx call keeps the dependency list short and the failure modes visible.
"""
import base64
import json
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .base import ProviderError

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
ENDPOINT = BASE_URL + "/models/{model}:generateContent"
LIST_ENDPOINT = BASE_URL + "/models"

# The key can see dozens of models, most of them irrelevant here: image, audio,
# video, embedding and research models cannot answer a text classification.
# These patterns keep the picker to models that can actually do the job.
_EXCLUDE = re.compile(
    r"tts|image|imagen|veo|lyria|audio|embedding|aqa|vision|live|dialog|"
    r"banana|deep-research|robotics|computer-use|learnlm|gemma",
    re.I,
)
_INCLUDE = re.compile(r"flash|pro", re.I)


def _version_key(model_id: str) -> float:
    """Sortable version number out of a model id, e.g. gemini-3.6-flash -> 3.6.

    Ids with no version ("gemini-flash-latest") sort last on purpose. They are
    moving aliases: whatever they point at can change without notice, which is
    not what you want answering questions about money.
    """
    m = re.search(r"gemini-(\d+)(?:\.(\d+))?", model_id)
    if not m:
        return 0.0
    return float(f"{m.group(1)}.{m.group(2) or 0}")

# 429 is the per-minute rate limit and 503 is transient capacity pressure. Both
# clear on their own within a second or two, and both are common enough on a
# shared key that one retry turns most of them into a normal answer instead of
# a fallback the salesperson can see.
RETRY_STATUSES = (429, 503)
RETRY_PAUSE_SECONDS = 1.2
# Below this much remaining time a retry would outlast the caller's patience,
# so the built-in parser answers instead.
MIN_SECONDS_TO_RETRY = 3.0

# Models observed to reject generationConfig.thinkingConfig outright. Learned at
# runtime rather than hardcoded, since which models accept it keeps changing.
_NO_THINKING_CONFIG = set()


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str, model: str, timeout: float,
                 thinking_budget: int = 0) -> None:
        self._api_key = api_key
        self.model = model
        self._timeout = timeout
        self._thinking_budget = thinking_budget

    @property
    def _model(self) -> str:          # kept for readability inside this class
        return self.model

    def for_model(self, model: str, timeout: float = None) -> "GeminiProvider":
        return GeminiProvider(self._api_key, model,
                              self._timeout if timeout is None else timeout,
                              self._thinking_budget)

    def list_models(self) -> List[dict]:
        """Text models this key may call. Ordered newest-looking first.

        Failures return an empty list rather than raising: a model picker that
        cannot be populated is a cosmetic problem, and must never stop the Ask
        box from answering.
        """
        try:
            resp = httpx.get(LIST_ENDPOINT, timeout=self._timeout,
                             params={"pageSize": 200},
                             headers={"x-goog-api-key": self._api_key})
            if resp.status_code != 200:
                return []
            raw = resp.json().get("models", [])
        except (httpx.RequestError, ValueError):
            return []

        out = []
        for m in raw:
            mid = m.get("name", "").replace("models/", "")
            if not mid or "generateContent" not in m.get("supportedGenerationMethods", []):
                continue
            if _EXCLUDE.search(mid) or not _INCLUDE.search(mid):
                continue
            out.append({
                "id": mid,
                "label": m.get("displayName") or mid,
                "version": _version_key(mid),
            })
        # Newest version first, then the plain names before the previews.
        out.sort(key=lambda d: (-d["version"], "preview" in d["id"], d["id"]))
        return out

    def structured_json(self, system: str, user: str, schema: dict,
                        max_output_tokens: int = 2048,
                        thinking_budget: Optional[int] = None,
                        audio: Optional[Tuple[bytes, str]] = None) -> Dict[str, Any]:
        gen_config: Dict[str, Any] = {
            "responseMimeType": "application/json",
            "responseSchema": schema,
            # Deterministic: the same question must always produce the same
            # answer, or two salespeople comparing notes see different numbers
            # for the same words.
            "temperature": 0,
            "candidateCount": 1,
            "maxOutputTokens": max_output_tokens,
        }

        # Gemini models reason before answering, and that reasoning is
        # charged against maxOutputTokens — enough of it and the response comes
        # back empty. Classifying a question into a fixed schema needs none, so
        # it is off by default. Set GEMINI_THINKING_BUDGET to -1 for dynamic,
        # or to a token count on a model that requires one (Pro models need >=128).
        # Analyst mode passes its own budget: reading several hundred rows and
        # ranking them is exactly the work a classification did not need.
        budget = self._thinking_budget if thinking_budget is None else thinking_budget
        if budget >= 0:
            gen_config["thinkingConfig"] = {"thinkingBudget": budget}

        # A voice question arrives as (bytes, mime type) and travels inline
        # beside the text instructions; a short spoken question is far under
        # the inline-request size limit.
        parts: List[Dict[str, Any]] = [{"text": user}]
        if audio:
            data, mime = audio
            parts.append({"inlineData": {"mimeType": mime,
                                         "data": base64.b64encode(data).decode("ascii")}})

        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": gen_config,
        }

        # Not every model accepts a thinking budget — gemini-3.5-flash-lite
        # rejects thinkingBudget:0 with a flat 400. Rather than maintain a list
        # of which models support what, drop the setting and retry once; the
        # model is then remembered so the next question skips the wasted call.
        if self.model in _NO_THINKING_CONFIG:
            gen_config.pop("thinkingConfig", None)

        # One shared deadline across both attempts, so a retry can never make
        # the caller wait longer than the timeout it asked for.
        deadline = time.monotonic() + self._timeout
        resp = None

        for attempt in (1, 2, 3):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError("gemini timed out before a request could be sent")
            try:
                resp = httpx.post(
                    ENDPOINT.format(model=self._model),
                    json=body,
                    timeout=remaining,
                    headers={"x-goog-api-key": self._api_key,
                             "content-type": "application/json"},
                )
            except httpx.RequestError as exc:
                raise ProviderError(f"gemini transport: {exc}") from exc

            if resp.status_code == 200:
                break

            # A 400 while a thinking budget is set is almost always the model
            # refusing that field. Strip it and try again immediately before
            # treating the model as broken.
            if (resp.status_code == 400 and "thinkingConfig" in gen_config
                    and deadline - time.monotonic() >= MIN_SECONDS_TO_RETRY):
                _NO_THINKING_CONFIG.add(self.model)
                gen_config.pop("thinkingConfig", None)
                body["generationConfig"] = gen_config
                continue

            retryable = resp.status_code in RETRY_STATUSES
            time_left = deadline - time.monotonic() - RETRY_PAUSE_SECONDS
            if attempt < 3 and retryable and time_left >= MIN_SECONDS_TO_RETRY:
                time.sleep(RETRY_PAUSE_SECONDS)
                continue
            # The body can echo the key in some error shapes, so only the
            # status and a short excerpt are ever surfaced or logged.
            raise ProviderError(f"gemini http {resp.status_code}: {resp.text[:200]}",
                                status=resp.status_code)

        try:
            payload = resp.json()
            cand = payload["candidates"][0]
            parts = cand["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
        except (ValueError, KeyError, IndexError) as exc:
            # A response blocked by a safety filter has no candidates, and one
            # truncated by the token cap has no parts. Both land here rather
            # than looking like an empty answer; finishReason says which.
            reason = ""
            try:
                reason = payload["candidates"][0].get("finishReason", "")
            except Exception:
                reason = str(payload.get("promptFeedback", ""))[:120] if isinstance(payload, dict) else ""
            raise ProviderError(
                f"gemini returned no usable candidate ({exc}); finishReason={reason!r}",
                status=resp.status_code) from exc

        try:
            parsed = json.loads(text)
        except ValueError as exc:
            raise ProviderError(f"gemini returned non-JSON: {text[:200]}") from exc

        if not isinstance(parsed, dict):
            raise ProviderError("gemini returned JSON that is not an object")
        return parsed
