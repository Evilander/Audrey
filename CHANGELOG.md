# Changelog

## 1.2.0 - 2026-08-21

### Grounding — memories are checked against the project, not just aged

Confidence has always answered whether a memory is recent, well-sourced, and
uncontradicted. Nothing answered whether it is still true. A procedure that
says to deploy with `npm run deploy:prod` kept full confidence after that
script was deleted, and every recall raised it further, because retrieval
counts as reinforcement. Stale memory is worse than absent memory: Guard
states it with evidence attached, so the agent follows it into a wall.

- When a memory is written, Audrey records the checkable claims in it — repository-relative paths and package script names — but only the ones that resolve at that moment. A claim that never resolved is a guess about someone's typo; a claim that resolved once and no longer does is the world having changed underneath a memory that still asserts it. Only the second kind is stored, which is what makes a later break worth reporting.
- Anchors are re-checked during the maintenance sweep, on `audrey dream`, on demand via `audrey ground`, and through the `memory_ground` MCP tool. A path or script that comes back clears the broken state, so a reverted delete or a branch switch does not permanently discredit a memory.
- A broken memory keeps its content and its place in the store. Recall labels it, states plainly what it still refers to, and applies a 0.5 confidence multiplier so it stops leading by default while staying readable and repairable.
- A broken memory can no longer escalate into the capsule's `must_follow` section. That section is the one that can force a strict-mode Guard block, and a rule naming a file that no longer exists is a rule nobody can follow; such memories surface under `uncertain_or_disputed` instead.
- Unanchored memories are left unlabelled. Absence of anchors is not a clean bill of health, and presenting it as one would be the same mistake in the other direction.
- A project that cannot be read — a moved checkout, a missing drive — reports unknown rather than broken. Memories are never discredited because the machine changed.

### Memory privacy

- `memory_encode`, `POST /v1/encode`, and `Audrey.encode` now redact content, context values, and affect labels before anything reaches the episodes table, the full-text index, or the embedding model. Previously only tool-trace capture was redacted; a secret pasted into an explicit "remember this" call was stored in plaintext. The MCP tool result now echoes the stored (redacted) content plus a redaction summary instead of reflecting the caller's raw input, and batch encodes embed the redacted text rather than the original.
- A dedicated redaction rule catches multi-word passphrases and BIP39-style mnemonics (eight or more space- or hyphen-joined lowercase words). The previous identifier exemption treated exactly that shape as a machine identifier and let it through.
- `redactJson` handles a literal `__proto__` key as ordinary data: the nested value is redacted and preserved instead of silently vanishing through the prototype setter.
- A filesystem-path shape raises the entropy bar for the high-entropy secret rule instead of exempting the value outright. Long mixed-case paths can cross the plain entropy gate, which mangled stored `cwd` metadata and silently broke Guard project scoping; a blanket exemption fixed that but opened a wider hole, because AWS secret access keys draw from an alphabet containing `/` and roughly one in seventeen lands in a path-like shape by chance. Measured against 20,000 generated keys: 5.78% stored verbatim before, 0.02% after, with every path in a corpus of absolute, relative, temp-directory and toolchain paths still preserved intact.
- Sensitive key detection matches the sensitive word anywhere in a compound key rather than only as its suffix. `aws_secret_access_key` and `stripe_secret_key` matched nothing before, which also stopped `redactJson`'s sensitive-ancestor fallback from covering their values — so both redaction layers missed the field name credentials actually ship under. Plural collection fields such as `tokens` stay unmatched.
- `memory_import` and `POST /v1/import` redact content, context, and affect before anything is stored or embedded, and strip the reserved trust marker the same way every other ingestion boundary does. Import previously did neither, so a snapshot could carry secrets into storage verbatim and grant itself verified control-memory trust — the one path that bypassed both of this release's security additions. Imported timestamps must now parse as real dates.
- `memory_export` escapes markup in its response. It was the one tool returning stored memory content without the anti-injection escaping its siblings apply.
- Memories marked `private` are excluded from the episode content sent to a configured cloud LLM during consolidation. They still consolidate through the local heuristic path.
- The first cloud LLM completion in a process prints a one-time stderr notice naming the provider and endpoint before any memory content leaves the machine.

