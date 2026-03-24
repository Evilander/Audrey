# Audrey: 90-Day Path to Business Viability

> **For agentic workers:** Execute phases in order. Each produces shippable software. Run tests after every task. Commit after every task. Do not skip phases.

**Goal:** Transform Audrey from an 8-star npm package into a fundable AI memory platform with paying customers, standardized benchmark scores, and multi-language SDK support within 90 days.

**The Thesis:** Every major AI memory competitor (Mem0, Letta, Zep, Supermemory) is a storage wrapper with retrieval. Audrey is the only system that models memory as a *biological process* — with forgetting, consolidation, contradiction detection, emotional affect, causal reasoning, and source reliability. The academic field has converged on this exact thesis (arXiv: 2601.03192, 2512.12856, 2601.03236). Audrey built it first. Now it needs distribution.

**Architecture:** Core stays Node.js/SQLite (zero-infrastructure is the moat). REST API bridges to Python/Go/Rust. Cloud tier adds multi-tenancy and billing. TypeScript types generated from JSDoc — shipping speed over type purity.

**Tech Stack:** Node.js ES modules, SQLite + sqlite-vec + FTS5, better-sqlite3, Python httpx + Pydantic, Stripe, Docker

---

## Current State (2026-03-24)

| Dimension | Value |
|-----------|-------|
| Version | 0.16.1 |
| Tests | 513 passing, 31 files, 0 failures |
| Vulnerabilities | 0 (npm audit clean) |
| Surfaces | SDK, MCP server (13 tools), REST API (9 endpoints), Claude Code hooks (4), CLI (12 commands) |
| CI | Node 18/20/22 Ubuntu + Windows, branch protection on master |
| Embedding providers | local (MiniLM 384d), Gemini (3072d), OpenAI (1536d) |
| LLM providers | Anthropic, OpenAI, mock |
| Security | timing-safe auth, Gemini key in headers, localhost-only bind, sanitized errors |

### Competitive Landscape

| System | Stars | Funding | Language | Audrey's Edge |
|--------|-------|---------|----------|---------------|
| Mem0 | 50.9K | $24M | Python | No forgetting, no affect, no causal graphs, $249/mo for graph memory |
| Letta/MemGPT | 21.7K | $10M | Python | No biological decay, no contradiction detection, server-only |
| Zep/Graphiti | 24.2K | VC | Python | Requires Neo4j/graph DB infra, no affect system |
| Supermemory | 18.5K | - | TypeScript | No forgetting, no consolidation, cloud-only |
| Hindsight | 5.9K | - | Python | Closest competitor — but no affect, no Claude Code hooks |
| **Audrey** | **8** | **$0** | **JavaScript** | **Only system with: forgetting + affect + causal + contradiction + hooks** |

### What Works End-to-End Right Now

```bash
# Install + automatic memory in 30 seconds
npx audrey install          # 13 MCP tools for Claude Code
npx audrey hooks install    # Automatic memory every session

# REST API for any language
npx audrey serve            # http://localhost:3487
curl -X POST localhost:3487/encode -H "Content-Type: application/json" \
  -d '{"content":"deploy failed OOM","source":"direct-observation"}'

# SDK
import { Audrey } from 'audrey';
const brain = new Audrey({ dataDir: './data', embedding: { provider: 'local' } });
await brain.encode({ content: 'fact', source: 'direct-observation' });
const results = await brain.recall('query');
await brain.dream(); // consolidate + decay + introspect
```

---

## Architecture

```
                     Audrey Core (Node.js/SQLite)
                    src/audrey.js — encode, recall, dream
                    src/db.js — SQLite + sqlite-vec + FTS5*
                              |
              +---------------+---------------+
              |               |               |
          MCP Server     REST API       Claude Code
          (stdio)        (HTTP)         Hooks (CLI)
                              |
              +---------------+---------------+
              |               |               |
          Python SDK*    Dashboard*      Audrey Cloud*
          (HTTP client)  (HTML)          (multi-tenant)
                                         (* = planned)
```

