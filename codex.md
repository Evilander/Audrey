# codex.md — Audrey Handoff for Codex

> This document is written for OpenAI's Codex coding agent. It provides everything you need to understand, build on, test, and ship Audrey without prior context.

## What Audrey Is

Audrey is a **biological memory system for AI agents**. It gives agents persistent, local memory that encodes, consolidates, decays, and dreams — modeled after how human brains actually process memory. Published on npm as `audrey` (v0.20.0) and PyPI as `audrey-memory` (v0.20.0).

**Not a database.** Not a RAG pipeline. Not a vector store. Audrey is a *memory layer* with biological fidelity: episodic memories consolidate into semantic principles, confidence decays over time, contradictions are tracked and resolved, emotional affect influences recall, and interference between competing memories is modeled explicitly.

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│              Audrey Core (TypeScript)             │
│  encode │ recall │ consolidate │ dream │ affect   │
│  interference │ contradiction │ decay │ causal    │
├──────────────┬───────────────┬───────────────────┤
│   MCP Server │   HTTP API    │   SDK (direct)    │
│   (stdio)    │   (Hono)      │   (import)        │
├──────────────┼───────────────┼───────────────────┤
│  Claude Code │  Python SDK   │  Node.js/TS apps  │
│  Cursor      │  LangChain    │  Vercel AI SDK    │
│  Windsurf    │  (future)     │  (future)         │
└──────────────┴───────────────┴───────────────────┘
                       │
              SQLite + sqlite-vec
              (one file, zero infrastructure)
```

### Core Invariant

**SQLite stays.** Zero-infrastructure is Audrey's deployment superpower. The entire memory store is one `.db` file. Never introduce Postgres, Redis, or any external service dependency into the core.

## File Tree

```
audrey/
├── src/                          # TypeScript source (26 modules)
│   ├── types.ts                  # 558-line shared type definitions (the type bible)
│   ├── audrey.ts                 # Main Audrey class — EventEmitter, owns all methods
│   ├── index.ts                  # Barrel re-exports (SDK entry point)
│   ├── server.ts                 # HTTP server (Hono + @hono/node-server)
│   ├── routes.ts                 # 13 REST endpoints + /health
│   ├── encode.ts                 # Episode encoding with auto-supersede
│   ├── recall.ts                 # KNN vector recall with 6-signal confidence scoring
│   ├── consolidate.ts            # Cluster episodes → extract principles (LLM or heuristic)
│   ├── decay.ts                  # Forgetting curve — dormant transition
│   ├── validate.ts               # Contradiction detection + reinforcement
│   ├── confidence.ts             # Source reliability, evidence agreement, recency decay, retrieval reinforcement
│   ├── interference.ts           # Proactive interference on semantic/procedural memories
│   ├── affect.ts                 # Valence/arousal encoding, Yerkes-Dodson, mood-congruent recall, resonance
│   ├── context.ts                # Context-match boosting at recall time
│   ├── prompts.ts                # LLM prompt builders (principle extraction, contradiction detection, causal articulation, reflection)
│   ├── causal.ts                 # Causal link graph (cause → effect with mechanism)
│   ├── db.ts                     # SQLite + sqlite-vec setup, schema, migrations (v1–v7)
│   ├── embedding.ts              # 4 providers: Mock, Local (MiniLM 384d), OpenAI (1536d), Gemini (3072d)
│   ├── llm.ts                    # 3 providers: Mock, Anthropic, OpenAI
│   ├── forget.ts                 # Soft-delete (supersede) and hard-delete (purge)
│   ├── introspect.ts             # Memory stats (counts, contradictions, consolidation runs)
│   ├── adaptive.ts               # Adaptive consolidation parameter suggestion
│   ├── rollback.ts               # Undo consolidation runs
│   ├── export.ts                 # Full memory snapshot export
│   ├── import.ts                 # Snapshot import (re-embeds on import)
│   ├── migrate.ts                # Re-embed all memories when provider/dimensions change
│   ├── ulid.ts                   # Monotonic ULID generation
│   └── utils.ts                  # Cosine similarity, JSON parse, API key validation
├── mcp-server/                   # MCP server + CLI (2 modules)
│   ├── index.ts                  # 13 MCP tools + CLI (install/uninstall/status/greeting/reflect/dream/reembed/serve)
│   └── config.ts                 # Provider resolution, VERSION constant, install args
├── python-sdk/                   # Python SDK (pip install audrey-memory)
│   ├── pyproject.toml            # Hatchling build, deps: httpx + pydantic
│   ├── src/audrey_memory/
│   │   ├── __init__.py           # Public API exports
│   │   ├── client.py             # Sync Audrey class (httpx.Client)
│   │   ├── async_client.py       # AsyncAudrey class (httpx.AsyncClient)
│   │   ├── models.py             # 14 Pydantic response models
│   │   └── py.typed              # PEP 561 marker
│   └── tests/
│       ├── test_client.py        # 19 unit tests + 5 integration tests
│       └── conftest.py           # pytest markers
├── tests/                        # Vitest test suite (31 files, 490 tests)
├── benchmarks/                   # Memory benchmark harness
│   ├── run.js                    # Runner (8 families, SVG/HTML/JSON output)
│   ├── cases.js                  # LongMemEval-style test cases
│   ├── baselines.js              # Naive baselines (keyword, recent-window, vector-only)
│   ├── reference-results.js      # Published LoCoMo numbers (MIRIX 85.4, Letta 74.0, Mem0 66.9)
│   └── report.js                 # SVG/HTML report generator
├── examples/                     # Demo scripts
│   ├── stripe-demo.js
│   ├── fintech-ops-demo.js
│   └── healthcare-ops-demo.js
├── docs/
│   ├── production-readiness.md   # Deployment guide (fintech + healthcare)
│   ├── benchmarking.md           # Benchmark methodology + research landscape
│   └── superpowers/              # Design specs + implementation plans
│       ├── specs/2026-04-10-audrey-industry-standard-design.md
│       └── plans/
├── .github/workflows/ci.yml     # CI: Node 18/20/22 Ubuntu + Windows smoke
├── tsconfig.json                 # Strict TS, Node16 module resolution, outDir: ./dist
├── vitest.config.js              # Test config (excludes stale dirs)
├── package.json                  # v0.20.0, ES modules, exports: . + ./mcp + ./server
└── codex.md                      # This file
```

## What Works End-to-End

### 1. Node.js SDK (direct import)

```typescript
import { Audrey } from 'audrey';

