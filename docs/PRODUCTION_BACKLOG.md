# Audrey Production Backlog

Updated: 2026-05-05 after the 0.23.0 Audrey Guard release pass.

This file tracks release posture and remaining product work. It is intentionally
public-safe: it avoids exploit recipes, stale line references, and private
planning notes.

## Current Release Posture

Audrey 0.23.0 is ready for package-level release through the normal release gate:

```bash
npm run release:gate
npx audrey doctor
npx audrey status --fail-on-unhealthy
python -m unittest discover -s python/tests -v
python -m build --no-isolation python
```

The v0.23.0 local release gate passed on macOS with typecheck, perf gate,
full Vitest, behavioral memory benchmark, guard-loop benchmark, CLI smoke
checks, and npm pack dry-run. GitHub repository rules require PR checks before
`master` can move.

## Shipped In The 0.23.0 Audrey Guard Release

- Audrey Guard controller loop: `beforeAction()` / `afterAction()` plus SDK,
  REST, MCP, and CLI surfaces.
- Receipt-backed `go` / `caution` / `block` decisions over existing preflight,
  reflex, tool-trace, validation, and impact primitives.
- Guard receipt hardening: `guard-after` rejects non-guard receipts, rejects
  invalid evidence feedback outcomes, and prevents replaying one receipt into
  multiple post-action outcomes.
- `npx audrey guard` and `npx audrey guard-after` provide a hook-friendly
  command-line path for coding agents and CI workflows.
- Agent Guard Loop benchmark suite validates prior tool-failure caution,
  strict must-follow blocking, and guard receipt hardening without inflating
  comparable retrieval/lifecycle baseline charts.
- Release packaging now includes the benchmark harness and perf snapshots, and
  the release gate proves `--version`, `doctor --json`, and `demo` before pack.
- Version surfaces are aligned at `0.23.0` across npm, MCP CLI, package-lock,
  and Python client metadata.

## Shipped In The 0.22.2 Correctness Pass

- Two CodeRabbit review passes plus a CodeQL audit landed: see `CHANGELOG.md#0222---2026-05-01`.
  Net result: every critical and major finding from the first pass was
  eliminated; the second pass surfaced a duplicate of the `vec_*.state`
  stale-denormalization bug in `src/interference.ts` and an API-key auth
  length-leak in `src/routes.ts`, both fixed.
- `GET /v1/impact` REST route + Python `impact()` on sync and async clients.
  `analytics()` is now an alias of `impact()`.
- Python integration tests unskipped; they spin up the real TS REST sidecar
  and exercise encode → recall → mark_used → impact → snapshot → restore.
- Legitimate performance benchmarks (`npm run bench:perf-snapshot`) replace
  the synthetic-baseline SVGs that previously shipped in README.

## Shipped In The 0.22.1 Hardening Pass

- Agent-scoped encode, recall, greeting, capsule, preflight, reflex, and
  consolidation paths.
- Admin export, import, and forget tools/routes fail closed unless
  `AUDREY_ENABLE_ADMIN_TOOLS=1` is set.
- Snapshot import uses bounded schemas for memory rows, config, events,
  consolidation history, and content size.
- Export/import now preserves `memory_events` and consolidated-memory agent
  ownership.
- Stored memory content is wrapped as untrusted data before LLM extraction,
  contradiction, reflection, and rule-promotion prompts.
- Local embeddings are the default. Cloud embedding providers require explicit
  `AUDREY_EMBEDDING_PROVIDER`.
- MCP stdio now exposes memory tools, `audrey://status`, `audrey://recent`,
  `audrey://principles`, and briefing/recall/reflection prompt templates.
- Python package metadata builds cleanly as `audrey-memory`.
- Release scripts separate full CI (`release:gate`) from this sandbox's
  spawn-safe gate (`release:gate:sandbox`).

## Release Evidence To Keep Current

Before publishing a new npm or Python package, capture:

- `npm run release:gate` on a normal CI host.
- `npm run release:gate:sandbox` on locked-down local hosts.
- `npm audit --omit=dev --audit-level=moderate`.
- `npm ci --dry-run`.
- Direct stdio MCP smoke: initialize, `tools/list`, `resources/list`,
  `prompts/list`, `resources/read audrey://status`.
- `npx audrey --version`, `npx audrey doctor --json`, and
  `npx audrey status --json --fail-on-unhealthy`.
- Python unit tests and `python -m build --no-isolation python`.

## P0: Next Release Blockers

