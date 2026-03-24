# Audrey: Path to Business Viability

> **For agentic workers:** This is the master execution plan for transforming Audrey from an 8-star npm package into a fundable, revenue-generating AI memory platform. Execute phases in order. Each phase produces working, testable, shippable software.
>
> **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Take Audrey from adversary-scored 3/10 business viability to a product with paying customers, standardized benchmarks, and multi-language SDK support within 90 days.

**Architecture:** Audrey's core stays in Node.js/SQLite (the moat is zero-infrastructure biological memory). A REST API server (`npx audrey serve`) bridges to other languages. A Python SDK is a thin HTTP client. A hosted cloud tier wraps the server with auth, billing, and multi-tenancy. TypeScript types are generated from JSDoc, not a full rewrite.

**Tech Stack:** Node.js (ES modules), SQLite + sqlite-vec + FTS5, better-sqlite3, Python (httpx + pydantic), Stripe (billing), Docker

**Current State (2026-03-24):**
- v0.16.1, 513 tests, 31 test files, 0 vulnerabilities
- SDK + MCP server + REST API + Claude Code hooks + CLI
- Competitors: Mem0 ($24M/50K stars), Letta ($10M/21K stars), Zep (24K stars)
- Unique moat: forgetting curves, contradiction detection, emotional affect, causal graphs, source reliability

---

## Architecture Overview

```
                     Audrey Core (Node.js/SQLite)
                    src/audrey.js - encode, recall, dream
                    src/db.js - SQLite + sqlite-vec + FTS5
                              |
              +---------------+---------------+
              |               |               |
          MCP Server     REST API       Claude Code
          (stdio)        (HTTP)         Hooks (CLI)
                              |
              +---------------+---------------+
              |               |               |
          Python SDK     Dashboard       Audrey Cloud
          (HTTP client)  (HTML)          (multi-tenant)
```

**File tree (current + planned additions marked with *):**
```
audrey/
  src/
    audrey.js, db.js, recall.js, encode.js, consolidate.js,
    decay.js, confidence.js, affect.js, interference.js,
    causal.js, context.js, forget.js, export.js, import.js,
    embedding.js, llm.js, prompts.js, validate.js, adaptive.js,
    rollback.js, migrate.js, ulid.js, utils.js, index.js
    *fts.js            -- FTS5 full-text search (Phase 2)
    *hybrid-recall.js  -- BM25 + vector RRF fusion (Phase 2)
    *relevance.js      -- Implicit relevance feedback (Phase 3)
  mcp-server/
    index.js, config.js, serve.js
  *dashboard/
    index.html         -- Single-file memory dashboard
  *python/
    audrey_memory/     -- Python SDK (pip install audrey-memory)
  *types/
    index.d.ts         -- TypeScript declarations
  benchmarks/
    run.js, *memorybench.js, *locomo-adapter.js
  tests/               -- 31 test files
  examples/            -- Demo scripts
  docs/                -- Production readiness, benchmarking
```

---

## Phase 1: Multi-Agent Memory + TypeScript Types (Week 1-2)

**Why first:** Multi-agent shared memory is the number one enterprise feature gap. TypeScript types are table stakes for adoption. Both are low-risk, high-signal.

### Task 1.1: Add agent column to all memory tables

**Files:**
- Modify: `src/db.js` -- Add migration 8 with agent TEXT column
- Modify: `src/encode.js` -- Pass agent param through to INSERT
- Modify: `src/recall.js` -- Add optional agent filter to KNN queries
- Modify: `src/audrey.js` -- Thread this.agent into encode/recall
- Test: `tests/multi-agent.test.js`

Schema migration (add to MIGRATIONS array in src/db.js):
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

- [ ] Write test: Agent A encodes, Agent B encodes, Agent A recalls only its own with scope='agent'
- [ ] Write test: recall with scope='shared' returns all agents' memories (default behavior)
- [ ] Write test: consolidation respects agent boundaries
- [ ] Implement migration 8 in src/db.js
- [ ] Modify encodeEpisode in src/encode.js to INSERT agent value
- [ ] Modify recall in src/recall.js to accept scope option, filter by agent when scope='agent'
- [ ] Default scope='shared' for backward compatibility
- [ ] Run full test suite, must stay at 513+ passing
- [ ] Commit: `feat: add multi-agent memory namespacing`

### Task 1.2: REST API multi-agent support

**Files:**
- Modify: `mcp-server/serve.js` -- Read X-Audrey-Agent header
- Modify: `tests/serve.test.js` -- Multi-agent REST tests

