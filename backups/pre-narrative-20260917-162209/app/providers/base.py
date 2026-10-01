"""Provider protocol shared by every model backend."""
from typing import List, Optional, Protocol

# Statuses that mean "this model cannot answer right now, but another one
# might": the daily/per-minute quota is spent, the model is overloaded, or it
# has been retired. Anything else is a real fault and stops the attempt.
FAILOVER_STATUSES = (404, 429, 503)


class ProviderError(Exception):
    """Any failure talking to a model: transport, auth, quota or bad output.

    `status` carries the HTTP status where there was one, so the caller can
    tell "try the next model" apart from "stop, something is actually wrong".
    """

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status

    @property
    def is_quota(self) -> bool:
        return self.status == 429

    @property
    def can_failover(self) -> bool:
        return self.status in FAILOVER_STATUSES


class Provider(Protocol):
    name: str
    model: str

    def structured_json(self, system: str, user: str, schema: dict) -> dict:
        """Return the model's answer parsed as JSON, constrained to `schema`.

        Must raise ProviderError rather than returning partial or unparsed
        output, so the caller never has to guess whether a result is usable.
        """
        ...

    def for_model(self, model: str) -> "Provider":
        """Same credentials and settings, a different model."""
        ...

    def list_models(self) -> List[dict]:
        """Text models this key can call, newest-capable first."""
        ...