### Source Files (current)

```
src/
  audrey.js       — Core class, extends EventEmitter. 620 lines.
  db.js           — Schema, migrations (v1-7), vec0 tables. 350 lines.
  recall.js       — Vector KNN + lexical coverage + scoring. 450 lines.
  encode.js       — Episode encoding with validation. 120 lines.
  consolidate.js  — Union-find clustering + LLM extraction. 280 lines.
  decay.js        — Confidence decay + dormancy transitions. 90 lines.
  confidence.js   — Multi-factor scoring formula. 110 lines.
  affect.js       — Valence/arousal + mood-congruent recall. 65 lines.
  interference.js — Proactive interference detection. 80 lines.
  causal.js       — Causal link graphs + chain traversal. 90 lines.
  context.js      — Context matching + relevance boost. 70 lines.
  forget.js       — By ID + by query deletion. 110 lines.
  export.js       — JSON snapshot export. 60 lines.
  import.js       — JSON snapshot import with re-embedding. 130 lines.
  embedding.js    — Provider abstraction (local/gemini/openai). 250 lines.
  llm.js          — LLM provider abstraction. 180 lines.
  prompts.js      — All LLM prompt templates. 230 lines.
  validate.js     — Memory content validation. 50 lines.
  adaptive.js     — Consolidation parameter tuning. 55 lines.
  rollback.js     — Semantic rollback to prior state. 40 lines.
  migrate.js      — Re-embedding migration. 60 lines.
mcp-server/
  index.js        — MCP server + CLI dispatch. 1220 lines.
  config.js       — Provider/path resolution. 135 lines.
  serve.js        — REST API server (node:http). 250 lines.
```

---

## Known Bugs (Fix Before Phase 1)

These were identified by the production autopilot's deep code review agent. Fix all HIGH before starting new features.

| # | Bug | Severity | File:Line | Fix |
|---|-----|----------|-----------|-----|
| 1 | `encode()` fire-and-forgets `applyInterference` + `detectResonance` — if `close()` is called before they resolve, db throws "not open" | HIGH | `src/audrey.js:200-218` | Add `this._pending = new Set()`, track promises, drain in `close()` |
| 2 | `importMemories` has no field validation — a bad snapshot wipes the db (via restore) then fails mid-transaction, leaving empty store | HIGH | `src/import.js:19-22` | Validate `id`, `content`, `source` enum before starting transaction |
| 3 | `recall()` silently swallows all errors from KNN queries — a dimension mismatch returns empty results with no signal | MEDIUM | `src/recall.js:399-441` | Catch, log, and set `partialFailure: true` on result |
| 4 | `consolidate.js` uses raw `db.exec('BEGIN IMMEDIATE')` — fragile if caller wraps in `db.transaction()` | MEDIUM | `src/consolidate.js:196` | Replace with `better-sqlite3` `.transaction()` |
| 5 | `parseBody` in serve.js can double-reject on `req.destroy()` | LOW | `mcp-server/serve.js:15-22` | Set `rejected` flag, remove listeners |

---

## Phase 0: Bug Fixes (Day 1-2)

Fix all 5 bugs above. These are preconditions for everything else.

- [ ] Fix Bug 1: Track in-flight promises in `encode()`, drain in `close()`
- [ ] Fix Bug 2: Validate snapshot fields before destructive restore
- [ ] Fix Bug 3: Log recall errors, expose partial failure signal
- [ ] Fix Bug 4: Replace raw BEGIN with `.transaction()` wrapper
- [ ] Fix Bug 5: Guard against double-reject in parseBody
- [ ] Run full test suite (513+ passing)
- [ ] Commit each fix separately with descriptive messages

---

## Phase 1: Multi-Agent Memory + TypeScript Types (Week 1-2)

