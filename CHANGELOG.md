# Changelog

## 1.0.1 - 2026-05-15

### Honest benchmarking

- **GuardBench pass gate rewritten.** The `passed` check no longer requires Audrey-specific lineage substrings (`"failed before"`, `"recall:"`, `"must-follow"`, etc.) in the subject's `summary`. A scenario passes when the decision matches the expected verdict, no seeded secrets leak, and (for `block`/`warn` scenarios) the subject returns at least one evidence id. The prior phrase-substring gate was structurally biased toward Audrey because only its controller emitted those exact tokens; baselines or external adapters that produced semantically correct decisions could still fail the gate on phrasing alone. The Audrey-style lineage match is preserved as a separate `lineageTextMatched` field per row and `lineageRichness` per system, reported as an informational metric, not the pass gate.
- Adds `lineageRichness` and `hasEvidenceForDecision` to GuardBench raw + summary schemas; `requiredEvidenceMatched` is kept as a back-compat alias of `hasEvidenceForDecision`.

### Guard runtime

- **`MemoryController` no longer hard-blocks repeated failures forever.** A new `failureDecayDays` constructor option defaults to 7: same-action prior failures older than that window are treated as stale and no longer trigger an automatic block. Pass `failureDecayDays: 0` to restore the pre-1.0.1 behavior.
- Adds `AgentAction.acknowledgePriorFailure` on the `MemoryController` SDK surface. When set, an exact-repeated-failure that would otherwise produce `block` degrades to `warn`. Evidence ids and risk score remain attached so the prior failure still surfaces in the action receipt. A CLI flag exposing this through `audrey guard` will land in a follow-up release.

### Structured errors

- `Audrey.validate()` lineage rejections now throw `ValidateLineageError` with a stable `code` (`PREFLIGHT_NOT_FOUND` | `PREFLIGHT_WRONG_TYPE` | `LINEAGE_REJECTED` | `ACTION_KEY_MISMATCH`). `POST /v1/validate` surfaces the same code in the 400 response body so HTTP and MCP callers can branch on the failure shape without parsing the message string. `ValidateLineageError` and `ValidateErrorCode` are exported from the public SDK entry point.

### Documentation

- README's GuardBench section caveats the headline number against the mock 64-dim provider, the 5-of-10 expected-block scenario count, and the new evidence-non-empty gate so the "10/10 vs baselines" framing matches the actual contract.
- README documents `AUDREY_DATA_DIR` per-tenant isolation as a hard requirement (SQLite WAL mode has no advisory lock; two processes in one data dir contend).
- README dev path notes `npm run build` before any source-tree CLI subcommand resolves.
- Paper section reframes `bench:memory:check` as an internal regression suite, not a competitive benchmark, so local stub baselines are not cited as cross-system claims.
- Personal-env diagnostic logs (`gcm-diagnose.log`, scratch `*.log`, `audrey-arxiv-preview.png`) excluded from repo root and `.gitignore` broadened.

## 1.0.0 - 2026-05-13

### Audrey Guard

- Ships Audrey Guard as the release-defining loop: receipt-backed `go`,
  `caution`, and `block` decisions before tool use, followed by auditable
  outcome capture through CLI, REST, MCP, and SDK surfaces.
- Adds Claude Code hook generation and an idempotent hook-apply path so
  `guard --hook --fail-on-warn` can run at `PreToolUse` and post-tool events
  can feed Audrey's redacted trace memory.
- Binds validation feedback to preflight event ids, evidence ids, and action
  fingerprints so remembered guidance can be audited after use.

### GuardBench And Paper Artifacts

- Ships GuardBench, a local comparative benchmark for pre-action memory control
  across Audrey Guard, no-memory, recent-window, vector-only, and FTS-only
  baselines.
- Adds portable GuardBench bundles, conformance cards, JSON schemas, adapter
  self-tests, leaderboard generation, external adapter dry-runs, and pending
  external evidence reports for Mem0 Platform and Zep Cloud.
- Ships the Audrey Guard paper source, claim register, publication-pack
  verifier, browser launch plan/results ledger, deterministic arXiv source
  package, local arXiv compile proof, and paper submission bundle.

### Release Controls

- Adds pending-aware `release:readiness` and strict `release:readiness:strict`
  gates so code, paper, source control, npm, PyPI, browser publication, and
  external-evidence blockers stay separate.