- [ ] REST API reads X-Audrey-Agent header or agent field in body
- [ ] POST /encode with agent stores under that namespace
- [ ] POST /recall with scope='agent' filters by request agent
- [ ] Add tests for cross-agent isolation and shared recall
- [ ] Commit: `feat: REST API multi-agent support`

### Task 1.3: TypeScript declarations

**Files:**
- Create: `types/index.d.ts`
- Modify: `package.json` -- Add "types" field

Cover all public interfaces: Audrey class, EncodeParams, RecallOptions, RecallResult, ConsolidationResult, DreamResult, IntrospectResult, Snapshot, AudreyConfig, EmbeddingConfig, LLMConfig, AffectConfig, etc.

- [ ] Write types/index.d.ts with all public interfaces
- [ ] Add "types": "types/index.d.ts" to package.json
- [ ] Verify with npx tsc --noEmit on a test consumer file
- [ ] Commit: `feat: add TypeScript type declarations`

---

## Phase 2: Hybrid Retrieval (Week 2-3)

**Why:** Adversary and competitive analysis both flagged this. SQLite FTS5 is free. Hybrid retrieval beats pure vector for technical content with identifiers.

### Task 2.1: FTS5 virtual tables

**Files:**
- Create: `src/fts.js` -- FTS5 creation, indexing, search functions
- Modify: `src/db.js` -- Migration 9 creates FTS5 tables, backfills
- Test: `tests/fts.test.js`