**Why first:** Multi-agent shared memory is the #1 enterprise gap. TS types are table stakes. Both low-risk, high-signal.

### Task 1.1: Agent column on all memory tables

**Files:** `src/db.js`, `src/encode.js`, `src/recall.js`, `src/audrey.js`, `tests/multi-agent.test.js` (new)

Migration 8 — add to `MIGRATIONS` array in `src/db.js`:
```js
{
  version: 8,
  up(db) {
    addColumnIfMissing(db, 'episodes', 'agent', "TEXT DEFAULT 'default'");
    addColumnIfMissing(db, 'semantics', 'agent', "TEXT DEFAULT 'default'");
    addColumnIfMissing(db, 'procedures', 'agent', "TEXT DEFAULT 'default'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_semantics_agent ON semantics(agent)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_procedures_agent ON procedures(agent)");
  }
}
```

- [ ] Write test: Agent A encodes, Agent B encodes, `recall({ scope: 'agent' })` returns only own
- [ ] Write test: `recall({ scope: 'shared' })` returns all (default, backward-compatible)
- [ ] Write test: consolidation respects agent boundaries
- [ ] Implement migration 8 in `src/db.js`
- [ ] Modify `encodeEpisode` in `src/encode.js` — INSERT agent value
- [ ] Modify `recall` in `src/recall.js` — accept `scope` option, default 'shared'
- [ ] Run full suite (513+ passing), commit: `feat: multi-agent memory namespacing`

### Task 1.2: REST API multi-agent support

**Files:** `mcp-server/serve.js`, `tests/serve.test.js`

- [ ] Read `X-Audrey-Agent` header or `agent` field in body
- [ ] POST /encode with agent stores under that namespace
- [ ] POST /recall with scope='agent' filters by request agent
- [ ] Tests for cross-agent isolation + shared recall
- [ ] Commit: `feat: REST API multi-agent support`

### Task 1.3: TypeScript declarations

**Files:** `types/index.d.ts` (new), `package.json`

```ts
// types/index.d.ts — cover all public interfaces
export class Audrey extends EventEmitter {
  constructor(config: AudreyConfig);
  encode(params: EncodeParams): Promise<string>;
  recall(query: string, options?: RecallOptions): Promise<RecallResult[]>;
  consolidate(options?: ConsolidateOptions): Promise<ConsolidationResult>;
  dream(options?: DreamOptions): Promise<DreamResult>;
  introspect(): IntrospectResult;
  export(): Snapshot;
  import(snapshot: Snapshot): Promise<void>;
  forget(id: string, options?: ForgetOptions): ForgetResult;
  forgetByQuery(query: string, options?: ForgetQueryOptions): Promise<ForgetResult | null>;
  purge(): PurgeResult;
  greeting(options?: GreetingOptions): Promise<GreetingResult>;
  reflect(turns: string): Promise<ReflectResult>;
  markUsed(id: string): void; // Phase 3
  close(): void;
}
```

- [ ] Write complete `types/index.d.ts` with all interfaces
- [ ] Add `"types": "types/index.d.ts"` to package.json
- [ ] Verify: `npx tsc --noEmit` on test consumer file
- [ ] Commit: `feat: TypeScript type declarations`

---

## Phase 2: Hybrid BM25 + Vector Retrieval (Week 2-3)

**Why:** Pure vector search misses exact terms. SQLite FTS5 is free (built into better-sqlite3). Reciprocal Rank Fusion is proven (Hindsight uses it to hit 91.4% LongMemEval). This directly boosts benchmark scores.

**Research backing:** MAGMA (arXiv:2601.03236) showed multi-strategy retrieval with adaptive routing improves accuracy 45.5% while cutting tokens 95%.

### Task 2.1: FTS5 virtual tables