### Guard trust and provenance

- A must-follow memory only escalates to a high-severity directive (capable of forcing a strict-mode block) when its source is `direct-observation` or `told-by-user` **and** its context carries the `audrey_trust: user-verified` marker, which only Autopilot's genuine user-prompt capture can set — MCP, HTTP, and CLI encode boundaries strip it from caller-supplied context. Previously any caller could self-report a trusted source and plant a durable directive into every future Guard decision. Trusted-source memories created before this release are grandfathered at medium severity: still surfaced, never alone sufficient to force a strict block.
- `Audrey.afterAction` accepts `overrideReason` for recording a succeeded outcome against a receipt that was blocked for a policy reason rather than an exact repeated failure. The reason is written into the event metadata as durable evidence. Exact-repeat-failure blocks still cannot be recorded as succeeded this way; they require a fresh acknowledged `beforeAction`. Exact-repeat detection now applies uniformly across the library API, MCP tools, HTTP routes, and CLI, which previously enforced different subsets of these checks.
- Generated hooks now guard `MultiEdit` and every `mcp__*` tool from connected MCP servers, excluding Audrey's own memory tools so Guard preflight does not recursively fire on `memory_recall` and its siblings.
- Preflight reuses the failure analysis its capsule already computed instead of scanning `memory_events` a second time, and its tagged must-follow sweep only runs when a must-follow tag exists anywhere in the store.
- A failure in that tagged must-follow sweep now surfaces as a high-severity memory-health warning. It was swallowed, so the sweep that exists precisely to catch a control directive the capsule ranked too low could drop it and say nothing.
- `memory_recall` strips the reserved trust marker from caller-supplied context, matching `POST /v1/recall`. Query-side context feeds match scoring and is never persisted, so this closes no exploit on its own; it keeps the rule "the marker does not cross an external boundary in either direction" true of every boundary rather than resting on a per-handler judgement.
- The `memory_encode` response falls back to redacted content when re-reading the stored row fails, instead of echoing the caller's raw input. The fallback was the one path that could return a secret the storage boundary had just scrubbed.

### Performance

- `recentFailures()` replaced three correlated per-row subqueries with a single materialized window-function pass backed by a new composite index on `(tool_name, outcome, created_at, actor_agent)`. Measured before the fix: about 199 ms per call at 10,000 `memory_events` rows and about 24 s at 100,000 rows — inside a Guard check whose hook timeout is 30 s. Measured after (`npm run bench:scale`, 50,000 events): 22 ms p95. This query runs on every prompt and every guarded tool call.
- Database open no longer re-scans episodes, semantics, and procedures for unsynced embeddings on every hook process. A persisted per-table high-water mark plus partial indexes reduce a steady-state open to one `MAX(id)` comparison per table. The mark is keyed on memory id rather than rowid: SQLite hands out `max(rowid)+1`, so deleting the row holding the current maximum makes the next insert reuse that rowid, and a rowid mark then reads the new row as already synced and drops it from its vector table permanently. Memory ids are ULIDs, which a delete never recycles. Schema migrates to v15; each migration commits atomically with its version bump.
- Consolidation's near-duplicate merge lookup uses the vec0 index instead of computing a cosine distance against every active memory for the agent. That scan ran once per extracted principle inside the consolidation write transaction, holding SQLite's write lock against concurrent Guard hooks. Measured: 2.2 ms at 500 active semantics and 176 ms at 30,000 before, 0.08 ms and 6.1 ms after. `benchmarks/scale.bench.js` now gates this path, which it seeded but never measured.
- Guard's must-follow existence probe is backed by a partial index. The leading-wildcard `LIKE` scanned the whole episodes table on the hottest path in the system; measured at 50,000 episodes with no match, 3.54 ms before and 0.003 ms after.
- `memory_events` has retention: Autopilot maintenance prunes events older than 90 days by default (`deleteEventsBefore` batches deletes and reports the count). The table previously grew without bound for the life of an install.
- `benchmarks/scale.bench.js` seeds tens of thousands of rows and asserts p95 budgets for the hook hot path (`recentFailures`, capsule build, preflight, cold reopen), which the 20-row benchmark that previously gated releases could not catch.