SQL for FTS5 tables:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes
  USING fts5(id UNINDEXED, content, tags, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_semantics
  USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_procedures
  USING fts5(id UNINDEXED, content, tokenize='porter unicode61');
```

- [ ] Write tests: FTS5 table creation, INSERT on encode, BM25 search returns ranked results
- [ ] Implement createFTSTables, insertFTS, searchFTS in src/fts.js
- [ ] Add migration 9 that creates FTS tables and backfills from existing content
- [ ] Hook into encode pipeline: after episode INSERT, also INSERT into fts_episodes
- [ ] Commit: `feat: add FTS5 full-text search tables`

### Task 2.2: Reciprocal Rank Fusion

**Files:**
- Create: `src/hybrid-recall.js` -- RRF merge of vector + BM25
- Modify: `src/recall.js` -- Call hybrid when FTS tables exist
- Test: `tests/hybrid-recall.test.js`

RRF formula: `score(d) = sum(1 / (k + rank_i(d)))` where k=60

- [ ] Write tests: vector-only, BM25-only, hybrid, verify hybrid finds things pure vector misses
- [ ] Implement hybridRecall that runs KNN and FTS5 queries
- [ ] Merge via RRF scoring, then apply confidence/affect/context modifiers
- [ ] Add retrieval option: 'hybrid' (default) | 'vector' | 'keyword'
- [ ] Run full suite, all 513+ tests pass
- [ ] Commit: `feat: hybrid BM25+vector retrieval via Reciprocal Rank Fusion`

---

## Phase 3: Implicit Relevance Feedback (Week 3-4)

**Why:** Adversary scored self-improvement 2/10. Track whether recalled memories get used. Auto-decay unused ones.

### Task 3.1: Track recall outcomes

**Files:**
- Create: `src/relevance.js` -- Usage tracking and auto-decay
- Modify: `src/db.js` -- Migration 10: usage_count, last_used_at columns
- Modify: `src/audrey.js` -- Add markUsed(id) method
- Test: `tests/relevance.test.js`

- [ ] Write test: markUsed increments usage_count and updates last_used_at
- [ ] Write test: memories retrieved 10+ times but never used get salience lowered in dream()
- [ ] Implement markUsed(id) on Audrey class
- [ ] Add utilityScore to confidence calculation: usage_count / (retrieval_count + 1)
- [ ] In dream(), auto-lower salience of memories with retrieval_count > 5 and usage_count === 0
- [ ] Commit: `feat: implicit relevance feedback`

### Task 3.2: Integration across surfaces

- [ ] Add memory_mark_used MCP tool
- [ ] Add POST /mark-used REST endpoint
- [ ] In hooks reflect(), detect which recalled memories were referenced in conversation
- [ ] Commit: `feat: mark-used across MCP, REST, and hooks`

---

## Phase 4: Standardized Benchmarks (Week 4-5)

**Why:** Credibility. Numbers change conversations. "Beats Mem0 on temporal reasoning" is worth more than any feature.

### Task 4.1: MemoryBench adapter

**Files:**
- Create: `benchmarks/memorybench.js` -- Adapter for memorybench framework
- Create: `benchmarks/locomo-adapter.js` -- LoCoMo benchmark runner
- Modify: `package.json` -- Add bench:locomo and bench:memorybench scripts

- [ ] Write adapter mapping MemoryBench store/retrieve/update/delete to Audrey encode/recall/consolidate/forget
- [ ] Run against LongMemEval suite, capture scores
- [ ] Run against LoCoMo suite, capture scores
- [ ] Output machine-readable JSON results
- [ ] Update README with real standardized scores
- [ ] If any dimension beats Mem0 66.9%, make it the headline
- [ ] Commit: `feat: MemoryBench + LoCoMo standardized benchmarks`

---

## Phase 5: Memory Dashboard (Week 5-6)

**Why:** Makes value visible. Users see memory health, growth, contradictions in real time.

### Task 5.1: HTML dashboard

**Files:**
- Create: `dashboard/index.html` -- Single-file dashboard (inline CSS/JS, no build)
- Modify: `mcp-server/serve.js` -- Mount GET /dashboard
- Modify: `mcp-server/index.js` -- Add `npx audrey dashboard` CLI command

Dashboard sections:
1. Memory Health -- episode/semantic/procedural counts, dormancy rate
2. Growth Over Time -- chart from consolidation_runs data
3. Top Memories -- most retrieved, highest confidence
4. Open Contradictions -- with source episodes and state
5. Consolidation History -- yield trend, principles extracted
6. Agent Activity -- per-agent counts (from Phase 1)

- [ ] Build static HTML with inline SVG charts (no deps)
- [ ] Add GET /analytics endpoint returning time-series data
- [ ] npx audrey dashboard opens browser to localhost:3487/dashboard
- [ ] Commit: `feat: memory health dashboard`

---

## Phase 6: Python SDK (Week 6-8)

**Why:** 80%+ of AI agent dev is Python. Without Python, Audrey is invisible to the market.

### Task 6.1: HTTP client

**Files:**
- Create: `python/audrey_memory/__init__.py`
- Create: `python/audrey_memory/client.py` -- httpx-based client
- Create: `python/audrey_memory/types.py` -- Pydantic models
- Create: `python/pyproject.toml`
- Create: `python/tests/test_client.py`
- Create: `python/README.md`

```python
from audrey_memory import Audrey

brain = Audrey(base_url="http://localhost:3487", api_key="secret")
mid = brain.encode("Deploy failed from OOM", source="direct-observation")
results = brain.recall("deploy failures", limit=5)
brain.dream()
brain.close()
```

- [ ] Implement sync + async clients with httpx
- [ ] Pydantic models for all types
- [ ] Integration tests that start npx audrey serve
- [ ] Publish to PyPI as audrey-memory
- [ ] Commit: `feat: Python SDK -- pip install audrey-memory`

### Task 6.2: LangChain memory provider

**Files:**
- Create: `python/audrey_memory/langchain.py`

- [ ] Implement LangChain BaseMemory with load_memory_variables and save_context
- [ ] Test with real LangChain agent
- [ ] Commit: `feat: LangChain memory provider`

---

## Phase 7: Audrey Cloud (Week 8-12)

**Why:** This is the business model. Local stays free. Cloud adds teams, dashboard, billing.

### Task 7.1: Multi-tenant server

**Files:**
- Create: `cloud/server.js` -- Hono wrapper around Audrey core
- Create: `cloud/auth.js` -- API key to tenant mapping
- Create: `cloud/billing.js` -- Usage metering
- Create: `cloud/Dockerfile`
- Create: `cloud/docker-compose.yml`

Architecture: API key maps to tenant. Each tenant gets isolated SQLite file. Postgres for tenant registry only.

- [ ] Tenant registration and API key provisioning
- [ ] Per-tenant rate limiting
- [ ] Usage metering: encode/recall/dream counts per tenant per day
- [ ] Stripe integration for billing
- [ ] Docker Compose with persistent volumes
- [ ] Commit: `feat: Audrey Cloud multi-tenant server`

### Task 7.2: Pricing

```
Free:       1 agent,   10K memories,  100 recalls/day
Pro $29:    10 agents, 100K memories, unlimited recalls, dashboard
Team $99:   50 agents, 500K memories, shared memory, RBAC
Enterprise: unlimited, audit logs, SSO, SLA, custom pricing
```

- [ ] Tier enforcement in auth middleware
- [ ] Stripe checkout for Pro/Team
- [ ] Usage dashboard showing counts vs limits
- [ ] Commit: `feat: pricing tier enforcement`

---

## Phase 8: Go-to-Market (Ongoing from Week 4)

### Task 8.1: Claude Code community launch (CRITICAL)

This is the single most important distribution move. Do it as soon as Phase 4 benchmarks are ready.

- [ ] Write dev.to article: "How I Gave Claude Code Persistent Memory in 30 Seconds"
  - Before/after: session without Audrey vs with Audrey
  - Two-command install, show greeting output, show per-prompt recall
  - Include benchmark scores
- [ ] Post to Anthropic Discord #claude-code channel
- [ ] Comment on anthropics/claude-code#14227 (persistent memory feature request)
- [ ] Submit to Hacker News: "Show HN: Audrey -- Biological Memory for AI Agents"
- [ ] Reddit: r/ClaudeAI, r/LocalLLaMA, r/MachineLearning

### Task 8.2: Comparison page

- [ ] Create docs/comparison.md -- Audrey vs Mem0 vs Letta vs Zep vs Supermemory
- [ ] Feature matrix with honest YES/NO/PARTIAL
- [ ] Price comparison ($0 vs $249/mo for Mem0 Pro graph)
- [ ] "When to choose Audrey" and "When NOT to choose Audrey"

### Task 8.3: Video demo

- [ ] 2-minute video: install, hooks, dream cycle, contradiction detection, REST API
- [ ] Post to YouTube, embed in README

---

## Known Bugs to Fix Before Phase 1

| Bug | Severity | File | Fix |
|-----|----------|------|-----|
| Fire-and-forget race on close | HIGH | src/audrey.js:200-218 | Track in-flight promises, drain before close |
| Import validation before destructive restore | HIGH | src/import.js:19-22 | Validate fields before transaction |
| Silent recall error swallowing | MEDIUM | src/recall.js:399-441 | Log errors, expose partial failure signal |
| consolidate.js raw BEGIN IMMEDIATE | MEDIUM | src/consolidate.js:196 | Use better-sqlite3 .transaction() wrapper |
| parseBody double-reject on destroy | LOW | mcp-server/serve.js:15-22 | Set rejected flag after first reject |

---

## Execution Priority

| Week | Phase | What | Business Impact |
|------|-------|------|-----------------|
| 1-2 | 1 | Multi-agent + TS types | Unlocks teams, dev adoption |
| 2-3 | 2 | Hybrid retrieval | Quality leap, benchmark boost |
| 3-4 | 3 | Relevance feedback | Self-improvement, differentiation |
| 4-5 | 4 | Standardized benchmarks | Credibility, headlines |
| 4+ | 8.1 | Claude Code community launch | DISTRIBUTION (the real bottleneck) |
| 5-6 | 5 | Memory dashboard | Visibility, wow factor |
| 6-8 | 6 | Python SDK | TAM goes from JS-only to 80% of market |
| 8-12 | 7 | Audrey Cloud | Revenue, business model |
| Ongoing | 8.2-3 | Comparison, video, content | Trust, conversion |

---

## Success Metrics

| Metric | Current | 30 Days | 90 Days |
|--------|---------|---------|---------|
| GitHub stars | 8 | 100 | 1,000 |
| npm weekly downloads | ~0 | 200 | 2,000 |
| PyPI weekly downloads | 0 | 100 | 1,000 |
| Test count | 513 | 600 | 750 |
| LoCoMo score | N/A | Published | Above Mem0 66.9% |
| Paying customers | 0 | 0 | 10 |
| MRR | $0 | $0 | $290+ |

---

## Environment Variables

```bash
AUDREY_DATA_DIR=~/.audrey/data    # Storage location
AUDREY_AGENT=claude-code          # Agent identifier
AUDREY_EMBEDDING_PROVIDER=local   # local|gemini|openai
GOOGLE_API_KEY=                   # Gemini embeddings
OPENAI_API_KEY=                   # OpenAI embeddings
AUDREY_LLM_PROVIDER=anthropic     # anthropic|openai
ANTHROPIC_API_KEY=                # Claude for consolidation
AUDREY_PORT=3487                  # REST API port
AUDREY_HOST=127.0.0.1            # Bind address
AUDREY_API_KEY=                   # Bearer token auth
AUDREY_DEVICE=gpu                 # gpu|cpu for local MiniLM
```

---

## Commands

```bash
npx audrey install                # Register MCP server
npx audrey hooks install          # Wire Claude Code hooks
npx audrey serve [port]           # Start REST API
npx audrey status [--json]        # Health check
npx audrey dream                  # Consolidation + decay
npx audrey snapshot [file]        # Export JSON
npx audrey restore <file>         # Import JSON
npx audrey reembed                # Re-embed all
npx audrey dashboard              # Open dashboard (Phase 5)
npm test                          # 513 tests
npm run bench:memory              # Run benchmarks
npm run bench:memory:check        # CI gate
```

---

**Ship working software at every phase boundary. The goal is not perfection. It is momentum.**
