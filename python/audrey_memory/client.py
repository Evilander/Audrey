from __future__ import annotations

from typing import Any, Mapping, TypeVar

import httpx
from pydantic import BaseModel

from ._version import __version__
from .types import (
    AckResponse,
    AnalyticsResponse,
    ConsolidateRequest,
    DreamRequest,
    EncodeRequest,
    EncodeResponse,
    ForgetRequest,
    ForgetResponse,
    HealthResponse,
    MarkUsedRequest,
    MemorySnapshot,
    OperationResult,
    RecallRequest,
    RecallResponse,
    RecallResult,
    RestoreResponse,
    StatusResponse,
)

ModelT = TypeVar("ModelT", bound=BaseModel)
DEFAULT_TIMEOUT = 30.0
DEFAULT_BASE_URL = "http://127.0.0.1:7437"


class AudreyAPIError(RuntimeError):
    def __init__(self, status_code: int, message: str, response_body: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


def _build_headers(api_key: str | None, agent: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": f"audrey-memory-python/{__version__}",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if agent:
        headers["X-Audrey-Agent"] = agent
    return headers


def _dump_payload(payload: BaseModel | Mapping[str, Any] | None) -> dict[str, Any] | None:
    if payload is None:
        return None
    if isinstance(payload, BaseModel):
        return payload.model_dump(exclude_none=True, mode="json")
    return {key: value for key, value in dict(payload).items() if value is not None}


def _error_message(response: httpx.Response, data: Any) -> str:
    if isinstance(data, dict):
        detail = data.get("error") or data.get("message")
        if isinstance(detail, str) and detail.strip():
            return detail
    return f"Audrey API request failed with status {response.status_code}"


def _decode_json(response: httpx.Response) -> Any:
    try:
        data = response.json()
    except ValueError:
        data = None
    if response.is_error:
        raise AudreyAPIError(response.status_code, _error_message(response, data), data)
    return data


def _validate(model_type: type[ModelT], data: Any) -> ModelT:
    return model_type.model_validate(data)


def _build_model_payload(
    payload: BaseModel | Mapping[str, Any] | str,
    model_type: type[ModelT],
    field_name: str,
    extra: dict[str, Any],
) -> ModelT:
    if isinstance(payload, model_type):
        if extra:
            raise TypeError(f"{model_type.__name__} payload cannot be combined with keyword overrides")
        return payload
    if isinstance(payload, Mapping):
        if extra:
            raise TypeError(f"Mapping payload cannot be combined with keyword overrides for {model_type.__name__}")
        return model_type.model_validate(payload)
    return model_type.model_validate({field_name: payload, **extra})


def _optional_model_payload(
    payload: BaseModel | Mapping[str, Any] | None,
    model_type: type[ModelT],
    extra: dict[str, Any],
) -> ModelT | None:
    if isinstance(payload, model_type):
        if extra:
            raise TypeError(f"{model_type.__name__} payload cannot be combined with keyword overrides")
        return payload
    if payload is None:
        return model_type.model_validate(extra) if extra else None
    if extra:
        raise TypeError(f"Mapping payload cannot be combined with keyword overrides for {model_type.__name__}")
    return model_type.model_validate(payload)


class Audrey:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        api_key: str | None = None,
        agent: str | None = None,
        timeout: float | httpx.Timeout = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers=_build_headers(api_key, agent),
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Audrey:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def health(self) -> HealthResponse:
        return _validate(HealthResponse, _decode_json(self._client.get("/health")))

    def status(self) -> StatusResponse:
        return _validate(StatusResponse, _decode_json(self._client.get("/v1/status")))

    def analytics(self) -> AnalyticsResponse:
        # Not yet exposed by the TypeScript REST sidecar. Tracked as P1 in
        # docs/PRODUCTION_BACKLOG.md (memory_validate + analytics surface).
        # Raising NotImplementedError instead of letting users hit a confusing
        # 404 from Hono.
        raise NotImplementedError(
            "audrey.analytics() requires /v1/analytics on the REST sidecar, "
            "which is not yet implemented. See docs/PRODUCTION_BACKLOG.md (P0#1)."
        )

    def encode(self, payload: EncodeRequest | Mapping[str, Any] | str, /, **kwargs: Any) -> str:
        request = _build_model_payload(payload, EncodeRequest, "content", kwargs)
        data = _decode_json(self._client.post("/v1/encode", json=_dump_payload(request)))
        return _validate(EncodeResponse, data).id

    def recall(self, payload: RecallRequest | Mapping[str, Any] | str, /, **kwargs: Any):
        request = _build_model_payload(payload, RecallRequest, "query", kwargs)
        data = _decode_json(self._client.post("/v1/recall", json=_dump_payload(request)))
        # The TS server returns a bare list of results. Validate each row.
        if not isinstance(data, list):
            raise TypeError(f"unexpected /v1/recall payload shape: {type(data).__name__}")
        return [_validate(RecallResult, row) for row in data]

    def recall_response(self, payload: RecallRequest | Mapping[str, Any] | str, /, **kwargs: Any) -> RecallResponse:
        # Wraps recall() into a RecallResponse for callers that want the
        # structured shape. The TS server returns a bare list at /v1/recall;
        # we adapt client-side rather than changing the wire format.
        return RecallResponse(results=self.recall(payload, **kwargs))

    def dream(self, payload: DreamRequest | Mapping[str, Any] | None = None, /, **kwargs: Any) -> OperationResult:
        request = _optional_model_payload(payload, DreamRequest, kwargs)
        data = _decode_json(self._client.post("/v1/dream", json=_dump_payload(request)))
        return _validate(OperationResult, data)

    def consolidate(
        self,
        payload: ConsolidateRequest | Mapping[str, Any] | None = None,
        /,
        **kwargs: Any,
    ) -> OperationResult:
        request = _optional_model_payload(payload, ConsolidateRequest, kwargs)
        data = _decode_json(self._client.post("/v1/consolidate", json=_dump_payload(request)))
        return _validate(OperationResult, data)

    def mark_used(self, memory_id: str) -> AckResponse:
        # Not yet exposed by the TypeScript REST sidecar. Tracked as P0#1
        # in docs/PRODUCTION_BACKLOG.md (closed-loop memory_validate primitive).
        del memory_id
        raise NotImplementedError(
            "audrey.mark_used() requires /v1/mark-used on the REST sidecar, "
            "which is not yet implemented. See docs/PRODUCTION_BACKLOG.md (P0#1)."
        )

    def forget(
        self,
        *,
        id: str | None = None,
        query: str | None = None,
        purge: bool | None = None,
        min_similarity: float | None = None,
    ) -> ForgetResponse | None:
        request = ForgetRequest(
            id=id,
            query=query,
            purge=purge,
            minSimilarity=min_similarity,
        )
        data = _decode_json(self._client.post("/v1/forget", json=_dump_payload(request)))
        if data is None:
            return None
        return _validate(ForgetResponse, data)

    def snapshot(self) -> MemorySnapshot:
        # Server exposes snapshot as GET /v1/export.
        data = _decode_json(self._client.get("/v1/export"))
        return _validate(MemorySnapshot, data)

    def restore(self, snapshot: MemorySnapshot | Mapping[str, Any]) -> RestoreResponse:
        # Server exposes restore as POST /v1/import. The TS handler reads
        # body.snapshot (not the body root), so wrap the payload accordingly.
        request = snapshot if isinstance(snapshot, MemorySnapshot) else MemorySnapshot.model_validate(snapshot)
        data = _decode_json(self._client.post("/v1/import", json={"snapshot": _dump_payload(request)}))
        return _validate(RestoreResponse, data)


class AsyncAudrey:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        api_key: str | None = None,
        agent: str | None = None,
        timeout: float | httpx.Timeout = DEFAULT_TIMEOUT,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers=_build_headers(api_key, agent),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncAudrey:
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        await self.aclose()

    async def health(self) -> HealthResponse:
        return _validate(HealthResponse, _decode_json(await self._client.get("/health")))

    async def status(self) -> StatusResponse:
        return _validate(StatusResponse, _decode_json(await self._client.get("/v1/status")))

    async def analytics(self) -> AnalyticsResponse:
        # Not yet exposed by the TypeScript REST sidecar. See sync analytics().
        raise NotImplementedError(
            "audrey.analytics() requires /v1/analytics on the REST sidecar, "
            "which is not yet implemented. See docs/PRODUCTION_BACKLOG.md (P0#1)."
        )

    async def encode(self, payload: EncodeRequest | Mapping[str, Any] | str, /, **kwargs: Any) -> str:
        request = _build_model_payload(payload, EncodeRequest, "content", kwargs)
        data = _decode_json(await self._client.post("/v1/encode", json=_dump_payload(request)))
        return _validate(EncodeResponse, data).id

    async def recall(self, payload: RecallRequest | Mapping[str, Any] | str, /, **kwargs: Any):
        request = _build_model_payload(payload, RecallRequest, "query", kwargs)
        data = _decode_json(await self._client.post("/v1/recall", json=_dump_payload(request)))
        if not isinstance(data, list):
            raise TypeError(f"unexpected /v1/recall payload shape: {type(data).__name__}")
        return [_validate(RecallResult, row) for row in data]

    async def recall_response(self, payload: RecallRequest | Mapping[str, Any] | str, /, **kwargs: Any) -> RecallResponse:
        return RecallResponse(results=await self.recall(payload, **kwargs))

    async def dream(self, payload: DreamRequest | Mapping[str, Any] | None = None, /, **kwargs: Any) -> OperationResult:
        request = _optional_model_payload(payload, DreamRequest, kwargs)
        data = _decode_json(await self._client.post("/v1/dream", json=_dump_payload(request)))
        return _validate(OperationResult, data)

    async def consolidate(
        self,
        payload: ConsolidateRequest | Mapping[str, Any] | None = None,
        /,
        **kwargs: Any,
    ) -> OperationResult:
        request = _optional_model_payload(payload, ConsolidateRequest, kwargs)
        data = _decode_json(await self._client.post("/v1/consolidate", json=_dump_payload(request)))
        return _validate(OperationResult, data)

    async def mark_used(self, memory_id: str) -> AckResponse:
        del memory_id
        raise NotImplementedError(
            "audrey.mark_used() requires /v1/mark-used on the REST sidecar, "
            "which is not yet implemented. See docs/PRODUCTION_BACKLOG.md (P0#1)."
        )

    async def forget(
        self,
        *,
        id: str | None = None,
        query: str | None = None,
        purge: bool | None = None,
        min_similarity: float | None = None,
    ) -> ForgetResponse | None:
        request = ForgetRequest(
            id=id,
            query=query,
            purge=purge,
            minSimilarity=min_similarity,
        )
        data = _decode_json(await self._client.post("/v1/forget", json=_dump_payload(request)))
        if data is None:
            return None
        return _validate(ForgetResponse, data)

    async def snapshot(self) -> MemorySnapshot:
        # Server exposes snapshot as GET /v1/export.
        data = _decode_json(await self._client.get("/v1/export"))
        return _validate(MemorySnapshot, data)

    async def restore(self, snapshot: MemorySnapshot | Mapping[str, Any]) -> RestoreResponse:
        # Server exposes restore as POST /v1/import. The TS handler reads
        # body.snapshot (not the body root), so wrap the payload accordingly.
        request = snapshot if isinstance(snapshot, MemorySnapshot) else MemorySnapshot.model_validate(snapshot)
        data = _decode_json(await self._client.post("/v1/import", json={"snapshot": _dump_payload(request)}))
        return _validate(RestoreResponse, data)
