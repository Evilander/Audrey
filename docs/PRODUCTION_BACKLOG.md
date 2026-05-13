# Audrey Production Backlog

Updated: 2026-05-13 after the Audrey 1.0 release-cut and paper-gate pass.

This file tracks release posture and remaining product work. It is intentionally
public-safe: it avoids exploit recipes, stale line references, and private
planning notes.

## Current Release Posture

Audrey 1.0.0 has been cut locally and is ready for package-level validation
through the full gate:

```bash
npm run release:gate
npm run release:gate:paper
npm run release:cut:plan
npm run release:readiness
npm run python:release:check
npm run npm:smoke
npm run security:audit
npx audrey doctor
npx audrey status --fail-on-unhealthy
python -m unittest discover -s python/tests -v
python -m build --no-isolation python
```

`npm run release:readiness` is intentionally pending-aware. It exits cleanly
when local code and paper artifacts verify but the final 1.0 release is still
blocked on source-control release state, GitHub Release object readiness, npm
registry/auth readiness, PyPI publish readiness, authenticated browser
publication URLs, live Mem0/Zep evidence, or npm/PyPI account steps. Use
`npm run release:readiness:strict` only when cutting the actual 1.0 release;
strict mode must fail until those publish blockers are resolved.
`npm run release:cut:plan` is the dry-run version/changelog cut. It previews
the edits that `npm run release:cut:apply -- --target-version 1.0.0` would
write to `package.json`, `package-lock.json`, `mcp-server/config.ts`,
`python/audrey_memory/_version.py`, and `CHANGELOG.md`. The changelog plan is
publishable release-note copy rather than TODO scaffolding, and strict
readiness rejects placeholder markers if a manual edit reintroduces them.

`npm test` now routes through `scripts/run-vitest.mjs`, which sets `TEMP`,
`TMP`, and `TMPDIR` to `.tmp-vitest` before Vitest starts. That removes the
previous locked-down Windows temp-directory startup failure while keeping
`npm run release:gate:sandbox` available for hosts that block child-process
spawning entirely.

## Unreleased v0.23 Guard Chassis

The first Audrey Guard slice is now in the working tree:

- `src/controller.ts` adds `MemoryController.beforeAction()` and
  `afterAction()` over the existing tool-trace, reflex, preflight, capsule,
  validation, and impact primitives.
- `npx audrey guard --tool <Tool> "<action>"` runs the controller from the
  terminal, prints a screenshot-friendly guard decision, emits nonzero on
  `block`, and supports `--json`, `--explain`, `--override`, and
  `--fail-on-warn`.
- `npx audrey demo --scenario repeated-failure` is the deterministic
  no-network demo: a deploy fails once, Audrey records it, the next preflight
  blocks the repeat with evidence, and `impact` records the helpful validation.
- `Audrey.encodeBatch()` now uses provider-level `embedBatch()` instead of
  issuing one embedding call per episode.
- Guard exact-failure matching redacts before trimming, treats tool names
  case-insensitively, and includes file scope in the action hash so unrelated
  edits do not collide.
- Validation feedback can now bind to the exact `preflight_event_id`, evidence
  id set, and Guard action fingerprint that surfaced a memory; Audrey rejects
  lineage claims when the validated memory was not preflight evidence.
- `npx audrey guard --hook --fail-on-warn` consumes Claude Code `PreToolUse`
  JSON from stdin and emits the current `hookSpecificOutput.permissionDecision`
  shape; `npx audrey hook-config claude-code` generates PreToolUse and
  PostToolUse command hooks, with failed outcomes inferred from the
  PostToolUse hook payload.
- `npx audrey hook-config claude-code --apply --scope project|user` now merges
  those hooks into Claude Code settings, preserves unrelated settings/hooks,
  dedupes Audrey handlers, and writes a timestamped backup before changing an
  existing settings file.
- `npm run bench:guard:check` now publishes local GuardBench comparative
  numbers for ten pre-action scenarios across Audrey Guard, no-memory,
  recent-window, vector-only, and FTS-only adapters, including repeated failure
  prevention, recovered-path suppression, recall degradation, redaction safety,
  and noisy memory-store control recall.
- GuardBench now accepts external ESM adapters with `--adapter`, withholds
  expected decisions/evidence during adapter execution, and emits manifest,
  raw-output, and machine-provenance artifacts.
- `npm run bench:guard:adapter-smoke` exercises the external adapter loader
  through the real CLI path with a credential-free example adapter.