### Recall quality

- Hybrid recall normalizes the FTS signal onto the same scale as the vector score before weighting. The previous fusion mixed a raw 0–1 vector score against reciprocal-rank terms two orders of magnitude smaller, so the nominal 0.7 FTS weight contributed at most ~0.023 and exact keyword or identifier matches almost always lost to loosely similar vector hits.
- Confidence rewards independent corroboration: `source_type_diversity`, already tracked and reinforced on every semantic memory, now feeds a bounded bonus in the confidence formula. Two identically-supported memories are no longer scored the same when one is backed by three independent source types and the other by three copies of the same source.
- Consolidation checks new principles against existing active memories and merges near-duplicates (evidence union, reinforcement bookkeeping) instead of minting a redundant semantic or procedure on every dream cycle; recall's duplicate suppression also breaks equal-reliability ties deterministically for near-identical content instead of letting both duplicates through.
- Capsules accept `excludeIds`, and Autopilot passes the session's already-injected set, so exclusion happens before the character budget is spent and later capsules surface next-ranked unseen memories instead of going quiet while re-fetching content the session has already seen.

### Dependencies

- Took the available production dependency fixes: `hono` 4.12 to 4.13 (cross-user data disclosure through retained SSR output, CORS ReDoS, `Connection` header handling), `@hono/node-server` 1.19.14 to 1.19.17 (path traversal via encoded backslash on Windows), plus `body-parser`, `fast-uri`, and `tar`. All are within the declared ranges; no major versions moved.
- Two high-severity `sharp` advisories remain, reached through `@huggingface/transformers`, which declares a range with no patched release. Audrey never imports `sharp`, so a text-only embedding pipeline does not execute it, but it is installed and the advisory is real. Recorded in the README production checklist rather than suppressed.

### Autopilot

- Worktree checkouts resolve to their repository's common root, so all worktrees of one repo share a memory namespace instead of fragmenting must-follow rules and failure history per checkout. A drive-qualified pointer (`C:/repo/.git/worktrees/...`) read on a POSIX host is treated as absolute rather than joined onto the worktree directory, so it fails by not existing instead of silently resolving to a path that never did.
- The Python client accepts an affect without `valence`, matching the TypeScript type and the MCP schemas, which both made it optional. Python was rejecting payloads the server accepts.
- Only the `global-preference` tag crosses project boundaries. Generic `preference`-class tags no longer leak project-local memories into every other project's packets.
- Hook processes derive their internal embedding and LLM timeouts from the invoked event's declared host timeout, leaving margin to exit cleanly instead of being killed mid-write by the host.

### Diagnostics

- `audrey doctor` inspects Claude Code hook installs (present handlers, unparseable runtime, missing node/entrypoint paths) with the same depth previously applied only to Codex, and warns when an installed hook entrypoint's version differs from the running CLI — the two known causes of memory packets silently stopping.
- Hook failures append to a small rotating log under the data directory, independent of the SQLite store, and doctor surfaces the recent failure history. Previously a hook crash left no trace beyond that process's stderr.
- The MCP tools that return stored memory content directly (`memory_recall`, `memory_capsule`, `memory_greeting`, `memory_guard_before`, `memory_preflight`, `memory_reflexes`) apply the same evidence-not-authority framing and markup escaping as the auto-injected packet, and `memory_recall` no longer silently drops the `partial_failure` degradation signal its HTTP counterpart already reported.

### HTTP surface