1. Run the full Vitest suite in GitHub Actions or another unrestricted host and
   attach the passing job URL to the release.
2. Publish external benchmark numbers for Audrey's strongest tracks:
   conflict handling, causal memory, and memory-before-action workflows.
3. Add hook-level installation for Claude Code and Codex so `audrey guard`
   and `audrey guard-after` run automatically in real agent sessions.
4. Add signed guard receipts or receipt digests before team/shared-memory
   audit trails become a paid surface.

## P1: Product Quality

1. Add `memory_ask` / `recallAuto()` for callers that should not choose a
   retrieval strategy manually.
2. Add adaptive hybrid recall weighting behind an environment flag, then compare
   against the current benchmark output before making it default.
3. Batch embeddings in `encodeBatch` with provider-level `embedBatch` calls.
4. Add a visible `audrey impact` or dashboard story that shows memories used,
   helpful, wrong, decayed, and promoted over time.
5. Add install smoke tests for generated Codex, Claude Code, VS Code, Cursor,
   and Windsurf MCP configs.

## P2: Hardening And Scale

1. Move large local embedding dependencies to optional install paths if package
   size becomes a distribution blocker.
2. Add event-log retention controls for long-running tool-trace stores.
3. Add signed import/export bundles for cross-machine memory transfer.
4. Cache prepared statements on hot recall paths if production profiling shows
   SQLite prepare overhead above budget.
5. Add bitemporal belief fields for facts that change over time.

## Commercial Wedge

The product wedge remains "memory before action": Audrey should prevent agents
from repeating known bad actions, ignoring known workflows, or acting without
the context they already earned. The strongest paid surface is likely team
memory operations: policy editor, memory diff/rollback, audit log, shared
encrypted stores, hosted relay, CI gates, and support.

## v0.23 Product Direction (Shipped Baseline)

A 2026-05-01 audit recommended repositioning Audrey from a generic local
memory framework to **Audrey Guard** — a local-first memory firewall whose
single job is to stop AI coding agents from repeating expensive mistakes
before they touch tools. The core loop already exists in pieces in this
repo (`observeTool`, `preflight`, `reflexes`, `validate`, `impact`,
`promote`); v0.23.0 made them feel like one product loop instead of separate
primitives.

Open questions before going harder on the rename:

- Is the marketing surface ("memory firewall for coding agents") narrower
  than the actual product can support across non-coding agents?
- Does keeping the current "local memory runtime" framing for the OSS core
  while branding the guard CLI separately give us the same wedge without
  abandoning existing positioning?

Concrete v0.23 work from the audit:

0. Shipped in v0.23.0: Audrey Guard controller:
   `beforeAction()` / `afterAction()` plus REST, MCP, and CLI surfaces.
   The first slice uses `memory_events` metadata as receipts, avoids a
   schema migration, and has a local guard-loop benchmark for prior
   tool-failure cautions and strict must-follow blocking.
1. Shipped in v0.23.0: `npx audrey guard --tool <Tool> "<command>"` CLI that returns
   `go` / `caution` / `block` with evidence and is the headline demo.
2. Shipped in v0.23.0: Memory Controller Layer (`src/controller.ts`) that owns
   `beforeAction(action) → GuardDecision` and
   `afterAction(outcome) → GuardOutcome` over the existing primitives. This
   chassis also enables splitting `src/audrey.ts` (now ~1.2K lines) into
   focused services.
3. Actually batch embeddings in `Audrey.encodeBatch()` with
   `embeddingProvider.embedBatch()` — currently it loops single-encode
   calls, paying N sequential round-trips for cloud providers.
4. Hybrid-recall N+1: batch the FTS-only row loaders in
   `src/hybrid-recall.ts` by type instead of per-id SELECTs.
5. Surface partial recall failures (currently swallowed in
   `src/recall.ts`) via diagnostics, preflight, and `/v1/status` so the
   guard story is honest when retrieval is degraded.
6. Move the heavy local embedding dependency
   (`@huggingface/transformers` + ONNX) to `optionalDependencies` so
   non-local-provider users don't pay the install size.
7. Expand FTS-only confidence in hybrid recall through the same
   confidence/scoring pipeline used by vector candidates.
8. Add `AUDREY_STRICT_ISOLATION=1` and make strict agent scope the
   default before team scopes ship.

The "first paid feature" line of work — encrypted blob sync of local
Audrey stores ("Audrey Cloud Sync") — remains the smallest commercial
primitive that doesn't require rebuilding the product around hosted
Postgres.
