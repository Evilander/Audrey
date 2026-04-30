# Audrey Production Backlog (post 0.22.1 autopilot)

Generated: 2026-04-30 by /superskills:production-autopilot pass.
Source agents: ultrareview (10 reviewers), security-sentinel, bug-hunter,
performance-oracle, architecture-strategist, adversary, plus 4 research
agents (arXiv/HF, competitive, deps, user research). Strategic frame
contributed by Tyler in-session (the "memory before action" wedge).

## The wedge (Tyler's harder framing, 2026-04-30)

Audrey's real shot is not "another AI memory framework." That category is
crowded, benchmark-dominated, and increasingly backed by teams with cloud
products, papers, plugins, connectors, and serious distribution.

Audrey's real shot is sharper:

> **Audrey is the local-first memory firewall and reflex layer for agents
> before they touch tools.** Memory before action.

That framing is commercially legible in a way "memory control plane" isn't.
A coding agent that forgets your repo setup is annoying. An agent that
repeats a destructive command, retries a broken deployment path, leaks a
secret into memory, or ignores a known customer workflow is **expensive.**
Audrey should own that pain.

What this means for the roadmap:

1. **Stop fighting head-on for "best generic memory."** Don't chase mem0's
   LongMemEval leaderboard climb, Cognee's connector breadth, or
   Supermemory's multimodal extractors. Those are arms races Audrey loses.
2. **Lean into preflight + reflexes + tool-trace as the product.** The
   repo already has all three (`/v1/preflight`, `/v1/reflexes`,
   `/v1/encode` with redacted tool-trace). They're currently positioned as
   features. They should be the headline.
3. **The killer demo is not "Audrey remembers your favorite color."** It's
   "Codex is about to run a command that previously broke this repo. Audrey
   catches it, explains why, shows the evidence, and suggests the safe
   path." Even better: "Audrey catches the error once, learns the rule,
   writes a Memory Capsule, converts it into a reflex, and later promotes
   the lesson into a project rule." That's the loop that gets retweeted.
4. **First market: developers and small technical teams running multiple
   agents locally.** Not enterprise governance. Not consumer. Not
   regulated industries first. The audience that already feels the pain —
   Claude Code + Codex + Cursor + Ollama users who hate re-explaining repo
   quirks and watching their agents repeat failed commands.
5. **Pricing math (devtool norms):**
   - 2,000 developers × $49/mo = ~$1.18M ARR
   - 1,000 small teams × $99/mo = ~$1.19M ARR
   - 200 serious teams × $500/mo = ~$1.20M ARR
   The hard part is making Audrey trusted enough that teams *depend* on it.
6. **OSS keeps the trust. Paid tier ships:** dashboard, memory diff/rollback,
   policy editor, team scopes, audit log, encrypted stores, benchmark runner,
   hosted relay for remote agents, signed memory passport bundles, CI gates,
   integrations + support.

## What this autopilot already shipped against the wedge

- Closed 2 critical + 4 high security findings (privacy-ACL leak, LAN bind,
  timing-safe auth, promote project_dir guard, doctor serve-bind-safety).
  Audrey can't be a "firewall" if its own surface leaks.
- Fixed 4 SDK contract drift bugs (Python URL default `3487`→`7437`,
  `/v1/recall` array shape, `/v1/import` snapshot-wrap, removed false
  README claim about `/openapi.json` and `/docs`). Tyler's harder
  assessment called these out by name as "the kind of thing that kills
  trust in an SDK. Fix this before chasing more architecture." Done.
- First-contact UX cleanup (help/version, ONNX silence, boot-log gating)
  removed the #1 evaluator-bounce trigger.
- close-on-pending-work race fixed (data integrity for the firewall
  promise; can't market "checks before tools act" if encode→close drops
  consolidation work).

This is the work that did **not** ship in the 0.22.1 release because it
was outside the 2-hour autopilot window. Items are scoped, prioritized,
and traceable back to the agent that surfaced them.

## P0 — required to clear the autopilot rubric (ALIVE 4 → 7+, MONEY 3 → 7+, ORIGINAL 7 → 9)

