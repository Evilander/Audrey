"""Tests for the Audrey Python SDK.

These tests validate the SDK's API surface and type annotations.
Integration tests requiring a running server are marked with @pytest.mark.integration.
"""
import pytest
from audrey_memory import Audrey, AsyncAudrey
from audrey_memory.models import (
    EncodeResult, RecallResult, ConsolidationResult, DreamResult,
    IntrospectResult, TruthResolution, MemoryStatus, GreetingResult,
    ReflectResult, DecayResult, ForgetResult, HealthStatus, Mood,
    ContradictionCounts,
)


class TestSyncClientAPI:
    """Verify sync client has the expected API surface."""

    def test_constructor_defaults(self):
        client = Audrey()
        assert "localhost:7437" in str(client._client.base_url)
        client.close()

    def test_constructor_custom_url(self):
        client = Audrey(base_url="http://example.com:9999")
        assert "example.com" in str(client._client.base_url)
        client.close()

    def test_constructor_api_key(self):
        client = Audrey(api_key="test-key")
        assert client._client.headers["authorization"] == "Bearer test-key"
        client.close()

    def test_context_manager(self):
        with Audrey() as client:
            assert client is not None

    def test_has_all_methods(self):
        """Verify the client exposes all 15 expected methods."""
        expected = {
            'health', 'encode', 'recall', 'consolidate', 'dream',
            'introspect', 'resolve_truth', 'export_memories', 'import_memories',
            'forget', 'decay', 'status', 'reflect', 'greeting', 'close',
        }
        client = Audrey()
        actual = {m for m in dir(client) if not m.startswith('_')}
        assert expected.issubset(actual), f"Missing methods: {expected - actual}"
        client.close()


class TestAsyncClientAPI:
    """Verify async client mirrors sync client."""

    def test_has_all_methods(self):
        expected = {
            'health', 'encode', 'recall', 'consolidate', 'dream',
            'introspect', 'resolve_truth', 'export_memories', 'import_memories',
            'forget', 'decay', 'status', 'reflect', 'greeting', 'close',
        }
        client = AsyncAudrey()
        actual = {m for m in dir(client) if not m.startswith('_')}
        assert expected.issubset(actual), f"Missing methods: {expected - actual}"

    @pytest.mark.asyncio
    async def test_async_context_manager(self):
        async with AsyncAudrey() as client:
            assert client is not None


class TestModels:
    """Verify Pydantic models parse correctly."""

    def test_encode_result(self):
        r = EncodeResult(id="abc", content="test", source="direct-observation")
        assert r.id == "abc"
        assert r.private is False

    def test_recall_result(self):
        r = RecallResult(
            id="abc", content="test", type="episodic",
            confidence=0.9, score=0.8, source="direct-observation",
            createdAt="2026-01-01",
        )
        assert r.type == "episodic"

    def test_introspect_result(self):
        r = IntrospectResult(
            episodic=10, semantic=5, procedural=2,
            causalLinks=1, dormant=0,
            contradictions=ContradictionCounts(),
            totalConsolidationRuns=0,
        )
        assert r.episodic == 10

    def test_dream_result(self):
        d = DreamResult(
            consolidation=ConsolidationResult(
                runId="r1", episodesEvaluated=10,
                clustersFound=2, principlesExtracted=1,
            ),
            decay=DecayResult(
                totalEvaluated=5, transitionedToDormant=0,
                timestamp="2026-01-01",
            ),
            stats=IntrospectResult(
                episodic=10, semantic=5, procedural=2,
                causalLinks=1, dormant=0,
                contradictions=ContradictionCounts(),
                totalConsolidationRuns=1,
            ),
        )
        assert d.consolidation.clustersFound == 2

    def test_greeting_result(self):
        g = GreetingResult(mood=Mood(valence=0.5, arousal=0.3, samples=10))
        assert g.mood.valence == 0.5

    def test_health_status(self):
        h = HealthStatus(status="ok", healthy=True)
        assert h.healthy is True

    def test_memory_status(self):
        m = MemoryStatus(
            episodes=10, vec_episodes=10,
            semantics=3, vec_semantics=3,
            procedures=1, vec_procedures=1,
            healthy=True, reembed_recommended=False,
        )
        assert m.healthy is True
        assert m.reembed_recommended is False

    def test_truth_resolution(self):
        t = TruthResolution(
            resolution="accepted",
            explanation="The newer observation supersedes the old one.",
        )
        assert t.resolution == "accepted"
        assert t.conditions is None

    def test_reflect_result(self):
        r = ReflectResult(encoded=3)
        assert r.encoded == 3
        assert r.memories == []

    def test_forget_result(self):
        f = ForgetResult(id="xyz", type="episodic", purged=True)
        assert f.purged is True

    def test_decay_result(self):
        d = DecayResult(
            totalEvaluated=50, transitionedToDormant=2,
            timestamp="2026-03-15T00:00:00Z",
        )
        assert d.transitionedToDormant == 2

    def test_contradiction_counts_defaults(self):
        c = ContradictionCounts()
        assert c.open == 0
        assert c.resolved == 0
        assert c.context_dependent == 0
        assert c.reopened == 0


# Integration tests — require a running `npx audrey serve`
@pytest.mark.integration
class TestIntegration:
    """Integration tests that require a running Audrey server.

    Run with: pytest -m integration
    Skip with: pytest -m "not integration" (default)
    """

    def test_health(self):
        with Audrey() as brain:
            result = brain.health()
            assert result.status == "ok"

    def test_encode_and_recall(self):
        with Audrey() as brain:
            encoded = brain.encode(
                content="Test memory from Python SDK",
                source="direct-observation",
                tags=["test", "python"],
            )
            assert encoded.id
            results = brain.recall("test memory python", limit=5)
            assert len(results) > 0

    def test_dream(self):
        with Audrey() as brain:
            result = brain.dream()
            assert result.stats.episodic >= 0

    def test_introspect(self):
        with Audrey() as brain:
            result = brain.introspect()
            assert isinstance(result.episodic, int)

    def test_status(self):
        with Audrey() as brain:
            result = brain.status()
            assert isinstance(result.healthy, bool)