const brain = new Audrey({
  dataDir: './agent-memory',
  agent: 'support-agent',
  embedding: { provider: 'local', dimensions: 384 },
});

// Encode an observation
const id = await brain.encode({
  content: 'Stripe API returned 429 above 100 req/s',
  source: 'direct-observation',
  tags: ['stripe', 'rate-limit'],
  affect: { valence: -0.4, arousal: 0.7, label: 'frustration' },
});

// Recall by semantic similarity
const memories = await brain.recall('stripe rate limits', { limit: 5 });

// Consolidate + decay + stats
const dream = await brain.dream();

brain.close();
```

### 2. MCP Server (Claude Code / Cursor / Windsurf)

```bash
npx audrey install    # registers MCP server with Claude Code
npx audrey status     # check health
npx audrey greeting   # session briefing (for hooks)
npx audrey reflect    # form memories from conversation (for hooks)
npx audrey dream      # consolidation + decay cycle
npx audrey serve      # start HTTP API on port 7437
```

13 MCP tools: `memory_encode`, `memory_recall`, `memory_consolidate`, `memory_dream`, `memory_introspect`, `memory_resolve_truth`, `memory_export`, `memory_import`, `memory_forget`, `memory_decay`, `memory_status`, `memory_reflect`, `memory_greeting`.

### 3. HTTP API

```bash
npx audrey serve                    # starts on :7437
AUDREY_API_KEY=secret npx audrey serve  # with auth

curl http://localhost:7437/health
curl -X POST http://localhost:7437/v1/encode \
  -H 'Content-Type: application/json' \
  -d '{"content":"test","source":"direct-observation"}'
curl -X POST http://localhost:7437/v1/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"test"}'
```

14 endpoints: `GET /health`, `POST /v1/encode`, `POST /v1/recall`, `POST /v1/consolidate`, `POST /v1/dream`, `GET /v1/introspect`, `POST /v1/resolve-truth`, `GET /v1/export`, `POST /v1/import`, `POST /v1/forget`, `POST /v1/decay`, `GET /v1/status`, `POST /v1/reflect`, `POST /v1/greeting`.

### 4. Python SDK

```python
from audrey_memory import Audrey

brain = Audrey(base_url="http://localhost:7437")
result = brain.encode(content="test", source="direct-observation")
memories = brain.recall("test", limit=5)
brain.close()

# Async
from audrey_memory import AsyncAudrey
async with AsyncAudrey() as brain:
    await brain.encode(content="test", source="direct-observation")
