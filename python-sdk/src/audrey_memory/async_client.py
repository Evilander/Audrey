from __future__ import annotations

import httpx
from .models import (
    EncodeResult, RecallResult, ConsolidationResult, DreamResult,
    IntrospectResult, TruthResolution, MemoryStatus, GreetingResult,
    ReflectResult, DecayResult, ForgetResult, HealthStatus,
)
from typing import Any


class AsyncAudrey:
    """Async client for the Audrey memory HTTP API."""

    def __init__(
        self,
        base_url: str = "http://localhost:7437",
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncAudrey:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        res = await self._client.post(path, json=json or {})
        res.raise_for_status()
        return res.json()

    async def _get(self, path: str) -> Any:
        res = await self._client.get(path)
        res.raise_for_status()
        return res.json()

    async def health(self) -> HealthStatus:
        return HealthStatus(**await self._get("/health"))

    async def encode(
        self,
        content: str,
        source: str,
        *,
        tags: list[str] | None = None,
        salience: float | None = None,
        context: dict[str, str] | None = None,
        affect: dict[str, Any] | None = None,
        private: bool = False,
    ) -> EncodeResult:
        body: dict[str, Any] = {"content": content, "source": source}
        if tags is not None: body["tags"] = tags
        if salience is not None: body["salience"] = salience
        if context is not None: body["context"] = context
        if affect is not None: body["affect"] = affect
        if private: body["private"] = True
        return EncodeResult(**await self._post("/v1/encode", body))

    async def recall(
        self,
        query: str,
        *,
        limit: int | None = None,
        types: list[str] | None = None,
        min_confidence: float | None = None,
        tags: list[str] | None = None,
        sources: list[str] | None = None,
        after: str | None = None,
        before: str | None = None,
        context: dict[str, str] | None = None,
        mood: dict[str, float] | None = None,
    ) -> list[RecallResult]:
        body: dict[str, Any] = {"query": query}
        if limit is not None: body["limit"] = limit
        if types is not None: body["types"] = types
        if min_confidence is not None: body["min_confidence"] = min_confidence
        if tags is not None: body["tags"] = tags
        if sources is not None: body["sources"] = sources
        if after is not None: body["after"] = after
        if before is not None: body["before"] = before
        if context is not None: body["context"] = context
        if mood is not None: body["mood"] = mood
        return [RecallResult(**r) for r in await self._post("/v1/recall", body)]

    async def consolidate(
        self,
        *,
        min_cluster_size: int | None = None,
        similarity_threshold: float | None = None,
    ) -> ConsolidationResult:
        body: dict[str, Any] = {}
        if min_cluster_size is not None: body["min_cluster_size"] = min_cluster_size
        if similarity_threshold is not None: body["similarity_threshold"] = similarity_threshold
        return ConsolidationResult(**await self._post("/v1/consolidate", body))

    async def dream(
        self,
        *,
        min_cluster_size: int | None = None,
        similarity_threshold: float | None = None,
        dormant_threshold: float | None = None,
    ) -> DreamResult:
        body: dict[str, Any] = {}
        if min_cluster_size is not None: body["min_cluster_size"] = min_cluster_size
        if similarity_threshold is not None: body["similarity_threshold"] = similarity_threshold
        if dormant_threshold is not None: body["dormant_threshold"] = dormant_threshold
        return DreamResult(**await self._post("/v1/dream", body))

    async def introspect(self) -> IntrospectResult:
        return IntrospectResult(**await self._get("/v1/introspect"))

    async def resolve_truth(self, contradiction_id: str) -> TruthResolution:
        return TruthResolution(**await self._post("/v1/resolve-truth", {"contradiction_id": contradiction_id}))

    async def export_memories(self) -> dict[str, Any]:
        return await self._get("/v1/export")

    async def import_memories(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        return await self._post("/v1/import", {"snapshot": snapshot})

    async def forget(
        self,
        *,
        id: str | None = None,
        query: str | None = None,
        min_similarity: float | None = None,
        purge: bool = False,
    ) -> ForgetResult:
        body: dict[str, Any] = {"purge": purge}
        if id is not None: body["id"] = id
        if query is not None: body["query"] = query
        if min_similarity is not None: body["min_similarity"] = min_similarity
        return ForgetResult(**await self._post("/v1/forget", body))

    async def decay(self, *, dormant_threshold: float | None = None) -> DecayResult:
        body: dict[str, Any] = {}
        if dormant_threshold is not None: body["dormant_threshold"] = dormant_threshold
        return DecayResult(**await self._post("/v1/decay", body))

    async def status(self) -> MemoryStatus:
        return MemoryStatus(**await self._get("/v1/status"))

    async def reflect(self, turns: list[dict[str, str]]) -> ReflectResult:
        return ReflectResult(**await self._post("/v1/reflect", {"turns": turns}))

    async def greeting(self, *, context: str | None = None) -> GreetingResult:
        body: dict[str, Any] = {}
        if context is not None: body["context"] = context
        return GreetingResult(**await self._post("/v1/greeting", body))