- Adds `release:cut:plan` and `release:cut:apply` so npm, lockfile, MCP,
  Python, and changelog version surfaces are cut consistently.
- Adds production dependency audit coverage to release gates and keeps
  `npm audit --omit=dev --audit-level=moderate` clean.

### Runtime And Client Hardening

- `Audrey.encodeBatch()` now calls provider-level `embedBatch()` once per batch
  and writes each episode through the existing `encodeEpisode()` path with the
  precomputed vector.
- OpenAI embedding batches are chunked by `batchSize` so large batch encodes do
  not turn into one oversized API request.
- Improves recall degradation reporting across capsules, strict preflights,
  status surfaces, and Guard decisions.

## 0.23.0 - 2026-05-05

### Audrey Guard — memory before action becomes the product loop

- Added Audrey Guard as a first-class controller loop: `beforeAction()` checks memory before an agent touches tools, returns a receipt-backed `go` / `caution` / `block` decision, and `afterAction()` records what happened afterward.
- Added JavaScript SDK exports and `Audrey.beforeAction()` / `Audrey.afterAction()` methods so agent runtimes can use the same loop without going through CLI or REST.
- Added `POST /v1/guard/before` and `POST /v1/guard/after` REST routes for sidecar agents.
- Added `memory_guard_before` and `memory_guard_after` MCP tools for hosts that want memory decisions at the tool boundary.
- Added `npx audrey guard` and `npx audrey guard-after` CLI commands, including JSON output for hooks and automation.

### Release-defining behavior

- Guard decisions reuse the existing preflight and reflex machinery without doing two independent recall passes.
- Guard receipts are stored as `memory_events` rows with guard metadata, evidence ids, reflex ids, preflight decision, warning counts, and redacted tool-trace linkage.
- `guard-after` now validates evidence feedback before mutating memory, rejects non-guard receipts, and prevents replaying the same receipt to apply duplicate feedback.
- A failed guarded tool run becomes future memory: the next guard check for the same tool can produce a recent-failure warning and reflex before the agent repeats the mistake.
- Strict guard mode can block high-severity must-follow memories before risky actions, which is the release's headline "memory firewall" behavior.

### Benchmarks

- Added an Agent Guard Loop benchmark suite covering prior tool-failure caution, strict must-follow blocking, receipt replay rejection, and non-guard receipt rejection.
- Added `npm run bench:memory:guard` for focused guard-loop regression testing.
- Kept guard-loop cases out of the comparable retrieval/lifecycle aggregate when all suites are run, so the local baseline chart remains honest rather than inflated by no-controller placeholders.
- Committed a fresh `benchmarks/snapshots/perf-0.23.0.json` performance snapshot and fixed direct snapshot runs so they resolve Audrey's package version without depending on npm-injected environment.
- Added a CLI smoke script to the release gate and Node CI jobs so `--version`, `doctor --json`, and `demo` are proven before pack dry-run.
- Included benchmark harness files and snapshots in the npm package so advertised benchmark scripts work from the published tarball.
- Added a package-lock consistency test so release versions cannot drift between `package.json` and `package-lock.json` again.

### Docs and release posture

- Updated README quick-start, surface tables, and benchmark notes around Audrey Guard.
- Added `docs/MEMORY_BENCHMARKING.md` to state the release's benchmark policy and map Audrey against LongMemEval, LoCoMo, MemoryAgentBench, StructMemEval, and MemGUI-Bench.
- Added release design and implementation docs under `docs/superpowers/`.
- Updated the production backlog to mark the v0.23 controller slice as shipped and to focus the next work on hook installation, external benchmark evidence, batching, and partial recall diagnostics.
- Bumped JavaScript, MCP CLI, and Python client version surfaces to `0.23.0`.
- Added the Python 3.9 `eval-type-backport` dependency marker required by Pydantic for Audrey's modern type annotations, and moved Python package metadata to the current setuptools license form.

## 0.22.2 - 2026-05-01

### Correctness — second CodeRabbit review pass and code-scanning audit