```

Requires `npx audrey serve` running. `pip install audrey-memory`.

## How to Build, Test, and Validate

```bash
# Install
npm ci

# Build TypeScript → dist/
npm run build

# Type check (no emit)
npm run typecheck

# Run all 490 tests (auto-builds first via pretest)
npm test

# Run benchmark harness (regression gate)
npm run bench:memory:check

# Check what ships in the npm tarball
npm run pack:check

# Python SDK tests (separate)
cd python-sdk
pip install -e ".[dev]"
pytest -m "not integration" -v
```

**All of these must pass before any release.** CI runs: build → typecheck → test → bench:memory:check → pack:check on Node 18, 20, 22 (Ubuntu) + Node 20 (Windows).

## Key Design Patterns

### Confidence Scoring (6 signals)

Every recalled memory gets a confidence score computed from:

1. **Source reliability** — direct-observation (0.95) > told-by-user (0.90) > tool-result (0.85) > inference (0.60) > model-generated (0.40)
2. **Evidence agreement** — supporting vs. contradicting evidence ratio
3. **Recency decay** — exponential decay with type-specific half-lives (episodic: 7d, semantic: 30d, procedural: 90d)
4. **Retrieval reinforcement** — recalled memories strengthen (spaced repetition bonus)
5. **Interference** — competing memories reduce confidence
6. **Context match** — memories encoded in matching context get boosted

Final score = `similarity × confidence`. Model-generated memories are hard-capped at 0.6 confidence.

See `src/confidence.ts` and `src/recall.ts`.

### Memory Lifecycle

```
Episode encoded → validate (reinforce or contradict existing semantics)
                → interference applied to nearby semantics/procedures
                → affect resonance detected with emotionally similar episodes
                      ↓
              dream() called
                      ↓
              consolidate: cluster similar episodes → extract principles (semantic/procedural)
              decay: evaluate confidence → transition low-confidence to dormant
                      ↓
              recall: KNN search → confidence scoring → result guards → deduplication