**Files:** `src/fts.js` (new), `src/db.js`, `tests/fts.test.js` (new)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes
  USING fts5(id UNINDEXED, content, tags, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_semantics
  USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_procedures
  USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
```

- [ ] Write tests: FTS5 creation, INSERT on encode, BM25 search returns ranked results
- [ ] Implement `createFTSTables`, `insertFTS`, `searchFTS` in `src/fts.js`
- [ ] Migration 9: create FTS tables, backfill from existing content
- [ ] Hook into encode: after episode INSERT, also INSERT into fts_episodes
- [ ] Commit: `feat: FTS5 full-text search tables`

### Task 2.2: Reciprocal Rank Fusion recall

**Files:** `src/hybrid-recall.js` (new), `src/recall.js`, `tests/hybrid-recall.test.js` (new)

RRF: `score(d) = sum(1 / (k + rank_i(d)))` where k=60

- [ ] Write tests: vector-only, keyword-only, hybrid — verify hybrid catches what vector misses
- [ ] Implement `hybridRecall` — run KNN and FTS5 in parallel, merge via RRF
- [ ] Apply confidence/affect/context modifiers after merge
- [ ] Add `retrieval: 'hybrid' | 'vector' | 'keyword'` option, default 'hybrid'
- [ ] Full suite passes, commit: `feat: hybrid BM25+vector retrieval via RRF`

---

## Phase 3: Implicit Relevance Feedback (Week 3-4)

**Why:** Adversary scored self-improvement 2/10. MemRL (arXiv:2601.03192) proved that tracking actual utility of recalled memories produces 56% improvement. This is the single highest-impact quality change.

### Task 3.1: Track recall outcomes

**Files:** `src/relevance.js` (new), `src/db.js`, `src/audrey.js`, `tests/relevance.test.js` (new)

Migration 10: add `usage_count INTEGER DEFAULT 0`, `last_used_at TEXT` to episodes, semantics, procedures.

- [ ] Write test: `markUsed(id)` increments `usage_count`, updates `last_used_at`
- [ ] Write test: memories with `retrieval_count > 5` and `usage_count === 0` get salience lowered
- [ ] Implement `markUsed(id)` on Audrey class
- [ ] Add utility factor to confidence: `usage_count / (retrieval_count + 1)`
- [ ] In `dream()`, auto-decay salience of retrieved-but-never-used memories
- [ ] Commit: `feat: implicit relevance feedback`

### Task 3.2: Integration across all surfaces

- [ ] Add `memory_mark_used` MCP tool
- [ ] Add `POST /mark-used` REST endpoint
- [ ] In hooks `reflect()`, detect which recalled memories were referenced in conversation
- [ ] Commit: `feat: mark-used across MCP, REST, and hooks`

---

## Phase 4: Standardized Benchmarks (Week 4-5)

**Why:** "Beats Mem0 on temporal reasoning" is worth more than any feature. Numbers change conversations. Supermemory open-sourced MemoryBench — Audrey needs to run against it.

### Task 4.1: MemoryBench + LoCoMo adapter

**Files:** `benchmarks/memorybench.js` (new), `benchmarks/locomo-adapter.js` (new), `package.json`

- [ ] Write adapter: MemoryBench store/retrieve/update/delete maps to Audrey encode/recall/consolidate/forget
- [ ] Run LongMemEval suite — extraction, updates, temporal, multi-session, abstention
- [ ] Run LoCoMo suite — capture scores per category
- [ ] Output JSON + comparison table
- [ ] Update README with real standardized scores (replace self-referential chart)
- [ ] If any dimension beats Mem0's 66.9% — that becomes the README headline
- [ ] Add `bench:locomo` and `bench:memorybench` scripts to package.json
- [ ] Commit: `feat: MemoryBench + LoCoMo standardized benchmarks`

---

## Phase 5: Memory Dashboard (Week 5-6)

**Why:** Makes value visible. "What did Audrey do for you today?" — users see memory health, growth, contradictions, consolidation in real time. MemOS dashboard was called out as table stakes.

### Task 5.1: HTML dashboard

**Files:** `dashboard/index.html` (new), `mcp-server/serve.js`, `mcp-server/index.js`

Single-file HTML with inline CSS/JS (no build step, no dependencies):

1. **Memory Health** — episode/semantic/procedural counts, dormancy rate, contradiction status
2. **Growth Over Time** — SVG chart from consolidation_runs data
3. **Top Memories** — most retrieved, most used (Phase 3), highest confidence
4. **Open Contradictions** — with source episodes and current state
5. **Consolidation History** — yield trend, principles extracted per run
6. **Agent Activity** — per-agent memory counts (Phase 1 enables this)
7. **Session Summary** — "Today: 12 recalls, 3 principles formed, 1 contradiction detected"

- [ ] Add `GET /analytics` endpoint to serve.js — time-series data from consolidation_runs/metrics
- [ ] Build static HTML with inline SVG charts, fetches from /status + /analytics
- [ ] `npx audrey dashboard` opens browser to `http://localhost:3487/dashboard`
- [ ] Commit: `feat: memory health dashboard`

---

## Phase 6: Python SDK (Week 6-8)

**Why:** 80%+ of AI agent development is Python. Without Python, Audrey is invisible to the largest market segment. Every competitor (Mem0, Letta, Zep) is Python-first.

### Task 6.1: HTTP client — `pip install audrey-memory`

**Files:** `python/audrey_memory/client.py`, `python/audrey_memory/types.py`, `python/pyproject.toml`, `python/tests/test_client.py`, `python/README.md`

```python
from audrey_memory import Audrey

brain = Audrey(base_url="http://localhost:3487", api_key="secret", agent="my-agent")
mid = brain.encode("Stripe returns 429 above 100 req/s", source="direct-observation")
results = brain.recall("rate limits", limit=5)
brain.dream()
brain.close()
```

- [ ] Sync + async httpx clients
- [ ] Pydantic models for all request/response types
- [ ] Integration tests that start `npx audrey serve` and hit real endpoints
- [ ] Publish to PyPI as `audrey-memory`
- [ ] Commit: `feat: Python SDK`

### Task 6.2: LangChain / CrewAI / LangGraph memory provider

**Files:** `python/audrey_memory/langchain.py`

```python
from audrey_memory.langchain import AudreyMemory
memory = AudreyMemory(base_url="http://localhost:3487")
# Drop-in replacement for ConversationBufferMemory / etc.
```

- [ ] Implement LangChain `BaseMemory` — `load_memory_variables` + `save_context`
- [ ] Test with real LangChain agent
- [ ] Commit: `feat: LangChain memory provider`

---

## Phase 7: Audrey Cloud — Memory-as-a-Service (Week 8-12)

**Why:** This is the business model. Local-first stays free forever. Cloud adds team features, hosted dashboard, and billing.

### Task 7.1: Multi-tenant server

**Files:** `cloud/server.js`, `cloud/auth.js`, `cloud/billing.js`, `cloud/Dockerfile`, `cloud/docker-compose.yml`

Architecture: API key maps to tenant. Per-tenant isolated SQLite file. Postgres only for tenant registry + billing.

```
Client → Audrey Cloud API → Auth (API key → tenant)
                          → Tenant Router → Per-tenant Audrey (SQLite)
                          → Usage Meter → Stripe webhook
```

- [ ] Tenant registration + API key provisioning
- [ ] Per-tenant rate limiting
- [ ] Usage metering: encode/recall/dream counts per tenant per day
- [ ] Stripe checkout integration
- [ ] Docker Compose with persistent volumes
- [ ] Commit: `feat: Audrey Cloud multi-tenant server`

### Task 7.2: Pricing tiers

```
Free:       1 agent,   10K memories,   100 recalls/day,  community support
Pro $29:    10 agents, 100K memories,  unlimited recalls, dashboard, email support
Team $99:   50 agents, 500K memories,  shared memory,     RBAC, priority support
Enterprise: unlimited, audit logs, SSO, SLA, custom pricing
```

Comparison: Mem0 Platform charges $249/mo for graph memory. Audrey Pro gives you biological memory (forgetting + affect + causal) for $29.

- [ ] Tier enforcement in auth middleware
- [ ] Stripe checkout for Pro/Team
- [ ] Usage dashboard in Audrey Cloud web UI
- [ ] Commit: `feat: pricing tier enforcement`

---

## Phase 8: Go-to-Market (Starts Week 4, Ongoing)

### Task 8.1: Claude Code Community Launch (CRITICAL — highest ROI action)

Do this the moment Phase 4 benchmarks are ready. This is the distribution move.

**dev.to article: "How I Gave Claude Code Persistent Memory in 30 Seconds"**
- Before/after: session without Audrey vs. with (show greeting, per-prompt recall, reflect output)
- Two commands: `npx audrey install && npx audrey hooks install`
- Include benchmark scores vs. Mem0/Letta
- "Open source, MIT license, $0, no cloud required"

**Distribution channels:**
- [ ] dev.to article (primary)
- [ ] Comment on anthropics/claude-code#14227 (persistent memory request — high engagement issue)
- [ ] Anthropic Discord #claude-code channel
- [ ] Hacker News: "Show HN: Audrey — Biological Memory for AI Agents"
- [ ] Reddit: r/ClaudeAI, r/LocalLLaMA, r/MachineLearning
- [ ] Twitter/X: tag @AnthropicAI, @alexalbert__, use #ClaudeCode

### Task 8.2: Honest comparison page

**File:** `docs/comparison.md`

Feature matrix: Audrey vs Mem0 vs Letta vs Zep vs Supermemory vs Hindsight

Must include:
- Price comparison ($0 vs $249/mo for Mem0 graph)
- Feature matrix with honest YES/NO/PARTIAL
- "When to choose Audrey" (local-first, Claude Code, biological fidelity)
- "When NOT to choose Audrey" (need Python-native, need hosted, need enterprise SSO today)

### Task 8.3: Demo video (2 min)

- [ ] Record: install → hooks → greeting → encode → recall → dream → contradiction → dashboard
- [ ] Post YouTube, embed in README
- [ ] Create GIF for GitHub social preview

---

## Research Intelligence (From 6 Parallel Agents)

These findings should inform implementation decisions across all phases. Ranked by impact-to-risk ratio.

### High Impact, Low Risk (Implement in Phases 1-4)

| Finding | Source | Integrate Into |
|---------|--------|---------------|
| MemRL utility scoring — track which recalled memories led to good outcomes | arXiv:2601.03192 | Phase 3 (relevance feedback) |
| MaRS hybrid forgetting — staged pipeline: priority decay → summary compression → purge | arXiv:2512.12856 | Phase 3 + consolidation |
| Human-like spaced repetition — rehearse important memories during dream | arXiv:2506.12034 | Phase 3 (dream cycle) |
| RRF fusion for multi-strategy retrieval | Hindsight/TEMPR | Phase 2 (hybrid recall) |
| Affect-gated consolidation — emotional similarity as clustering predicate | arXiv:2508.10286 | Phase 2 (consolidate.js) |

### Medium Impact (Implement in Phases 5-7)

| Finding | Source | Integrate Into |
|---------|--------|---------------|
| A-MEM cross-memory linking (Zettelkasten style) | arXiv:2502.12110 (NeurIPS 2025) | Phase 5 (dashboard can visualize links) |
| Matryoshka embeddings for funnel search | arXiv:2205.13147 | Phase 2 (optional optimization) |
| Bi-temporal fact management (valid_from/valid_until) | Zep/Graphiti | Phase 7 (enterprise feature) |
| OpenTelemetry instrumentation | Cognee pattern | Phase 7 (cloud observability) |
| Entity graph + deterministic contradiction detection | Mem0g (arXiv:2504.19413) | Future — significant new schema |

---

## Execution Priority

| Week | Phase | Deliverable | Impact |
|------|-------|-------------|--------|
| 1 | 0 | Bug fixes (5 bugs) | Prerequisite |
| 1-2 | 1 | Multi-agent + TS types | Unlocks teams |
| 2-3 | 2 | Hybrid BM25+vector retrieval | Quality leap |
| 3-4 | 3 | Relevance feedback + utility scoring | Self-improvement |
| 4-5 | 4 | LoCoMo/MemoryBench scores | Credibility |
| **4+** | **8.1** | **Claude Code community launch** | **DISTRIBUTION** |
| 5-6 | 5 | Memory dashboard | Visibility |
| 6-8 | 6 | Python SDK + LangChain provider | TAM expansion |
| 8-12 | 7 | Audrey Cloud + billing | Revenue |
| Ongoing | 8 | Content, video, comparisons | Trust |

---

## Success Metrics

| Metric | Now | 30 Days | 90 Days |
|--------|-----|---------|---------|
| GitHub stars | 8 | 100 | 1,000 |
| npm downloads/week | ~0 | 200 | 2,000 |
| PyPI downloads/week | 0 | 100 | 1,000 |
| Test count | 513 | 600 | 750 |
| LoCoMo score | N/A | Published | > Mem0 66.9% |
| Paying customers | 0 | 0 | 10 |
| MRR | $0 | $0 | $290+ |
| Claude Code hooks users | unknown | 50 | 500 |

---

## Environment Variables

```bash
# Core
AUDREY_DATA_DIR=~/.audrey/data       # SQLite storage
AUDREY_AGENT=claude-code             # Agent identifier

# Embeddings (auto-detected if keys present)
AUDREY_EMBEDDING_PROVIDER=local      # local | gemini | openai
GOOGLE_API_KEY=                      # Gemini (3072d)
OPENAI_API_KEY=                      # OpenAI (1536d)

# LLM (for consolidation, reflection, contradiction detection)
AUDREY_LLM_PROVIDER=anthropic        # anthropic | openai | mock
ANTHROPIC_API_KEY=                   # Claude

# REST API server
AUDREY_PORT=3487                     # Default port
AUDREY_HOST=127.0.0.1               # Bind address (localhost-only by default)
AUDREY_API_KEY=                      # Bearer token auth

# Local embeddings
AUDREY_DEVICE=gpu                    # gpu | cpu
```

---

## CLI Reference

```bash
# Setup (30 seconds to working memory)
npx audrey install                   # Register 13 MCP tools with Claude Code
npx audrey hooks install             # Wire 4 hooks into session lifecycle
npx audrey serve [port]              # Start REST API (default: 3487)

# Health
npx audrey status                    # Human-readable health report
npx audrey status --json             # Machine-readable
npx audrey status --json --fail-on-unhealthy  # CI gate

# Session lifecycle (hooks call these automatically)
npx audrey greeting                  # Identity, principles, mood, recent memories
npx audrey recall "query"            # Semantic search (returns hook-compatible JSON)
npx audrey reflect                   # Encode learnings from conversation + dream

# Maintenance
npx audrey dream                     # Full consolidation + decay cycle
npx audrey reembed                   # Re-embed all after provider change

# Versioning
npx audrey snapshot [file]           # Export to JSON (git-friendly)
npx audrey restore <file> [--force]  # Import from snapshot

# Dashboard (Phase 5)
npx audrey dashboard                 # Open memory health dashboard

# Development
npm test                             # 513 tests
npm run bench:memory                 # Run benchmarks
npm run bench:memory:check           # CI regression gate
npm run pack:check                   # Verify package contents
```

---

**The gap is not technical quality. It is distribution. Phase 8.1 is the most important task in this document. Ship working software at every phase boundary. The goal is not perfection — it is momentum.**