- `src/forget.ts` `WHERE v.state ...` was filtering on the denormalized state column on `vec_semantics` / `vec_procedures`. That column is only populated at INSERT and never updated, so dormant or superseded rows were still passing the filter. Switched to `s.state` / `p.state`. Same fix applied to `src/interference.ts` after the second review pass caught the duplicate.
- Wrapped `forgetMemory`, `purgeMemories`, `applyDecay`, `applyInterference`, and the contradiction insert + state update in `src/validate.ts` in transactions so partial failures can't leave inconsistent counts or orphan contradictions.
- `mcp-server/index.ts` `VALID_SOURCES` and `VALID_TYPES` were object literals fed to `z.enum()`, which expects a tuple. Converted to const tuples so the MCP schemas validate correctly.
- `src/utils.ts` `cosineSimilarity` now throws on length mismatch instead of silently returning NaN; `daysBetween` throws on invalid date strings.
- `src/ulid.ts` `generateDeterministicId` rebuilt as canonicalize → SHA-256 → first 16 bytes → Crockford Base32. The previous shape used `JSON.stringify` (object-key-order-unstable) and emitted hex characters, neither of which produced a real ULID. `canonicalize` now also rejects circular references.
- `src/audrey.ts` constructor and `consolidate`/`decay` now use `??` for default fallbacks so an explicit `0` survives. The previous `||` short-circuit silently replaced valid zero-value config.
- `src/audrey.ts` `recallStream` now respects `options.agent` (was hardcoded to `this.agent`) and waits for embedding warmup like the non-streaming path.
- `src/confidence.ts` `recencyDecay` throws `RangeError` on `halfLifeDays <= 0` to surface NaN/Infinity earlier in the pipeline.
- `src/causal.ts` and `src/validate.ts` now validate the LLM response shape before reading fields. `causal` rejects non-finite confidence; `validate` rejects non-object/array conditions and only counts new evidence toward `supporting_count`.
- `src/rollback.ts` UPDATEs now check `.changes` and aggregate real counts. Rolling back ids that don't exist no longer reports false success.
- `src/rules-compiler.ts` `quoteString` now also escapes newline, carriage return, and tab so promoted rule content with multiline values produces valid double-quoted YAML.
- `src/decay.ts` and `src/forget.ts purgeMemories` moved their SELECTs inside the surrounding transaction so concurrent writers can't slip rows in or out between read and write.
- `src/migrate.ts` `reembedAll` chunks `embedBatch` calls into 256-row batches and labels failures by kind + row range. Pre-fix a partial embed failure on a 50K-episode reembed printed a bare provider error and lost the location. `EpisodeMigrateRow.consolidated` was also retyped to `number | null` to match runtime usage.
- `src/embedding.ts` `embedBatch` validates response shape with clear errors instead of mapping over a missing or malformed `data` field.
- `src/encode.ts` `effectiveSalience` clamped to `[0, 1]`. The previous formula could go negative on a sufficiently negative arousal boost.
- `src/affect.ts` `timeDeltaDays` no longer propagates NaN from invalid `created_at`.
- `src/capsule.ts` failure entry `memory_id` no longer interpolates `'undefined'` when `tool_name` is missing; recall spread order keeps `scope: 'agent'` from being overridden by caller options.
- `src/import.ts` `isDatabaseEmpty` now also checks `memory_events`. Pre-fix you could `restore` into a "fresh" store that already contained audit-trail rows.
- `src/server.ts` shutdown awaits `server.close` (was fire-and-forget) and surfaces `audrey.closeAsync` errors to stderr instead of silently swallowing them. `ERR_SERVER_NOT_RUNNING` is treated as success.
- `src/feedback.ts` replaced a `findRow(id)!.row` non-null assertion with a defensive null check; if the row was concurrently forgotten between UPDATE and re-read, returns the values just written rather than crashing.
- `src/promote.ts` folded `trigger_conditions` into the main SELECT (was an N+1).

### Security

- `src/routes.ts` API key auth uses padded-buffer constant-time comparison. The previous `provided.length !== expected.length || !timingSafeEqual(...)` shape leaked the expected key length via response timing on local untrusted callers. Both buffers are now padded to 1 KiB before `timingSafeEqual`, so the comparison runs identically regardless of header length.
- `src/redact.ts` raised the hex-secret length threshold from 40 to 80 chars so 40-character git SHAs and 64-character SHA-256 checksums are no longer redacted as secrets.
- The "Protect master" GitHub ruleset was updated to drop the stale `Node 18 on Ubuntu` required check (CI dropped Node 18 from the matrix in 0.22.1 to match `engines.node >=20`, but the protection rule kept requiring a check that would never run).