```

### Embedding Provider Pattern

All 4 embedding providers implement the `EmbeddingProvider` interface (`src/types.ts:~line 280`):

```typescript
interface EmbeddingProvider {
  dimensions: number;
  modelName: string;
  modelVersion: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
  bufferToVector(buffer: Buffer): number[];
  ready?(): Promise<void>;
}
```

To add a new provider: create a class implementing this interface, add it to the `createEmbeddingProvider` switch in `src/embedding.ts`, add the provider name to the `EmbeddingConfig.provider` union in `src/types.ts`.

### LLM Provider Pattern

Same pattern. 3 providers implement `LLMProvider` (`src/types.ts`):

```typescript
interface LLMProvider {
  modelName: string;
  modelVersion: string;
  complete(messages: ChatMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult>;
  json(messages: ChatMessage[], options?: LLMCompletionOptions): Promise<unknown>;
}
```

To add a new provider: create a class, add to `createLLMProvider` in `src/llm.ts`, add to `LLMConfig.provider` union.

### Database Schema

SQLite with sqlite-vec. 8 tables:

- `episodes` — raw events/observations (the hippocampus)
- `semantics` — consolidated principles (the neocortex)
- `procedures` — learned workflows (the cerebellum)
- `causal_links` — cause → effect relationships
- `contradictions` — conflicting claims (open/resolved/context_dependent/reopened)
- `consolidation_runs` — history of consolidation operations
- `consolidation_metrics` — parameter tuning data
- `audrey_config` — key-value config (schema_version, dimensions)

Plus 3 vec0 virtual tables for KNN search: `vec_episodes`, `vec_semantics`, `vec_procedures`.

Schema is in `src/db.ts`. Migrations are in the `MIGRATIONS` array (currently v1–v7).

## Required Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AUDREY_DATA_DIR` | No | `~/.audrey/data` | SQLite database location |
| `AUDREY_EMBEDDING_PROVIDER` | No | auto-detect | `mock`, `local`, `gemini`, `openai` |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | No | — | Enables Gemini embeddings (3072d) |
| `OPENAI_API_KEY` | No | — | Enables OpenAI embeddings (1536d) if explicitly selected |
| `ANTHROPIC_API_KEY` | No | — | Enables LLM-powered consolidation and reflection |
| `AUDREY_LLM_PROVIDER` | No | auto-detect | `mock`, `anthropic`, `openai` |
| `AUDREY_DEVICE` | No | `gpu` | Local embedding device (`gpu` or `cpu`) |
| `AUDREY_PORT` | No | `7437` | HTTP API server port |
| `AUDREY_API_KEY` | No | — | Bearer token for HTTP API auth |
| `AUDREY_AGENT` | No | `claude-code` | Agent name for MCP server |

Auto-detection priority: `GOOGLE_API_KEY` → Gemini embeddings; `ANTHROPIC_API_KEY` → Anthropic LLM; no keys → local embeddings (384d, offline).

## Next Tasks (Prioritized)

These are from the approved roadmap in `docs/superpowers/specs/2026-04-10-audrey-industry-standard-design.md`.

### v0.21: LoCoMo Benchmark Adapter (HIGH PRIORITY)

**Why:** Audrey currently has an internal benchmark (100% score, 43.8 points ahead of baselines). But there's no direct reproduction of the LoCoMo benchmark protocol, which is what Mem0 (66.9), Letta (74.0), and MIRIX (85.4) report against. Publishing a LoCoMo number is the single biggest credibility move for the research community.

**What to build:**
- Adapter in `benchmarks/locomo/` that runs the [LoCoMo protocol](https://github.com/snap-research/locomo) against Audrey
- Maps LoCoMo evaluation categories to Audrey encode/recall/consolidate operations
- Uses real embedding provider (Gemini or OpenAI) for meaningful scores
- CI gate: `npm run bench:locomo` fails if score drops
- Target: beat Mem0 (66.9), approach Letta (74.0)

**Acceptance criteria:**
- Reproducible LoCoMo score published in README
- CI regression gate
- Methodology documented for independent reproduction

### v0.22: MCP Ecosystem Expansion

**What to build:**
- Test and document Audrey with Cursor, Windsurf, VS Code Copilot, JetBrains
- Per-host installation guides in docs/
- MCP resource endpoints (browsable memory stats, not just tools)
- MCP prompt templates
- Submit to Anthropic MCP server directory

### v0.23: LangChain Integration

**What to build:**
- `audrey-langchain` package (npm + PyPI)
- Implements LangChain's `BaseMemory` / `BaseChatMemory` interface
- Works with LangGraph agents
- Example: "Add biological memory to a LangGraph agent"

### v0.24: Vercel AI SDK Integration

**What to build:**
- `audrey-ai-sdk` package
- Tool definitions for Vercel AI SDK `tool()` interface
- Memory-aware middleware (auto-encode turns, auto-recall context)

### v0.25: Encryption at Rest

**What to build:**
- SQLCipher option (full-database encryption, optional peer dep)
- Application-level AES-256-GCM (content fields only, embeddings stay unencrypted)
- `npx audrey encrypt` migration tool
- Key management via env var or callback

### v0.26–v0.31 and 1.0

See `docs/superpowers/specs/2026-04-10-audrey-industry-standard-design.md` for the full roadmap through 1.0.

## Known Bugs / Tech Debt

1. **Windows EPERM in schema-migration tests** — `tests/schema-migration.test.js` has 4 failing tests on some Windows configurations due to SQLite file locking (`rmSync` on open DB). Works fine on CI (Ubuntu + Windows-latest). Low priority — the tests work in CI.

2. **VERSION constant duplication** — `mcp-server/config.ts` has a hardcoded `VERSION` string that must be manually synced with `package.json`. Should derive from package.json at build time.

3. **Stale directory copies** — `Audrey/`, `Audrey-release/`, `.tmp-release-head-20260330/` are leftover release artifacts in the repo root. They're gitignored from test discovery but should be cleaned up.

4. **`export.ts` package.json path** — Uses `../../package.json` (relative to `dist/src/`) to read version. Fragile if the build output structure changes. Should use a build-time constant instead.

5. **Python SDK requires running server** — The Python SDK is an HTTP client, not a native implementation. Users must run `npx audrey serve` separately. A native Python port is planned post-1.0 if demand warrants it.

6. **No OpenAPI spec** — The HTTP API has no auto-generated OpenAPI documentation. The Zod schemas exist and could generate one via `@hono/zod-openapi`, but it's not wired up yet.

7. **Benchmark uses mock embeddings** — The internal benchmark runs with mock embeddings (deterministic hashes, 64d). Real embedding providers would produce different (likely better) scores. The LoCoMo adapter (v0.21) will address this.

## How to Add Providers

### New Embedding Provider

1. Create a class in `src/embedding.ts` implementing `EmbeddingProvider`
2. Add the provider name to the switch in `createEmbeddingProvider()`
3. Add the provider name to `EmbeddingConfig.provider` union in `src/types.ts`
4. Add dimension default to `defaultEmbeddingDimensions()` in `mcp-server/config.ts`
5. Add auto-detection logic to `resolveEmbeddingProvider()` in `mcp-server/config.ts` (if applicable)
6. Write tests in `tests/embedding.test.js`

### New LLM Provider

1. Create a class in `src/llm.ts` implementing `LLMProvider`
2. Add to `createLLMProvider()` switch
3. Add to `LLMConfig.provider` union in `src/types.ts`
4. Add auto-detection to `resolveLLMProvider()` in `mcp-server/config.ts`
5. Write tests in `tests/llm.test.js`

### New HTTP Endpoint

1. Add route to `src/routes.ts` following the existing pattern
2. Add test to `tests/http-api.test.js`
3. Add corresponding method to Python SDK clients (`python-sdk/src/audrey_memory/client.py` and `async_client.py`)
4. Add Pydantic model to `python-sdk/src/audrey_memory/models.py` if new response shape

### New MCP Tool

1. Add tool registration in the `main()` function of `mcp-server/index.ts`
2. Define Zod schema for the tool inputs
3. Add test to `tests/mcp-server.test.js`
4. Update the tool count in README and install output

## Testing Patterns

Tests use vitest with mock embeddings (8d) and temp directories:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-myfeature-data';

describe('my feature', () => {
  let db, embedding;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('does the thing', async () => {
    // test code
  });
});
```

Key rules:
- Always use `dimensions: 8` and `MockEmbeddingProvider` in tests
- Always clean up temp dirs in `afterEach`
- Always close the database in `afterEach`
- Import from `../dist/src/` (tests are JS, source is TS)
- Use unique `TEST_DIR` names to avoid conflicts with parallel test files

## Competitive Context

| System | LoCoMo Score | Model | Status |
|---|---|---|---|
| **MIRIX** | 85.4 | Typed multimodal memory | Research paper only, no production package |
| **Letta** | 74.0 | Context engineering (editable blocks) | Production, VC-funded |
| **Audrey** | ~70 (est.) | Biological memory (encode→consolidate→decay→dream) | Production, solo developer |
| **Mem0 Graph** | 68.5 | Graph memory | Production, VC-funded |
| **Mem0** | 66.9 | Key-value + retrieval | Production, VC-funded |
| **OpenAI Memory** | 52.9 | Black-box hosted | ChatGPT only |

Audrey's moat: biological fidelity (affect + interference + consolidation + dreaming) that no competitor has replicated. The competitive risk is that Mem0 and Letta have funding and developer reach. The strategy is to win on developer gravity (TypeScript types, Python SDK, MCP presence) and then on research credibility (LoCoMo benchmark, published paper).

## Release Process

1. Work on a feature branch (e.g., `git checkout -b feature-name`)
2. Build, typecheck, test, benchmark on the branch
3. Merge to master with `--no-ff`
4. Tag: `git tag v0.X.0`
5. Bump VERSION in `mcp-server/config.ts` and `package.json`
6. If Python SDK changed, bump version in `python-sdk/pyproject.toml`
7. Publish: `npm publish` (Node.js) and `cd python-sdk && python -m build && twine upload dist/*` (Python)

## Codex-Specific Notes

### Working with this codebase

- **TypeScript with Node16 resolution.** All import paths use `.js` extensions even for `.ts` files. This is correct — TypeScript resolves `.js` to `.ts` during compilation.
- **Build before testing.** Tests import from `dist/`, not `src/`. Always `npm run build` first (the `pretest` script does this automatically).
- **Strict mode.** `noUncheckedIndexedAccess` is on — array indexing returns `T | undefined`. Use `!` assertion when bounds are guaranteed.
- **ES modules only.** No CommonJS. `"type": "module"` in package.json.
- **Zod v4.** Uses `z.record(z.string(), z.string())` (key+value schemas required), not the v3 single-arg form.

### Prompting best practices for this repo

- When modifying TypeScript source, always run `npm run build && npm run typecheck` after changes.
- When adding tests, follow the pattern in `tests/encode.test.js` — temp dir, mock embedding, cleanup.
- When touching the HTTP API, update both `src/routes.ts` and `tests/http-api.test.js`.
- When modifying the Python SDK, keep sync and async clients in lockstep — every method must exist in both.
- When changing the confidence model or recall logic, run `npm run bench:memory:check` to verify no regression.
- The `src/types.ts` file is the single source of truth for all TypeScript types. Add new types there, not inline.
- The `mcp-server/config.ts` VERSION constant must match `package.json` version. Update both.
