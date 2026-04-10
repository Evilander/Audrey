"""Audrey Memory -- Python SDK for biological memory for AI agents."""

from .client import Audrey
from .async_client import AsyncAudrey
from .models import (
    EncodeResult, RecallResult, ConsolidationResult, DreamResult,
    IntrospectResult, TruthResolution, MemoryStatus, GreetingResult,
    ReflectResult, DecayResult, ForgetResult, HealthStatus, Mood,
    ContradictionCounts,
)

__version__ = "0.20.0"
__all__ = [
    "Audrey",
    "AsyncAudrey",
    "EncodeResult", "RecallResult", "ConsolidationResult", "DreamResult",
    "IntrospectResult", "TruthResolution", "MemoryStatus", "GreetingResult",
    "ReflectResult", "DecayResult", "ForgetResult", "HealthStatus", "Mood",
    "ContradictionCounts",
]