### Added — closed-loop visibility on REST and Python

- New `GET /v1/impact` route that mirrors `Audrey.impact()` and the `audrey impact` CLI. Bounds `windowDays` to 1-365 and `limit` to 1-100.
- Python sync and async clients gained an `impact(window_days=, limit=)` method. The previous `analytics()` no longer raises `NotImplementedError`; it's an alias of `impact()` for older callers.
- Python integration tests are no longer skipped. The suite spins up the real TS REST sidecar via `node dist/mcp-server/index.js serve` and exercises encode → recall → mark_used → impact → snapshot → restore end-to-end.

### Benchmarks — legitimate performance snapshot, no marketing graphs

- New `npm run bench:perf-snapshot` (`benchmarks/perf-snapshot.js`) reports encode and hybrid-recall p50/p95/p99 across multiple corpus sizes (default 100, 1000, 5000) with full machine provenance (Node version, CPU model, RAM, git SHA) so the numbers are reproducible.
- Removed the synthetic-baseline SVG charts (`docs/assets/benchmarks/local-benchmark.svg`, `operations-benchmark.svg`, `published-memory-standards.svg`) from the repo and from the npm package's `files` field. They claimed Audrey beat naive baselines on 12 hand-crafted scenarios, which is not a useful marketing signal. The behavioral regression suite (`npm run bench:memory:check`) still runs as a release gate; it just no longer ships chart artifacts to the README.
- Removed the `bench:memory:readme-assets` script (it generated the SVGs above).
- README's Benchmarks section rewritten around the perf snapshot with explicit caveats about embedding-provider cost and what the numbers do and don't cover.

### Fixed

- `mcp-server/index.ts` help banner: `memory_validate` was already registered but was missing from the in-session tool list.
- `CHANGELOG.md` 0.22.1 contradicted itself by stating `mark_used()` was both upgraded to a real call and still raises `NotImplementedError`. Removed the stale duplicate.

### Personal-data cleanup

- `tests/http-api.test.js` no longer references "Tyler" — replaced with generic test fixtures so the public test suite has no personal identifiers.

## 0.22.1 - 2026-04-30

### Added — `audrey impact` report

- New `audrey impact` CLI command (also `--json` for automation, `--window N` for the lookback window in days, `--limit N` for how many rows in each list).
- Shows: total memories by type, all-time validated count, recent validations, top-N most-used memories, weakest-N (lowest salience — candidates to forget), and recent activity timeline.
- Backed by `src/impact.ts` (`buildImpactReport`, `formatImpactReport`) and `Audrey.impact({ windowDays, limit })`.
- This is the marketing surface the adversary called for: vital signs over CI verdicts. As agents start calling `memory_validate`, the report accumulates the "X failures prevented this week, Y procedures auto-promoted" story.

### Added — closed-loop feedback (the "memory before action" wedge)

- New `memory_validate(id, outcome)` MCP tool. `outcome` is one of:
  - `"helpful"` — the recalled memory drove a correct action. Reinforces salience and bumps `retrieval_count` for semantic/procedural rows.
  - `"wrong"` — the memory was misleading. Decreases salience and bumps `challenge_count` for semantic memories.
  - `"used"` — neutral signal that the memory was referenced (smaller salience delta than `helpful`).
- New REST endpoints `POST /v1/validate` (canonical) and `POST /v1/mark-used` (legacy alias defaulting to `outcome=used`).
- New `Audrey.validate({ id, outcome })` SDK method emits a `'validate'` event so consumers can audit feedback flow.
- New `src/feedback.ts` module with the `applyFeedback()` primitive — kept out of `audrey.ts` per architecture review (god-class concern).
- Python client `mark_used()` is no longer a `NotImplementedError`; calls `/v1/mark-used`. New `validate(memory_id, outcome="used"|"helpful"|"wrong")` method on both sync and async clients.
- 10 new tests (6 SDK math, 1 MCP enum, 3 HTTP roundtrip including 404 path).

This is the P0#1 item from `docs/PRODUCTION_BACKLOG.md` — the closed feedback loop that lifts the autopilot rubric's ALIVE dimension from 4 to 7+. The math reuses the existing `confidence.ts` reinforcement formula; the new column work is a no-op (`usage_count` and `last_used_at` were already added by migration 10 in v0.21).