- `POST /v1/encode` strips the reserved trust-context marker from caller-supplied `context` before it reaches storage, and `POST /v1/recall` does the same for its `context` match parameter (including the nested `recall.context` that `POST /v1/capsule` forwards to it), so an HTTP caller can no longer self-certify a memory or query as genuine user-stated direction.
- Adds `POST /v1/promote`, gated behind `AUDREY_ENABLE_ADMIN_TOOLS=1` like `/v1/export`, `/v1/import`, and `/v1/forget`. It mirrors the `memory_promote` MCP tool and CLI command.
- `POST /v1/guard/after` validates `outcome` against the real enum (`succeeded`, `failed`, `blocked`, `skipped`, `unknown`) instead of a bare type assertion, returning 400 with a specific message on an invalid value instead of a raw SQLite constraint error.
- `POST /v1/guard/after` accepts `override_reason` / `overrideReason`, plumbed through to `Audrey.afterAction` for recording a succeeded outcome against a Guard receipt that was blocked for a reason other than an exact repeated failure.
- Every route now honors a per-call `agent` in the request body as a fallback when the `X-Audrey-Agent` header is absent. This makes the Python client's per-call `agent` keyword argument actually take effect; previously it was silently ignored because every route resolved the acting agent from the header only. The header still wins when both are present.

### Provider configuration

