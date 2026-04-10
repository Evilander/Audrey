from __future__ import annotations

import httpx
from .models import (
    EncodeResult, RecallResult, ConsolidationResult, DreamResult,
    IntrospectResult, TruthResolution, MemoryStatus, GreetingResult,
    ReflectResult, DecayResult, ForgetResult, HealthStatus,
)
from typing import Any


class Audrey:
    """Sync client for the Audrey memory HTTP API."""

    def __init__(
        self,
        base_url: str = "http://localhost:7437",
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.Client(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Audrey:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def _post(self, path: str, json: dict[str, Any] | None = None) -> Any:
        res = self._client.post(path, json=json or {})
        res.raise_for_status()
        return res.json()

    def _get(self, path: str) -> Any:
        res = self._client.get(path)
        res.raise_for_status()
        return res.json()

    def health(self) -> HealthStatus:
        return HealthStatus(**self._get("/health"))

    def encode(
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
        return EncodeResult(**self._post("/v1/encode", body))

    def recall(
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
        return [RecallResult(**r) for r in self._post("/v1/recall", body)]

    def consolidate(
        self,
        *,
        min_cluster_size: int | None = None,
        similarity_threshold: float | None = None,
    ) -> ConsolidationResult:
        body: dict[str, Any] = {}
        if min_cluster_size is not None: body["min_cluster_size"] = min_cluster_size
        if similarity_threshold is not None: body["similarity_threshold"] = similarity_threshold
        return ConsolidationResult(**self._post("/v1/consolidate", body))

    def dream(
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
        return DreamResult(**self._post("/v1/dream", body))

    def introspect(self) -> IntrospectResult:
        return IntrospectResult(**self._get("/v1/introspect"))

    def resolve_truth(self, contradiction_id: str) -> TruthResolution:
        return TruthResolution(**self._post("/v1/resolve-truth", {"contradiction_id": contradiction_id}))

    def export_memories(self) -> dict[str, Any]:
        return self._get("/v1/export")

    def import_memories(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        return self._post("/v1/import", {"snapshot": snapshot})

    def forget(
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
        return ForgetResult(**self._post("/v1/forget", body))

    def decay(self, *, dormant_threshold: float | None = None) -> DecayResult:
        body: dict[str, Any] = {}
        if dormant_threshold is not None: body["dormant_threshold"] = dormant_threshold
        return DecayResult(**self._post("/v1/decay", body))

    def status(self) -> MemoryStatus:
        return MemoryStatus(**self._get("/v1/status"))

    def reflect(self, turns: list[dict[str, str]]) -> ReflectResult:
        return ReflectResult(**self._post("/v1/reflect", {"turns": turns}))

    def greeting(self, *, context: str | None = None) -> GreetingResult:
        body: dict[str, Any] = {}
        if context is not None: body["context"] = context
        return GreetingResult(**self._post("/v1/greeting", body))
