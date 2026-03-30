# Audrey Roadmap Status - 2026-03-29

This note replaces stale assumptions from the earlier `codex.md` roadmap with the current repo state.

Canonical next-step strategy now lives in `docs/plans/industry-standard-memory-plan-2026-03-29.md`.

## Current State

- Multi-agent memory is already shipped.
- FTS-backed keyword search and hybrid retrieval are already shipped.
- TypeScript declarations are already shipped.
- REST API, dashboard, hooks integration, benchmarking, and CI are already shipped.

The roadmap should no longer treat those as future phases. The highest-value work now is production correctness, operator clarity, and benchmark credibility.

## Phase 0 Re-Evaluation

Original bug list status:

- `encode()` background work was tracked via `_pending`, but server and CLI shutdown paths still did not wait for that work to finish.
- `importMemories` snapshot validation is already in place.
- `recall()` degraded gracefully, but failure metadata was still too quiet for REST operators.
- Consolidation no longer uses raw `BEGIN IMMEDIATE`; it already uses `better-sqlite3` transactions.
- `parseBody` already guards against double-settle behavior.

## This Pass

- Added `Audrey.waitForIdle()` so production callers can drain tracked background work before shutdown or restore.
- Updated REST restore and process shutdown flows to wait for idle work before closing the database.
- Exposed `partialFailure` and `errors` on recall results and surfaced that metadata through the REST API.
- Fixed FTS keyword-search agent attribution so keyword-only multi-agent recall preserves the correct agent namespace.
- Added regression coverage for lifecycle draining, shutdown waiting, recall partial failures, and keyword-only multi-agent attribution.

## Recommended Next Passes

1. Clean the public docs and roadmap copy.
   The current README and some planning docs still contain mojibake artifacts that hurt first contact.

2. Make benchmark claims externally reproducible.
   Add first-party LoCoMo and LongMemEval adapters under `memorybench` or fold them into this repo in a reproducible way. This is now the top proof-stack requirement in `industry-standard-memory-plan-2026-03-29.md`.

3. Tighten restore and import contracts.
   Add explicit schema validation for snapshot versions and optional fields, then test malformed snapshots more aggressively.

4. Improve operational visibility.
   Add structured request logging and request IDs to the REST server, then expose recall failure counts in `/analytics`.

5. Harden the SDK shutdown story.
   Decide whether `close()` itself should eventually become async, or whether `waitForIdle()` remains the explicit graceful-shutdown contract.

## Strategic Reframe

The next competitive frame should be "memory control plane / memory OS" rather than "memory library with biological inspiration". The repo now has enough primitives to justify that direction, but it still needs:

- real external benchmark proof
- controller-mediated lifecycle policy
- temporal/entity-state memory
- utility-aware replay and ranking
- typed resource memory