### 1. Closed feedback loop: `memory_validate(id, outcome)` + retrieval reinforcement ✅ **SHIPPED in 0.22.1**
- **Source**: adversary review (5/5 dimensions point at this)
- **Why it was the wedge**: Audrey stored and decayed but didn't learn from being used. The math already lived in `src/confidence.ts`; the missing piece was a feedback channel that closed the loop.
- **What shipped (commit on `autopilot/v0.22.x-production-pass`)**:
  - New `src/feedback.ts` module with `applyFeedback()` primitive (kept out of `audrey.ts` per architecture review).
  - `Audrey.validate({ id, outcome })` SDK method emits `'validate'` event.
  - MCP tool `memory_validate(id, outcome: 'used' | 'helpful' | 'wrong')`.
  - REST endpoints `POST /v1/validate` (canonical) and `POST /v1/mark-used` (legacy alias).
  - Python client `validate()` + re-wired `mark_used()` (no longer `NotImplementedError`).
  - 10 new tests (6 SDK math, 1 MCP enum, 3 HTTP including 404 path).
- **Still to do (deferred)**:
  - 90-second demo screencast: clean SQLite, 7 days of agent work, day-7 `audrey impact` output. This is the clip that gets retweeted.
  - Wire `memory_validate` into Claude Code / Codex hook integrations so agents auto-validate by default.
  - Per-event audit log in `memory_events` (so `audrey impact` can show 'helpful vs wrong' breakdown over a window — currently only cumulative state is queryable).

### 1a. `audrey impact` CLI ✅ **SHIPPED in 0.22.1**
- Visible surface for the closed-loop math. `npx audrey impact` (or `--json`).
- Reports: totals by type, all-time validated, recent validations (configurable window), top-N most-used, weakest-N by salience, recent activity timeline.
- New `src/impact.ts` (`buildImpactReport`, `formatImpactReport`), `Audrey.impact()` SDK method, 3 new tests.
- Adversary's #2 hit-list ("doctor outputs CI verdict where it should output vital signs") — closing this gap.