- `benchmarks/adapters/mem0-platform.mjs` is the first concrete external-system
  adapter. It uses Mem0 Platform REST APIs with runtime-only `MEM0_API_KEY`,
  async add/event polling, V2 search, and user-entity cleanup.
- `npm run bench:guard:mem0` wraps the live Mem0 run in a reproducible external
  GuardBench evidence bundle with runtime-env checks and
  `external-run-metadata.json`; `--dry-run` captures the exact command without
  needing credentials.
- `npm run release:gate:paper` is the publication gate: it rebuilds, typechecks,
  refreshes performance and behavioral benchmark outputs, runs GuardBench,
  syncs README/paper/ledger metrics from JSON artifacts, verifies paper
  consistency and redaction hygiene, runs the pending-aware 1.0 readiness
  checklist, then runs a clean-consumer npm package smoke test and the npm pack
  dry-run.
- Preflight now performs a supplemental tagged control-memory sweep for
  trusted `must-follow` memories so high-salience rules survive irrelevant
  memory noise.
- Recall partial-failure diagnostics now propagate into capsules and strict
  Guard preflights, so degraded vector/FTS paths become blocking memory-health
  warnings instead of silent empty context.
- `/v1/status` and `memory_status` expose the latest recall degradation check
  with the failing path and error message.
- `npm test` and `npm run test:watch` use the repo-local Vitest temp launcher,
  so full Vitest is no longer dependent on a writable user temp directory.
- `docs/AUDREY_PAPER_OUTLINE.md` defines the publishable Audrey Guard thesis
  and the GuardBench evaluation plan.

Still not production-complete Guard: Claude Code hook apply is explicit rather
than part of `install`, Codex hook wiring is not available yet, and validation
feedback is recorded but not yet used to tune risk scoring.

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
- Python package metadata builds cleanly as `audrey-memory 0.22.1`.
- Release scripts separate full CI (`release:gate`) from a reduced gate
  (`release:gate:sandbox`) for hosts that cannot start Vitest.

## Release Evidence To Keep Current

Before publishing a new npm or Python package, capture:

- `npm run release:gate` on a normal CI host.
- `npm run release:gate:sandbox` on locked-down local hosts.
- `npm run release:gate:paper` before publishing the paper, npm package, or
  public launch posts that quote benchmark numbers.
- `npm run release:readiness -- --json` to capture the current 1.0 prompt-to-artifact checklist.
- `npm run release:readiness:strict -- --json` immediately before npm publish, PyPI publish, and browser launch are claimed complete.
- `npm run release:cut:plan -- --target-version 1.0.0 --json` before applying the final version/changelog bump.
- `npm run python:release:check` to build wheel/sdist artifacts, inspect package metadata, check for local path leakage, and run `twine check`.
- `npm run npm:smoke` to prove the packed npm tarball installs in a clean consumer project, imports the public ESM API, runs encode/recall, and executes both CLI shims.
- `npm run security:audit`.
- `npm ci --dry-run`.
- Direct stdio MCP smoke: initialize, `tools/list`, `resources/list`,
  `prompts/list`, `resources/read audrey://status`.
- `npx audrey --version`, `npx audrey doctor --json`, and
  `npx audrey status --json --fail-on-unhealthy`.
- Python unit tests and `npm run python:release:check`.

## P0: Next Release Blockers

1. Add the equivalent Codex hook wiring when the host exposes a stable hook
   surface, and add a one-command Claude Code install mode that runs MCP
   registration plus hook apply after a dry-run preview.
2. Run the Mem0 Platform and Zep Cloud adapters with real runtime keys,
   publish their raw per-scenario outputs, then add Letta/Graphiti-style
   adapters.
3. Use validation feedback to tune warning priority, recommendation wording,
   and repeated-risk suppression without giving the model direct policy
   control.
4. Add MCP tool-risk policy inputs: descriptor fingerprints, annotation hints,
   trusted-server status, and descriptor drift warnings.

## 1.0 / Paper Publish Blockers

The local code and paper gates are strong, but the 1.0/publication objective is
not complete until `release:readiness:strict` passes. Current blockers:

- Source control is partially released remotely but not coherent yet: live
  GitHub refs now show `release/audrey-1.0.0` at `83eb0ad` while `v1.0.0` is
  still tag object `9a22dca` peeled to older commit `b3430fa`. Reconcile or
  recreate the tag on the final release commit before treating 1.0 as cut. This
  sandbox still cannot write `.git` metadata, the local `origin/master`
  tracking ref is stale versus live `53761da`, and the working tree still has
  uncommitted release/launch evidence changes. Fetch/reconcile from a
  credentialed host or a clean temporary clone before treating this checkout as
  source-control ready.
