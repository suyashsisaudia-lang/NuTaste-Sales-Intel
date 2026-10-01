"""
Model providers.

The Ask feature needs exactly one thing from a language model: turn a question
into a JSON filter spec that matches a schema. Nothing about that is specific
to Gemini, so the call sits behind `Provider` and the rest of the application
never imports a vendor SDK. Swapping to another model is a new module here plus
one line in `get_provider`.
"""
from typing import Optional

from .base import Provider, ProviderError
from .gemini import GeminiProvider

__all__ = ["Provider", "ProviderError", "GeminiProvider", "get_provider"]


def get_provider(name: str, api_key: str, model: str, timeout: float,
                 thinking_budget: int = 0) -> Optional[Provider]:
    """Return a configured provider, or None when the feature is not set up.

    Returning None rather than raising keeps the app bootable without a key:
    /api/ask reports the feature as off and the frontend falls back to its own
    parser.
    """
    if not api_key:
        return None
    if name == "gemini":
        return GeminiProvider(api_key=api_key, model=model, timeout=timeout,
                              thinking_budget=thinking_budget)
    raise ProviderError(f"Unknown ASK_PROVIDER '{name}'. Supported: gemini")
