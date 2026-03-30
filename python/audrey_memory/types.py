from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AudreyModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class Affect(AudreyModel):
    valence: float
    arousal: float | None = None
    label: str | None = None


class HealthResponse(AudreyModel):
    ok: bool
    version: str


class ContradictionStatus(AudreyModel):
    open: int = 0
    resolved: int = 0
    context_dependent: int = 0
    reopened: int = 0


class StatusResponse(AudreyModel):
    episodic: int | None = None
    semantic: int | None = None
    procedural: int | None = None
    causalLinks: int | None = None
    contradictions: ContradictionStatus | None = None
    dormant: int | None = None
    lastConsolidation: str | None = None
    totalConsolidationRuns: int | None = None


class AnalyticsRow(AudreyModel):
    id: str | None = None
    content: str | None = None
    agent: str | None = None


class AnalyticsResponse(AudreyModel):
    topEpisodes: list[AnalyticsRow] = Field(default_factory=list)
    topSemantics: list[AnalyticsRow] = Field(default_factory=list)
    recentRuns: list[AnalyticsRow] = Field(default_factory=list)
    metrics: list[AnalyticsRow] = Field(default_factory=list)
    agents: list[AnalyticsRow] = Field(default_factory=list)


class EncodeRequest(AudreyModel):
    content: str
    source: str
    salience: float | None = Field(default=None, ge=0, le=1)
    tags: list[str] | None = None
    context: dict[str, Any] | None = None
    affect: Affect | None = None
    causal: dict[str, Any] | None = None
    supersedes: str | None = None
    private: bool | None = None
    agent: str | None = None


class EncodeResponse(AudreyModel):
    id: str


class RecallRequest(AudreyModel):
    query: str
    limit: int | None = Field(default=None, ge=1, le=50)
    context: dict[str, Any] | None = None
    mood: dict[str, Any] | None = None
    types: list[str] | None = None
    scope: str | None = None
    includePrivate: bool | None = None
    agent: str | None = None


class RecallResult(AudreyModel):
    id: str
    content: str
    type: str | None = None
    confidence: float | None = None
    score: float | None = None
    source: str | None = None
    createdAt: str | None = None
    agent: str | None = None


class RecallError(AudreyModel):
    type: str | None = None
    message: str | None = None


class RecallResponse(AudreyModel):
    results: list[RecallResult] = Field(default_factory=list)
    partialFailure: bool = False
    errors: list[RecallError] = Field(default_factory=list)


class DreamRequest(AudreyModel):
    dormantThreshold: float | None = Field(default=None, ge=0, le=1)
    minClusterSize: int | None = Field(default=None, ge=1)
    similarityThreshold: float | None = Field(default=None, ge=0, le=1)


class ConsolidateRequest(AudreyModel):
    minClusterSize: int | None = Field(default=None, ge=1)
    similarityThreshold: float | None = Field(default=None, ge=0, le=1)


class OperationResult(AudreyModel):
    ok: bool | None = None
    status: str | None = None


class MarkUsedRequest(AudreyModel):
    id: str


class AckResponse(AudreyModel):
    ok: bool


class ForgetRequest(AudreyModel):
    id: str | None = None
    query: str | None = None
    purge: bool | None = None
    minSimilarity: float | None = Field(default=None, ge=0, le=1)


class ForgetResponse(AudreyModel):
    id: str | None = None
    type: str | None = None
    purged: bool | None = None


class MemorySnapshot(AudreyModel):
    version: str
    exportedAt: str | None = None
    episodes: list[dict[str, Any]] = Field(default_factory=list)
    semantics: list[dict[str, Any]] = Field(default_factory=list)
    procedures: list[dict[str, Any]] = Field(default_factory=list)
    causalLinks: list[dict[str, Any]] = Field(default_factory=list)
    contradictions: list[dict[str, Any]] = Field(default_factory=list)
    consolidationRuns: list[dict[str, Any]] = Field(default_factory=list)
    consolidationMetrics: list[dict[str, Any]] = Field(default_factory=list)
    config: dict[str, Any] = Field(default_factory=dict)


class RestoreResponse(StatusResponse):
    ok: bool