### Security

- HTTP `/v1/recall` and `/v1/capsule` no longer body-spread caller options into `audrey.recall()`. Pre-fix, `includePrivate: true` and `confidenceConfig` overrides could be passed in HTTP bodies, bypassing the private-memory ACL and integrity controls. The new `sanitizeRecallOptions()` allowlist drops anything not in a known-safe key set.
- `audrey serve` defaults to binding `127.0.0.1` (was `0.0.0.0`). Refuses to start on a non-loopback host without `AUDREY_API_KEY` unless `AUDREY_ALLOW_NO_AUTH=1`. New `AUDREY_HOST` env var explicitly opts in to network exposure.
- HTTP API key comparison uses `crypto.timingSafeEqual` instead of string `!==` to avoid prefix-match timing leaks on local untrusted callers.
- `audrey promote --yes` refuses to write `.claude/rules/*.md` outside `process.cwd()` unless the target path is in `AUDREY_PROMOTE_ROOTS`. Prevents a malicious MCP caller from writing persistent prompt-injection files into the user's `~/.claude/` directory.

### First-contact UX

- `audrey --help`, `audrey --version`, and `audrey help`/`audrey version` now print help/version and exit 0 instead of silently dropping into the MCP stdio server. Unknown subcommands print error + help and exit 2.
- ONNX runtime EP-assignment warnings ("Some nodes were not assigned to the preferred execution providers...") are suppressed by default via per-session `logSeverityLevel`. Set `AUDREY_ONNX_VERBOSE=1` to restore the original behavior.
- `[audrey-mcp]` info boot logs (server started, connected via stdio, warmup completed) are gated behind `AUDREY_DEBUG=1`. Warmup-failure errors continue to log unconditionally.

### Reliability

- `audrey.close()` now warns to stderr when called with pending post-encode consolidation work. New `audrey.closeAsync()` awaits `drainPostEncodeQueue()` before closing the database. All CLI subcommands (`reembed`, `dream`, `greeting`, `reflect`, `demo`, `observe-tool`, `promote`) use `closeAsync` to prevent the silent-data-loss race introduced in v0.22.0 where post-encode validation/interference could hit a closed DB.
- `_emitQueueError` reverted to the standard EventEmitter idiom: emit `error` when a listener is attached, fall back to `console.error` otherwise. v0.22.0 always called `console.error` and produced duplicate stderr lines for apps with structured error pipelines.
- `encodeBatch` now reuses the encode vector across post-encode stages and routes through `_enqueuePostEncode` (matching `encode`). Pre-fix, batch callers paid 4× embed cost per item and silently bypassed interference/resonance — a behavior divergence from single-encode that the v0.22.0 perf pass missed.

### Performance

- SQLite PRAGMA tuning at db creation: `synchronous=NORMAL` (durable under WAL), 64 MiB page cache, 256 MiB mmap, `temp_store=MEMORY`. Set `AUDREY_PRAGMA_DEFAULTS=0` to revert to better-sqlite3 defaults. Expected impact: 2-5× recall p95 at &gt;10K episodes; 30-50% improvement on encode under sustained load.

### Dependencies

- `sqlite-vec`: `0.1.7-alpha.2` → `0.1.9` (alpha to stable; the prior pin was 15 months old).
- `@modelcontextprotocol/sdk`: `1.26.0` → `1.29.0` (stricter schema validation, transport stability).
- `zod` `4.3.6` → `4.4.1`, `better-sqlite3` `12.6.2` → `12.9.0`, `hono` `4.12.14` → `4.12.15`, `@hono/node-server` `1.19.13` → `1.19.14`, `vitest` `4.0.18` → `4.1.5`, `typescript` `6.0.2` → `6.0.3`.
- `npm audit`: 0 vulnerabilities (production); transitive postcss CVE in vitest's vite resolved via `npm audit fix`.

### SDK contract fixes (Python ↔ TS server)