### 2. Publish benchmark numbers (LongMemEval / LoCoMo / MemoryAgentBench)
- **Source**: arXiv research (#3) + competitive analysis (#1) + architecture review (P0)
- **Why it's the wedge**: mem0 has 54k stars largely because it published 91.6 LoCoMo / 93.4 LongMemEval and open-sourced the eval harness. Audrey has zero published numbers. Without these, every architectural advantage in this repo is invisible to evaluators.
- **Concrete shape**:
  - `benchmarks/longmemeval-runner.ts`, `locomo-runner.ts`, `memory-agent-bench-runner.ts`.
  - CI nightly job pushes results to `benchmarks/results/`.
  - README hero adds the numbers.
  - Specifically target MemoryAgentBench's *conflict resolution* and *causality* tracks where Audrey's `memory_resolve_truth` + `causal.ts` should win outright.
- **Effort**: 1 week (single dev focused).

### 3. Memory Controller Layer as v0.23 chassis
- **Source**: architecture review (the single most important architectural decision)
- **Why now**: Tyler's roadmap names a Memory Controller Layer as the v0.23 backbone. Every other roadmap item (typed hierarchy, utility-aware retrieval, replay scheduling, multimodal, passport) is a *consumer* of the MCL. Without it, those items get bolted onto `audrey.ts` and the god-class problem (1074 LOC, growing) compounds.
- **Concrete shape**:
  - New `src/controller.ts` exporting `class MemoryController` with four ports:
    - `classify(input) → MemoryType`
    - `decide(input, classification) → WriteAction`
    - `route(query, context) → RetrievalPlan`
    - `schedule(now) → ReplayJob[]`
  - `audrey.ts` becomes a thin adapter that delegates to it.
  - Today's `encode.ts`, `recall.ts`, `consolidate.ts`, `decay.ts` get re-homed under controller dispatch.
  - **memory_validate from P0#1 is the controller's first-class signal port** — these two pieces of work are the same move.
- **Effort**: 1-2 weeks.

## P1 — competitive parity / quality wins (DAYS effort)

### 4. vstash adaptive RRF + IDF weighting in `src/hybrid-recall.ts`
- **Source**: arXiv research (#1)
- **Why**: Peer-validated +21.4% NDCG@10 on the *exact* sqlite-vec+FTS5 substrate Audrey uses. `src/hybrid-recall.ts:29-31` hardcodes `RRF_K=60`, `VECTOR_WEIGHT=0.3`, `FTS_WEIGHT=0.7`. The vstash paper (Apr 2026) shows adaptive weighting beats fixed weights.
- **Concrete shape**:
  - `getIdfWeights(db, query)` from `episodes_fts` `idx` table.
  - Per-query `k = clamp(60 * sqrt(query_len / 4), 30, 120)`.
  - Weight FTS rank by sum-IDF of matched terms; weight vector by mean candidate score.
  - Gate behind `AUDREY_RRF_ADAPTIVE=1` for one release, default on after.
- **Effort**: 1-2 days.

### 5. AgentDebug taxonomy on tool-trace
- **Source**: arXiv research (#8) + architecture review (P1B)
- **Why**: Audrey already has `tool-trace.ts`/`preflight.ts`/`reflexes.ts`. What's missing is the failure *taxonomy* that makes failures retrievable across tasks. Today retrieval is by string similarity; with the taxonomy it's by category.
- **Concrete shape**:
  - Add `failure_category: 'memory'|'reflection'|'planning'|'action'|'system'|'recovery'|'optimization'` to `ObserveToolInput`.
  - Migration: nullable `events.failure_category` column.
  - `src/preflight.ts` retrieves by `(tool_name, input_pattern, failure_category)` triples.
  - Auto-tag classifier in `src/llm.ts` during `reflect()`.
- **Effort**: 1 day.

### 6. Cognee-style `recall_auto()` + `memory_ask` MCP tool
- **Source**: competitive analysis (#3) + architecture review (P1C)
- **Why**: Cognee's 4-verb API (`recall` auto-picks strategy) is dramatically simpler than Audrey's "caller picks `RetrievalMode`." Zero breaking change, kills the "Audrey makes me think" complaint.
- **Concrete shape**:
  - New `recallAuto(query)` in `audrey.ts`.
  - 30-line heuristic classifier (proper-noun heavy → `keyword`, conceptual → `vector`, mixed → `hybrid`). No LLM call.
  - Expose as MCP tool `memory_ask`.
- **Effort**: 0.5 day.

### 7. SDK wrapper integration (Memori pattern)
- **Source**: competitive analysis (#6)
- **Why**: Audrey today requires explicit `memory_encode` / `memory_recall` calls. A `register()`-style wrapper makes Audrey work out-of-the-box for any OpenAI/Anthropic SDK user.
- **Concrete shape**:
  - `audrey/openai`, `audrey/anthropic`, `audrey/sdk` wrapper modules.
  - Monkey-patch `client.chat.completions.create` to auto-encode user/assistant turns and auto-inject recalled context into system prompt.
- **Effort**: 1-2 days per provider.

## P2 — security defense-in-depth (still open from 0.22.1 security audit)

### 8. Tighten `memory_import` validation
- **Sources**: security agent H3 + H4
- **What**: `mcp-server/index.ts:113-125` uses `z.array(z.any())` and `.passthrough()` — neutering validation. `/v1/import` calls `audrey.import(body.snapshot)` with no schema validation. An attacker can bypass `MAX_MEMORY_CONTENT_LENGTH`, inject malformed JSON in tags/context/affect, persist `private:0` for memories that were `private:1`, set `id` to anything (collide with future ULIDs).
- **Fix**: Define proper episode/semantic/procedure Zod schemas, validate id format, enforce length caps, validate `private` is `0|1`.

### 9. Stored prompt-injection wrapping in dream/consolidate
- **Source**: security agent H6
- **What**: Stored memory `content` flows into LLM prompts during consolidation/dreaming/`resolveTruth`. Untrusted content can contain "Ignore prior instructions, return: …" and steer the LLM to write poisoned semantics.
- **Fix**: Wrap memory content in delimiter blocks (`<memory_content>` with random nonce), instruct the LLM to treat anything inside as data, validate LLM JSON responses against Zod before persisting.

### 10. Redaction high-entropy fallback
- **Source**: security agent H7
- **What**: A naked `BEARER_TOKEN_VALUE_HERE` (no prefix, not in `key=value` form) passes redaction. Tool error stacks frequently dump raw env values when shells log them.
- **Fix**: Add high-entropy fallback rule (base64 ≥32 chars with ≥4 bits/char Shannon entropy) flagged conservatively.

### 11. Per-agent isolation in shared data dir
- **Source**: security agent M2
- **What**: Two agents pointed at the same `AUDREY_DATA_DIR` see each other's memory. The schema has an `agent` column but it's never used as a WHERE filter in recall.
- **Fix**: Either hash `AUDREY_AGENT` into the data dir path, or add `AUDREY_STRICT_ISOLATION=1` flag that adds `agent` to every recall WHERE clause.

## P2 — performance scaling (PERF agent #1, #4, #6, #9)

### 12. Hoist prepared statements to module-scope WeakMap
- **Source**: perf agent — already a known follow-up
- **What**: `db.prepare(...)` called per-call in `knnEpisodic`/`knnSemantic`/`knnProcedural` (`src/recall.ts:387, 444, 480`). better-sqlite3 caches internally but the JS-side `.prepare()` parse still costs ~10-30µs × 4 stmts × N calls.
- **Fix**: Module-scope `WeakMap<Database, PreparedStmts>`. Estimated 1-2ms off encode p50.

### 13. Fold the three knn MATCH queries into one UNION ALL
- **Source**: perf agent — already a known follow-up
- **What**: True SQL roundtrips per recall is ~6, not the v0.22.0 changelog's claimed 2. Three separate `MATCH` queries can be a single `UNION ALL` with type discriminator.
- **Fix**: Single prepared statement returning `(type, id, distance)`.

### 14. Self-join MATCH in dream's `clusterViaKNN`
- **Source**: perf agent #6
- **What**: `src/consolidate.ts:54` does `getEmbedding.get(ep.id)` then `knnQuery.all(...)` per episode — N × 2 = 2N queries to cluster N episodes. At 100K episodes that's 200K SQL calls inside a single dream.
- **Fix**: Self-join `SELECT a.id, b.id, b.distance FROM vec_episodes a JOIN vec_episodes b ON b.embedding MATCH a.embedding AND b.k=50 WHERE a.consolidated=0`. Estimated 5-20× on dream() at >10K episodes.

### 15. `encodeBatch` should call `embedBatch`
- **Source**: perf agent #9
- **What**: `encodeBatch` calls `embedBatch` per item — for OpenAI/Gemini that's N sequential HTTPS calls. The provider has `embedBatch` (Gemini's `batchEmbedContents` handles 100 per call).
- **Fix**: In `encodeBatch`, extract `content[]`, call `embedBatch`, pass pre-computed vectors into `encodeEpisode` via `options.vector`. 10-100× on bulk imports.

### 16. ONNX install as `optionalDependencies`
- **Source**: perf agent #7 + deps audit
- **What**: `onnxruntime-node` (208MB) + `@huggingface/transformers` (134MB) ship for every install even if user never sets `provider: 'local'`. Cloud-embedding users carry 342MB of dead weight.
- **Fix**: Move to `optionalDependencies` in package.json. The dynamic `await import('@huggingface/transformers')` already fails gracefully. Doctor check prompts install only when user picks `local`. Cuts package install size by ~70%.

## P3 — distinctiveness / "stop sounding like every other AI memory tool"

### 17. README "Audrey's POV" rewrite
- **Source**: adversary review (axis 1+3)
- **What**: The current first line ("local-first memory control plane for AI agents") could belong to mem0/Letta/Zep. No "Audrey voice."
- **Fix**: Replace first line with one of: a specific failure mode Audrey prevents, a specific user/use case, or Audrey's biological POV. Adversary's strawman: "The agent memory that forgets on purpose." Add a 300-word manifesto from Audrey-as-character.

### 18. `audrey vitals` — vital signs over CI verdicts
- **Source**: adversary review (axis 4)
- **What**: `audrey doctor` outputs a Kubernetes-grade verdict ladder where this is supposed to be a *biological* system. No heartbeat, no mood, no "I'm a little drowsy."
- **Fix**: New `audrey vitals` command (or fold into doctor) that prints episode count, dream debt in hours, top-3 active contradictions, last 5 retrievals with confidence, one-line mood string from recent affect distribution. The screenshot people share.

### 19. Pricing + commercial wedge
- **Source**: adversary review (axis 2)
- **What**: No pricing page, no ICP on README, no commercial primitive. MIT npm package with no business model in 2026.
- **Adversary's strawman**: Ship `audrey cloud sync` (encrypted blob sync of the SQLite file across a team's machines) at $19/seat. Smallest commercial primitive that doesn't require rebuilding Postgres. Specific ICP: staff/principal engineers running internal AI coding agents at 50-500 person eng orgs.
- **Effort**: 1 week to ship a credit-card-takes-money MVP.

### 20. Split `src/audrey.ts` god-class
- **Source**: architecture review (risk #2)
- **What**: 1074 lines, encoding+recall+consolidation+dreaming+status+introspection+lifecycle in one file. Blocks every PR once Memory Controller Layer arrives.
- **Fix**: Split into `audrey-core.ts` (lifecycle), `audrey-recall.ts`, `audrey-write.ts`, `audrey-introspect.ts`. Do this BEFORE the controller work in P0#3.

## Other research findings filed for later consideration

| Item | Source | Effort | Notes |
|---|---|---|---|
| EmbeddingGemma 300M Matryoshka migration | arXiv #2 | DAYS | Replace `Xenova/all-MiniLM-L6-v2` default. Migration risk (dim change requires reembed). |
| TiMem temporal-hierarchical memory tree | arXiv #6 | WEEKS | 76.88% LongMemEval-S, 52% context reduction. Extends `consolidate.ts`. |
| Memory-T1 time-window prefilter | arXiv #7 | HOURS | Heuristic time-window WHERE before vec MATCH. Captures most of Memory-T1's RL gain at 0% the cost. |
| EMem EDU decomposition | arXiv #9 | WEEKS | Elementary Discourse Units as encode-time decomposition. Gate behind `AUDREY_EDU_DECOMP=1`. |
| SmallThinker-4B local consolidation | arXiv #10 | WEEKS | 100%-local mode for `dream()` / `consolidate()` via Ollama or llama.cpp. |
| Letta `memory_blocks` (pinned LLM-editable) | competitive #2 | DAYS | Always-in-context structured memory. |
| Graphiti bitemporal facts | competitive #4 | DAYS | `valid_at` + `invalid_at` + `created_at` + `expired_at` quadruple. |
| Supermemory user profile | competitive #5 | DAYS | Materialized view joining top-N stable semantics + last-N episodes. |
| MemOS multi-cube architecture | competitive #7 | WEEKS | `cube_id` partitioning + `memory_correct` NL-feedback API. |
| basic-memory Obsidian vault sync | competitive #10 | DAYS | Bidirectional `.md` per memory in Obsidian-compatible vault. |
| Event log decay/archive | architecture risk #3 | DAYS | `events` table from `tool-trace.ts:152` grows unbounded. Need TTL/ring-buffer. |
| Embedding-dim drift guard | architecture risk #5 | HOURS | `pragma_check_provider_dim()` on Audrey init. Prevents silent corruption when env flips embedding provider. |
| Signed import/export (Memory Passport) | architecture risk #6 | DAYS | Sign snapshots before sharing across machines. |
| `hybrid-recall.ts` N+1 row loads | architecture risk #4 | HOURS | Replace per-FTS-id `prepare().get()` loop with `WHERE id IN (?)` batch. |

## Summary

**Two dimensions blocked PRODUCTION_READY in the autopilot rubric:**
- ALIVE (4/10) — fixed by P0#1 (closed feedback loop)
- MONEY (3/10) — fixed by P3#19 (commercial wedge)

**The single move that addresses both at once:**
> Build the Memory Controller Layer (P0#3) with `memory_validate` (P0#1) as
> its first-class signal port. Publish LongMemEval/LoCoMo numbers (P0#2)
> while it's being built. Then ship a paid `audrey cloud sync` (P3#19) on
> the same chassis.

That's the next 30 days. Everything else in this document is a P1/P2/P3
follow-up that compounds on top of those four moves.