- The GitHub tag exists, but the public GitHub Releases API currently returns
  `404` for `v1.0.0`, and this browser session is not signed into GitHub. Publish
  a stable GitHub Release from the verified tag and attach or link the paper and
  submission artifacts before strict readiness can pass.
- npm publish readiness still needs CLI authentication: `audrey@1.0.0` is not
  published on the registry and `npm whoami` currently returns E401. The local
  tarball smoke now passes through `npm run npm:smoke`, including clean-consumer
  install, ESM import, encode/recall, and both CLI shims.
- PyPI publish readiness still needs runtime credentials or trusted-publisher
  evidence for the final `audrey-memory` upload.
- Browser launch results are still not complete: LinkedIn, Reddit, and Hacker
  News are submitted and verified, arXiv is account-authorization blocked under
  support ticket `AH-190018`, and X still needs a logged-in posting session. The
  first r/LocalLLaMA attempt was removed for insufficient subreddit karma, so
  the recorded Reddit launch URL is now the rule-checked r/ClaudeCode Showcase
  post. Audrey-specific Reddit replies in that thread now include the GitHub
  repo URL, including the PreToolUse/permissions.deny exchange and Moriarty's
  GuardBench feedback thread. The first Hacker News Show HN path was
  account-restricted, so the recorded Hacker News launch URL is the verified
  neutral link submission.
- Mem0 and Zep GuardBench evidence is still dry-run/pending until
  `MEM0_API_KEY` and `ZEP_API_KEY` are provided at runtime and strict external
  evidence passes.
- npm/PyPI publishing still needs account authentication and OTP handling.
- Production `npm audit --omit=dev --audit-level=moderate` is clean after the
  latest transitive `protobufjs` lockfile refresh.

## P1: Product Quality

1. Add `memory_ask` / `recallAuto()` for callers that should not choose a
   retrieval strategy manually.
2. Add adaptive hybrid recall weighting behind an environment flag, then compare
   against the current benchmark output before making it default.
3. Benchmark `encodeBatch` across mock, OpenAI, and Gemini providers before
   claiming cloud-provider speedups.
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

## v0.23 Product Direction (Tracked, Not Decided)

A 2026-05-01 audit recommends repositioning Audrey from a generic local
memory framework to **Audrey Guard** — a local-first memory firewall whose
single job is to stop AI coding agents from repeating expensive mistakes
before they touch tools. The core loop already exists in pieces in this
repo (`observeTool`, `preflight`, `reflexes`, `validate`, `impact`,
`promote`); the v0.23 work would be making them feel like one product
loop instead of separate primitives.

Open questions before committing to the rename:

- Is the marketing surface ("memory firewall for coding agents") narrower
  than the actual product can support across non-coding agents?
- Does keeping the current "local memory runtime" framing for the OSS core
  while branding the guard CLI separately give us the same wedge without
  abandoning existing positioning?

Concrete v0.23 work the audit identified, scoped to fit one or two
releases:

1. Host hook wiring for Claude Code and Codex so Guard runs automatically
   before tool use and tool outcomes feed back into trace/validation surfaces.
2. Memory Controller Layer (`src/controller.ts`) that owns
   `beforeAction(action) → GuardResult` and
   `afterAction(outcome) → void` over the existing primitives. This
   chassis also enables splitting `src/audrey.ts` (now ~1.2K lines) into
   focused services.
3. Benchmark the new batched `Audrey.encodeBatch()` path across mock, OpenAI,
   and Gemini providers before claiming cloud-provider speedups.
4. Hybrid-recall N+1: batch the FTS-only row loaders in
   `src/hybrid-recall.ts` by type instead of per-id SELECTs.
5. Persist recall-degradation history in the event log so status can show more
   than the latest in-process check.
6. Move the heavy local embedding dependency
   (`@huggingface/transformers` + ONNX) to `optionalDependencies` so
   non-local-provider users don't pay the install size.
7. Expand FTS-only confidence in hybrid recall through the same
   confidence/scoring pipeline used by vector candidates.
8. Add `AUDREY_STRICT_ISOLATION=1` and make strict agent scope the
   default before team scopes ship.

The "first paid feature" line of work — encrypted blob sync of local
Audrey stores ("Audrey Cloud Sync") — remains the smallest commercial
primitive that doesn't require rebuilding the product around hosted Postgres.