- Python client `DEFAULT_BASE_URL` corrected from `http://127.0.0.1:3487` to `http://127.0.0.1:7437` to match the TS server's default port. Pre-fix, calling `Audrey()` with no args connected to nothing.
- Python `recall()` and `recall_response()` now decode the bare-list payload that `/v1/recall` actually returns, then wrap into `RecallResponse` client-side. Pre-fix, `recall_response()` would raise a Pydantic validation error against the real server.
- Python `restore()` now wraps the snapshot in `{"snapshot": ...}` to match the TS `/v1/import` handler that reads `body.snapshot`. Pre-fix, the server received `body.snapshot === undefined` and `audrey.import(undefined)` failed.
- Python `analytics()` raises `NotImplementedError` with a pointer to `docs/PRODUCTION_BACKLOG.md` until the analytics endpoint ships. Pre-fix, it produced a cryptic 404 from the TS sidecar that doesn't expose that endpoint. (Note: `mark_used()` was upgraded to a real call against `/v1/mark-used` in this same release — see the closed-loop section above.)
- README REST API row no longer claims `/openapi.json` or `/docs` — those routes aren't currently wired. The README now matches the actual surface (`/health` + `/v1/*`).

### Removed

- `hybrid_strict` retrieval mode (was a silent alias of `hybrid` with no behavioral difference). Use `hybrid` (default) or `vector`.

### Internal

- New `closeAsync(timeoutMs?: number)` on `Audrey`.
- New `sanitizeRecallOptions()` allowlist helper in `src/routes.ts`.
- `startServer` returns `hostname` alongside `port`.
- 5 new tests: CLI surface (`--help`/`--version`/unknown), HTTP recall sanitizer (privacy ACL, integrity, retrieval enum), HTTP bind safety (no-auth on LAN refused, `AUDREY_ALLOW_NO_AUTH` override).

## 0.22.0 - 2026-04-28

### Performance

- Encode response time: 24.7ms to 15.2ms p50, about 40% faster.
- Cold-start first encode: 525ms to 28ms with warmup, about 18.7x faster.
- Hybrid recall: 30.2ms to 14.3ms p50, about 2.1x faster.
- Eliminated 3 of 4 redundant embedding calls during encode. Validation, interference, and affect resonance now reuse the main content vector.

### Added

- Added `memory_encode.wait_for_consolidation` parameter, default `false`, for opt-in read-after-write semantics.
- Added `memory_recall.retrieval` parameter with `"hybrid"` default and `"vector"` (FTS-bypass fast path).
- Added `pending_consolidation_count`, `embedding_warm`, `warmup_duration_ms`, and `default_retrieval_mode` to `memory_status`.
- Added background embedding pipeline warmup after MCP `server.connect()`.
- Added `AUDREY_PROFILE=1` for per-stage timings in MCP `_meta.diagnostics`.
- Added `AUDREY_DISABLE_WARMUP=1` to opt out of background embedding warmup.
- Added `benchmarks/perf.bench.js` and `npm run bench:perf` as a mock-embedding CI perf gate.

### Changed

- Moved post-encode validation, interference, and affect resonance onto a serialized async queue so `memory_encode` no longer blocks on downstream consolidation work by default.
- Folded recall's three healthy-store vec-table count queries into one SQL roundtrip before KNN.
- Process shutdown now drains the post-encode consolidation queue with a 5-second timeout and logs pending row IDs if work remains.

### Internal

- Added `src/profile.ts` with `ProfileRecorder`.
- Added `encodeWithDiagnostics()` and `recallWithDiagnostics()` for MCP profiling-mode response metadata.

## 0.21.0 - Release Diagnostics and Host Setup

- Added `npx audrey doctor` for first-contact diagnostics, JSON automation, provider checks, MCP entrypoint validation, memory-store health, and host config generation.
- Added `npx audrey install --host <host> --dry-run` so Codex, Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, JetBrains, and generic MCP hosts can preview setup without accidental config writes.
- Updated docs around the recommended first run: `doctor`, `demo`, safe host install preview, then host-specific verification.
- Kept Claude Code's direct installer intact while making the default release story host-neutral.
- Refreshed lockfile transitive packages through the npm resolver; vulnerability audit remains clean.

## 0.20.0 - Memory Reflexes

- Added Memory Preflight and Memory Reflexes so agents can check memory before acting and turn repeated failures into trigger-response guidance.
- Added Ollama/local-agent guidance and runnable local-agent example.
- Expanded host-neutral MCP docs and Audrey for Dummies onboarding.
