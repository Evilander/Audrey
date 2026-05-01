# Audrey Production Backlog

Updated: 2026-04-30 after the 0.22.1 production-readiness pass.

This file tracks release posture and remaining product work. It is intentionally
public-safe: it avoids exploit recipes, stale line references, and private
planning notes.

## Current Release Posture

Audrey 0.22.1 is ready for package-level release through the sandbox gate:

```bash
npm run release:gate:sandbox
npx audrey doctor
npx audrey status --fail-on-unhealthy
python -m unittest discover -s python/tests -v
python -m build --no-isolation python
```

The normal `npm test` command still depends on Vitest/Vite startup. On the
locked-down Windows Codex host, Vite calls `child_process.spawn` while loading
config and the host returns `spawn EPERM` before Audrey tests run. Treat that as
an environment limitation unless it reproduces on an unrestricted CI runner.

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
- Python package metadata builds cleanly as `audrey-memory 0.22.1`.
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
3. Add hook-level validation for Claude Code and Codex so `memory_preflight`,
   `memory_observe_tool`, and `memory_validate` run automatically in real
   agent sessions.
4. Start the Memory Controller Layer as the v0.23 chassis: classify writes,
   route recall, schedule replay, and treat validation feedback as a first-class
   signal.

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
