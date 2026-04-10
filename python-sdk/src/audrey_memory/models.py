from __future__ import annotations

from pydantic import BaseModel
from typing import Any


class EncodeResult(BaseModel):
    id: str
    content: str
    source: str
    private: bool = False


class RecallResult(BaseModel):
    id: str
    content: str
    type: str
    confidence: float
    score: float
    source: str
    createdAt: str
    state: str | None = None
    contextMatch: float | None = None
    moodCongruence: float | None = None


class ConsolidationResult(BaseModel):
    runId: str
    episodesEvaluated: int
    clustersFound: int
    principlesExtracted: int
    semanticsCreated: int | None = None
    proceduresCreated: int | None = None
    status: str | None = None


class DecayResult(BaseModel):
    totalEvaluated: int
    transitionedToDormant: int
    timestamp: str


class ContradictionCounts(BaseModel):
    open: int = 0
    resolved: int = 0
    context_dependent: int = 0
    reopened: int = 0


class IntrospectResult(BaseModel):
    episodic: int
    semantic: int
    procedural: int
    causalLinks: int
    dormant: int
    contradictions: ContradictionCounts
    lastConsolidation: str | None = None
    totalConsolidationRuns: int


class DreamResult(BaseModel):
    consolidation: ConsolidationResult
    decay: DecayResult
    stats: IntrospectResult


class MemoryStatus(BaseModel):
    episodes: int
    vec_episodes: int
    semantics: int
    vec_semantics: int
    procedures: int
    vec_procedures: int
    dimensions: int | None = None
    healthy: bool
    reembed_recommended: bool


class TruthResolution(BaseModel):
    resolution: str
    conditions: dict[str, str] | None = None
    explanation: str


class Mood(BaseModel):
    valence: float
    arousal: float
    samples: int


class GreetingResult(BaseModel):
    recent: list[dict[str, Any]] = []
    principles: list[dict[str, Any]] = []
    mood: Mood
    unresolved: list[dict[str, Any]] = []
    identity: list[dict[str, Any]] = []
    contextual: list[dict[str, Any]] | None = None


class ReflectResult(BaseModel):
    encoded: int
    memories: list[dict[str, Any]] = []
    skipped: str | None = None


class ForgetResult(BaseModel):
    id: str
    type: str
    purged: bool


class HealthStatus(BaseModel):
    status: str
    healthy: bool