- Cloud embedding and LLM providers are never auto-selected from an ambient `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Leaving `AUDREY_EMBEDDING_PROVIDER` or `AUDREY_LLM_PROVIDER` unset (or `auto`) uses local embeddings and local heuristic reflection; a cloud provider requires explicitly setting the variable, and doing so without the matching API key now fails loudly instead of running unconfigured.

### Repository hygiene and packaging

- `docs/PRODUCTION_BACKLOG.md` was tracked in git and listed in `package.json`'s `files` array, so an internal P0/P1/P2 backlog, pricing notes, and launch-postmortem detail shipped in every `npm install audrey` tarball. It has been removed from git tracking and from `files`; the content is preserved locally, outside the repo. `docs/AUDREY_PAPER_OUTLINE.md` is removed from `files` too — it is a pre-writing outline, not something a library consumer needs — but stays tracked in git because `scripts/create-paper-submission-bundle.mjs` reads it as a real build input.
- Trims the published npm package to what a consumer of the library or MCP server actually needs: `dist/`, `examples/`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, and `LICENSE`. Benchmarks, the compiled arXiv PDF, submission bundles, and other repo-only documentation no longer ship. Measured with `npm pack --dry-run`: 399 files / 965.3 kB packed / 4.0 MB unpacked before, 217 files / 332.7 kB packed / 1.5 MB unpacked after.
- Removes the `pretest` lifecycle hook that made every `npm test` silently run a full rebuild plus the entire benchmark and paper pipeline, including `paper:sync`, which unconditionally overwrote `README.md` and three files under `docs/paper/`. `npm test` is now just the Vitest run; `tests/setup/ensure-release-artifacts.js` already generates the fixtures those tests need. `npm run test:artifacts` remains available as an explicit script; its benchmark steps stay folded into `release:gate`, `release:gate:sandbox`, and `release:gate:paper`, and its paper steps (`paper:sync` onward) remain exclusive to `release:gate:paper`, same as before this change. `release:gate` now builds and runs the performance benchmark explicitly instead of relying on the removed hook to do it implicitly.

## 1.1.3 - 2026-07-13

### MCP Registry publishing fixes

- Corrects the registry namespace to `io.github.Evilander/audrey`: the registry's GitHub-derived publish permission and its npm `mcpName` ownership check are both case-sensitive exact matches against the GitHub login's display case, and the 1.1.2 tarball carried the lowercase form.
- Shortens the `server.json` description to the registry's 100-character limit.
- The registry publish job is re-runnable via a `publish_mcp` workflow dispatch input without republishing npm or PyPI, using the dispatched ref's metadata while stamping the version validated against the release tag.

## 1.1.2 - 2026-07-13

### Guard signal quality

- Consolidation now sweeps every real owning agent instead of the CLI utility agent, so `audrey dream` and reflection actually convert episodes into semantic and procedural knowledge on stores that previously reported "evaluated 0 episodes".
- Failure streaks are self-extinguishing: `failure_count` counts failures since the tool's last success in scope, and a subsequent success retires the warning instead of letting it nag at high confidence for the full window. Same-instant ties order by monotonic event id and fail toward warning. `include_resolved` preserves the raw diagnostic view.
- Tool-failure signals are project-scoped: `memory_recent_failures`, `memory_capsule`, and preflight accept a `cwd` and exclude failures recorded in other projects. Directionality is asymmetric on purpose — failures without a recorded directory stay visible because they cannot be proven foreign, while only a success provably from the current project can extinguish a local streak. Autopilot passes the working directory even under shared scope, so cross-project semantic knowledge still travels while foreign failure noise does not.
- Autopilot-learned tool-failure episodes (tool-result source) now categorize as risks, are tool-matched at medium severity in preflight, and cap their error summaries in capsules at 240 characters. User-authored memories that carry the same tag keep full high-severity risk treatment.
- Redaction no longer destroys machine identifiers such as MCP tool names: consistently-cased word identifiers (three or more separator-delimited all-lowercase or all-uppercase segments) are exempt from the high-entropy secret rule. Title-cased memorable passphrases and digit-bearing tokens still redact.

### Injection efficiency

- Compact packet format (default; `AUDREY_PACKET_FORMAT=verbose` reverts): entries render as `[memory_id confidence] "content"` lines with a one-line safety preamble. Content stays JSON-quoted; injection-safety invariants are unchanged.
- Session-delta injection (default; `AUDREY_PACKET_DELTA=0` reverts): each memory is injected once per session instead of on every prompt. SessionStart delivers the full packet and seeds the tracker; the tracker clears on session start and compaction — the moments earlier packets can leave the context window. A memory whose state changes after injection (for example, becoming disputed) reinjects with its new standing. Measured on a production store this removed a repeated 3.5k-character packet from every prompt after the first.

### MCP Registry

- Publishes Audrey to the official MCP Registry as `io.github.evilander/audrey` via GitHub OIDC in the release pipeline, after the npm publish gates pass.

## 1.1.1 - 2026-07-10

### npm 12 install compatibility

- Documents and emits a least-privilege global install command that explicitly allows only Audrey's four required dependency lifecycle scripts. This keeps SQLite and local inference working under npm 12's new default-deny install-script policy without enabling arbitrary package scripts.
- Adds pinned project-level npm 12 approvals for Audrey's current native/runtime dependencies and regression coverage for the CLI guidance.
- Pins the trusted npm publisher to npm 11.14.1 so the immutable 1.1.0 tag can be recovered safely after npm 12 withheld `better-sqlite3`'s native binding during its first publish attempt.

## 1.1.0 - 2026-07-09

### Audrey Autopilot

- Adds one normalized lifecycle runtime for current Codex and Claude Code hooks. Session and prompt hooks inject bounded memory context; pre-tool hooks run exact-action Guard checks; post-tool hooks close the matching receipt by `session_id + tool_use_id`; explicitly reported failures form redacted durable memories; stop/compact hooks run due-only consolidation. Opaque Codex Bash results without exit status remain `unknown` rather than being mislabeled as success.
- Adds deterministic capture for explicit durable user language such as “remember that…”, “I prefer…”, and “from now on…”. Raw prompt events remain hash-only, secrets are rejected, and injected memory is redacted and labeled as evidence rather than authority.
- Adds host-specific, idempotent hook configuration for Codex and Claude Code with documented scopes, exact side-effectful tool matchers, timeouts, Windows-safe commands, legacy Audrey-hook replacement, private backups, dry runs, and owned-hook uninstall.
- `audrey install` now defaults to `--host auto`, configures installed Codex and/or Claude Code CLIs, installs Autopilot hooks, warms the pinned local runtime, and rolls MCP configuration back if registration fails. Scope validation happens before any host mutation, and MCP-only installs no longer claim Autopilot readiness. Uninstall has a non-mutating preview, understands Claude's project-keyed local registration, preserves hooks in MCP-only mode, and propagates real CLI failures instead of reporting false success. Codex still requires one-time trust through `/hooks`.

### Isolation and retrieval correctness

- Agent ownership now scopes validation, reinforcement, contradiction detection, interference, affective resonance, recent failures, capsules, greetings, preflight, Guard outcome actors, consolidation, and agent-routed REST calls inside a shared store.
- Cross-agent and legacy mixed-agent contradictions are excluded from scoped capsules. Explicit `scope: "shared"` remains available where cross-agent recall is intentional.
- Agent-scoped vector retrieval now uses native `sqlite-vec` partition keys before nearest-neighbor ranking, with a single bounded partition-local retry. Existing vector stores migrate losslessly and transactionally. Agent FTS no longer requests 10,000 candidates.
- Explicit cross-agent REST recall is disabled unless `AUDREY_ENABLE_SHARED_SCOPE=1` or admin routes are enabled; the agent-selection header remains routing metadata rather than an authentication boundary.
- Semantic and procedural retrieval bookkeeping now updates only final results actually yielded. Hidden, deduplicated, over-limit, and unconsumed stream candidates no longer gain authority merely because a query ran.

### Guard and provider compatibility

- Automatic tool outcomes inherit the Guard action fingerprint, so exact failed actions block, successful recovery clears stale failure behavior, and parallel tool calls retain correct lineage. Retrieval queries remain bounded for large prompts and writes while exact identity hashes the full normalized, redacted action rather than a truncated prefix.
- Adds `AUDREY_LLM_MODEL` plumbing to generated MCP environments.
- OpenAI chat completions use `max_completion_tokens` with reasoning headroom for GPT-5 and o-series models while retaining `max_tokens` for older chat models.
- Refreshes Hono and the affected `protobufjs`, `qs`, and `tar` dependency chain to patched releases; the production dependency audit is clean at the release cut.
- MCP server instructions describe the memory capsule and Guard receipt loop for hosts where lifecycle hooks are unavailable.

### Documentation

- Rewrites the README as a human-first product landing page, moves implementation detail into a technical reference, documents honest install/trust boundaries, and states current production limitations explicitly.
- Updates the supported security release lines for 1.x.

## 1.0.3 - 2026-05-28

Housekeeping release. Nothing about how Audrey behaves has changed — this is
all under-the-hood tidying plus a friendlier README. Safe to upgrade from 1.0.2
without touching anything.

### Cleaner code under the hood

- Started breaking up the big `mcp-server/index.ts` file (it had grown to ~3,600
  lines that did everything at once). The memory-tool input schemas and the
  shared validation helpers now live in their own small files
  (`tool-schemas.ts`, `tool-validation.ts`). Same behavior, just easier to read
  and work on. More of this tidying will follow.

### More reliable tests

- The test suite used to need a slow, multi-step "build all the benchmark and
  paper files first" step before it could run. It now sets those up
  automatically, so `npm test` (or a plain `vitest run`) just works from a fresh
  checkout. 785 tests pass with nothing extra to remember.

### Friendlier docs

- The README now opens with a short "In Plain English" section that explains
  what Audrey is for in everyday language, before diving into the technical
  detail.

## 1.0.2 - 2026-05-28

Maintenance and engineering-quality release. No runtime behavior change — the
full test suite is unchanged from 1.0.1.

### Security

- Pin transitive `qs` to `^6.15.2` via `overrides` to resolve
  [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26)
  (moderate denial-of-service in `qs.stringify`), which reaches `audrey` through
  `@modelcontextprotocol/sdk → express@5`. The advisory was published after the
  1.0.1 cut; production `npm audit --omit=dev --audit-level=moderate` is clean
  again.

### Tooling and code quality

- Add flat-config ESLint with type-checked `typescript-eslint` rules over `src/`
  and `mcp-server/`, plus Prettier and `.editorconfig` matched to the existing
  house style. New scripts: `lint`, `lint:fix`, `format`, `format:check`.
- Wire `lint` and `format:check` into CI (Ubuntu matrix + Windows) and the
  `release:gate`, `release:gate:sandbox`, and `release:gate:paper` gates so the
  enforced baseline cannot regress.
- Resolve every lint finding at the source rather than by suppression: the REST
  handlers now decode request bodies through a typed `RouteBody` contract
  instead of Hono's default `any`; the three MCP `server` parameters and the
  local embedding pipeline are typed structurally; rethrows attach an error
  `cause`; and dead imports/bindings were removed across the tree.
- One-time Prettier normalization across the codebase, recorded in
  `.git-blame-ignore-revs` so `git blame` stays meaningful.

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
