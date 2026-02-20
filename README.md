# Audrey

Biological memory architecture for AI agents. Gives agents cognitive memory that decays, consolidates, self-validates, and learns from experience — not just a database.


## Why Audrey Exists

Every AI memory tool today (Mem0, Zep, LangChain Memory) is a filing cabinet. Store stuff, retrieve stuff. None of them do what biological memory actually does:

- Memories don't decay. A fact from 6 months ago has the same weight as one from today.
- No consolidation. Raw events never become general principles.
- No contradiction detection. Conflicting facts coexist silently.
- No self-defense. If an agent hallucinates and encodes the hallucination, it becomes "truth."

Audrey fixes all of this by modeling memory the way the brain does:

| Brain Structure | Audrey Component | What It Does |
|---|---|---|
| Hippocampus | Episodic Memory | Fast capture of raw events and observations |
| Neocortex | Semantic Memory | Consolidated principles and patterns |
| Sleep Replay | Consolidation Engine | Extracts patterns from episodes, promotes to principles |
| Prefrontal Cortex | Validation Engine | Truth-checking, contradiction detection |
| Amygdala | Salience Scorer | Importance weighting for retention priority |

## Install

### MCP Server for Claude Code (one command)

```bash
npx audrey install
```

That's it. Audrey auto-detects API keys from your environment:

- `OPENAI_API_KEY` set? Uses real OpenAI embeddings (1536d) for semantic search.
- `ANTHROPIC_API_KEY` set? Enables LLM-powered consolidation and contradiction detection.
- Neither? Runs with mock embeddings — fully functional, upgrade anytime.

To upgrade later, set the keys and re-run `npx audrey install`.

```bash
# Check status
npx audrey status

# Uninstall
npx audrey uninstall
```

Every Claude Code session now has 5 memory tools: `memory_encode`, `memory_recall`, `memory_consolidate`, `memory_introspect`, `memory_resolve_truth`.

### SDK in Your Code

```bash
npm install audrey
```

Zero external infrastructure. One SQLite file.

## Usage

```js
import { Audrey } from 'audrey';

// 1. Create a brain
const brain = new Audrey({
  dataDir: './agent-memory',
  agent: 'my-agent',
  embedding: { provider: 'mock', dimensions: 8 },  // or 'openai' for production
});

// 2. Encode observations
await brain.encode({
  content: 'Stripe API returns 429 above 100 req/s',
  source: 'direct-observation',
  tags: ['stripe', 'rate-limit'],
});

// 3. Recall what you know
const memories = await brain.recall('stripe rate limits', { limit: 5 });
// Returns: [{ content, type, confidence, score, ... }]

// 4. Consolidate episodes into principles (the "sleep" cycle)
await brain.consolidate();

// 5. Check brain health
const stats = brain.introspect();
// { episodic: 47, semantic: 12, procedural: 3, dormant: 8, ... }

// 6. Clean up
brain.close();
```

### Configuration

```js
const brain = new Audrey({
  dataDir: './audrey-data',     // SQLite database directory
  agent: 'my-agent',           // Agent identifier

  // Embedding provider (required)
  embedding: {
    provider: 'mock',          // 'mock' for testing, 'openai' for production
    dimensions: 8,             // 8 for mock, 1536 for openai text-embedding-3-small
    apiKey: '...',             // Required for openai
  },

  // LLM provider (optional — enables smart consolidation + contradiction detection)
  llm: {
    provider: 'anthropic',     // 'mock', 'anthropic', or 'openai'
    apiKey: '...',             // Required for anthropic/openai
    model: 'claude-sonnet-4-6', // Optional model override
  },

  // Consolidation settings
  consolidation: {
    minEpisodes: 3,            // Minimum cluster size for principle extraction
  },

  // Decay settings
  decay: {
    dormantThreshold: 0.1,     // Below this confidence = dormant
  },
});
```

**Without an LLM provider**, consolidation uses a default text-based extractor and contradiction detection is similarity-only. **With an LLM provider**, Audrey extracts real generalized principles, detects semantic contradictions, and resolves context-dependent truths.

### Environment Variables (MCP Server)

| Variable | Default | Purpose |
|---|---|---|
| `AUDREY_DATA_DIR` | `~/.audrey/data` | SQLite database directory |
| `AUDREY_AGENT` | `claude-code` | Agent identifier |
| `AUDREY_EMBEDDING_PROVIDER` | `mock` | `mock` or `openai` |
| `AUDREY_EMBEDDING_DIMENSIONS` | `8` | Vector dimensions (1536 for openai) |
| `OPENAI_API_KEY` | — | Required when embedding/LLM provider is openai |
| `AUDREY_LLM_PROVIDER` | — | `mock`, `anthropic`, or `openai` |
| `ANTHROPIC_API_KEY` | — | Required when LLM provider is anthropic |

## Core Concepts

### Four Memory Types

**Episodic** (hot, fast decay) — Raw events. "Stripe returned 429 at 3pm." Immutable. Append-only. Never modified.

**Semantic** (warm, slow decay) — Consolidated principles. "Stripe enforces 100 req/s rate limit." Extracted automatically from clusters of episodic memories.

**Procedural** (cold, slowest decay) — Learned workflows. "When Stripe rate-limits, implement exponential backoff." Skills the agent has acquired.

**Causal** — Why things happened. Not just "A then B" but "A caused B because of mechanism C." Prevents correlation-as-causation.

### Confidence Formula

Every memory has a compositional confidence score:

```
C(m, t) = w_s * S + w_e * E + w_r * R(t) + w_ret * Ret(t)
```

| Component | What It Measures | Default Weight |
|---|---|---|
| **S** — Source reliability | How trustworthy is the origin? | 0.30 |
| **E** — Evidence agreement | Do observations agree or contradict? | 0.35 |
| **R(t)** — Recency decay | How old is the memory? (Ebbinghaus curve) | 0.20 |
| **Ret(t)** — Retrieval reinforcement | How often is this memory accessed? | 0.15 |

Source reliability hierarchy:

| Source Type | Reliability |
|---|---|
| `direct-observation` | 0.95 |
| `told-by-user` | 0.90 |
| `tool-result` | 0.85 |
| `inference` | 0.60 |
| `model-generated` | 0.40 (capped at 0.6 confidence) |

The `model-generated` cap prevents circular self-confirmation — an agent can't boost its own hallucinations into high-confidence "facts."

### Decay (Forgetting Curves)

Unreinforced memories lose confidence over time following Ebbinghaus exponential decay:

| Memory Type | Half-Life | Rationale |
|---|---|---|
| Episodic | 7 days | Raw events go stale fast |
| Semantic | 30 days | Principles are hard-won |
| Procedural | 90 days | Skills are slowest to forget |

Retrieval resets the decay clock. Frequently accessed memories persist. Memories below the dormant threshold (0.1) become dormant — still searchable with `includeDormant: true`, but excluded from default recall.

### Consolidation (The "Sleep" Cycle)

Audrey's consolidation engine periodically clusters similar episodic memories and extracts general principles:

```
3 episodes about Stripe 429 errors
  → 1 semantic principle: "Stripe enforces ~100 req/s rate limit"
```

The pipeline: **Cluster** (embedding similarity) → **Extract** (LLM or callback) → **Validate** (check for contradictions) → **Promote** (write semantic memory) → **Audit** (log everything).

Consolidation is idempotent. Re-running on the same data produces no duplicates. Every run creates an audit record with input/output IDs for full traceability.

### Contradiction Handling

When memories conflict, Audrey doesn't force a winner. Contradictions have a lifecycle:

```
open → resolved | context_dependent | reopened
```

Context-dependent truths are modeled explicitly:

```js
// "Stripe rate limit is 100 req/s" (live keys)
// "Stripe rate limit is 25 req/s" (test keys)
// Both true — under different conditions
```

New high-confidence evidence can reopen resolved disputes.

### Rollback

Bad consolidation? Undo it:

```js
const history = brain.consolidationHistory();
brain.rollback(history[0].id);
// Semantic memories → rolled_back state
// Source episodes → un-consolidated
// Full audit trail preserved
```

### Circular Self-Confirmation Defense

The most dangerous exploit in AI memory: agent hallucinates X, encodes it, later retrieves it, "reinforcement" boosts confidence, X eventually consolidates as "established truth."

Audrey's defenses:

1. **Source diversity requirement** — Consolidation requires evidence from 2+ distinct source types
2. **Model-generated cap** — Memories from `model-generated` sources are capped at 0.6 confidence
3. **Source lineage tracking** — Provenance chains detect when all evidence traces back to a single inference
4. **Source diversity score** — Every semantic memory tracks how many different source types contributed

## API Reference

### `new Audrey(config)`

See [Configuration](#configuration) above for all options.

### `brain.encode(params)` → `Promise<string>`

Encode an episodic memory. Returns the memory ID.

```js
const id = await brain.encode({
  content: 'What happened',          // Required. Non-empty string.
  source: 'direct-observation',      // Required. See source types above.
  salience: 0.8,                     // Optional. 0-1. Default: 0.5
  causal: {                          // Optional. What caused this / what it caused.
    trigger: 'batch-processing',
    consequence: 'queue-backed-up',
  },
  tags: ['stripe', 'production'],    // Optional. Array of strings.
  supersedes: 'previous-id',         // Optional. ID of episode this corrects.
});
```

Episodes are **immutable**. Corrections create new records with `supersedes` links. The original is preserved.

### `brain.recall(query, options)` → `Promise<Memory[]>`

Retrieve memories ranked by `similarity * confidence`.

```js
const memories = await brain.recall('stripe rate limits', {
  minConfidence: 0.5,            // Filter below this confidence
  types: ['semantic'],           // Filter by memory type
  limit: 5,                     // Max results
  includeProvenance: true,       // Include evidence chains
  includeDormant: false,         // Include dormant memories
});
```

Each result:

```js
{
  id: '01ABC...',
  content: 'Stripe enforces ~100 req/s rate limit',
  type: 'semantic',
  confidence: 0.87,
  score: 0.74,          // similarity * confidence
  source: 'consolidation',
  state: 'active',
  provenance: {         // When includeProvenance: true
    evidenceEpisodeIds: ['01XYZ...', '01DEF...'],
    evidenceCount: 3,
    supportingCount: 3,
    contradictingCount: 0,
  },
}
```

Retrieval automatically reinforces matched memories (boosts confidence, resets decay clock).

### `brain.encodeBatch(paramsList)` → `Promise<string[]>`

Encode multiple episodes in one call. Same params as `encode()`, but as an array.

```js
const ids = await brain.encodeBatch([
  { content: 'Stripe returned 429', source: 'direct-observation' },
  { content: 'Redis timed out', source: 'tool-result' },
  { content: 'User reports slow checkout', source: 'told-by-user' },
]);
```

### `brain.recallStream(query, options)` → `AsyncGenerator<Memory>`

Streaming version of `recall()`. Yields results one at a time. Supports early `break`.

```js
for await (const memory of brain.recallStream('stripe issues', { limit: 10 })) {
  console.log(memory.content, memory.score);
  if (memory.score > 0.9) break;
}
```

### `brain.consolidate(options)` → `Promise<ConsolidationResult>`

Run the consolidation engine manually.

```js
const result = await brain.consolidate({
  minClusterSize: 3,
  similarityThreshold: 0.80,
  extractPrinciple: (episodes) => ({    // Optional LLM callback
    content: 'Extracted principle text',
    type: 'semantic',
  }),
});
// { runId, status, episodesEvaluated, clustersFound, principlesExtracted }
```

### `brain.decay(options)` → `DecayResult`

Apply forgetting curves. Transitions low-confidence memories to dormant.

```js
const result = brain.decay({ dormantThreshold: 0.1 });
// { totalEvaluated, transitionedToDormant, timestamp }
```

### `brain.rollback(runId)` → `RollbackResult`

Undo a consolidation run.

```js
brain.rollback('01ABC...');
// { rolledBackMemories: 3, restoredEpisodes: 9 }
```

### `brain.resolveTruth(contradictionId)` → `Promise<Resolution>`

Resolve an open contradiction using LLM reasoning. Requires an LLM provider configured.

```js
const resolution = await brain.resolveTruth('contradiction-id');
// { resolution: 'context_dependent', conditions: { a: 'live keys', b: 'test keys' }, explanation: '...' }
```

### `brain.introspect()` → `Stats`

Get memory system health stats.

```js
brain.introspect();
// {
//   episodic: 247, semantic: 31, procedural: 8,
//   causalLinks: 42, dormant: 15,
//   contradictions: { open: 2, resolved: 7, context_dependent: 3, reopened: 0 },
//   lastConsolidation: '2026-02-18T22:00:00Z',
//   totalConsolidationRuns: 14,
// }
```

### `brain.consolidationHistory()` → `ConsolidationRun[]`

Full audit trail of all consolidation runs.

### Events

```js
brain.on('encode', ({ id, content, source }) => { ... });
brain.on('reinforcement', ({ episodeId, targetId, similarity }) => { ... });
brain.on('contradiction', ({ episodeId, contradictionId, semanticId, resolution }) => { ... });
brain.on('consolidation', ({ runId, principlesExtracted }) => { ... });
brain.on('decay', ({ totalEvaluated, transitionedToDormant }) => { ... });
brain.on('rollback', ({ runId, rolledBackMemories }) => { ... });
brain.on('error', (err) => { ... });
```

### `brain.close()`

Close the database connection and stop auto-consolidation.

## Architecture

```
audrey-data/
  audrey.db          ← Single SQLite file. WAL mode. That's your brain.
```

```
src/
  audrey.js          Main class. EventEmitter. Public API surface.
  causal.js          Causal graph management. LLM-powered mechanism articulation.
  confidence.js      Compositional confidence formula. Pure math.
  consolidate.js     "Sleep" cycle. KNN clustering → LLM extraction → promote.
  db.js              SQLite + sqlite-vec. Schema, vec0 tables, migrations.
  decay.js           Ebbinghaus forgetting curves.
  embedding.js       Pluggable providers (Mock, OpenAI). Batch embedding.
  encode.js          Immutable episodic memory creation + vec0 writes.
  introspect.js      Health dashboard queries.
  llm.js             Pluggable LLM providers (Mock, Anthropic, OpenAI).
  prompts.js         Structured prompt templates for LLM operations.
  recall.js          KNN retrieval + confidence scoring + async streaming.
  rollback.js        Undo consolidation runs.
  utils.js           Date math, safe JSON parse.
  validate.js        KNN validation + LLM contradiction detection.
  index.js           Barrel export.

mcp-server/
  index.js           MCP tool server (5 tools, stdio transport) + CLI subcommands.
  config.js          Shared config (env var parsing, install arg builder).
```

### Database Schema

| Table | Purpose |
|---|---|
| `episodes` | Immutable raw events (content, source, salience, causal context) |
| `semantics` | Consolidated principles (content, state, evidence chain) |
| `procedures` | Learned workflows (trigger conditions, success/failure counts) |
| `causal_links` | Causal relationships (cause, effect, mechanism, link type) |
| `contradictions` | Dispute tracking (claims, state, resolution) |
| `consolidation_runs` | Audit trail (inputs, outputs, status) |
| `vec_episodes` | sqlite-vec KNN index for episode embeddings |
| `vec_semantics` | sqlite-vec KNN index for semantic embeddings |
| `vec_procedures` | sqlite-vec KNN index for procedural embeddings |
| `audrey_config` | Dimension configuration and metadata |

All mutations use SQLite transactions. CHECK constraints enforce valid states and source types. Vector search uses sqlite-vec with cosine distance.

## Running Tests

```bash
npm test          # 194 tests across 17 files
npm run test:watch
```

## Running the Demo

```bash
node examples/stripe-demo.js
```

Demonstrates the full pipeline: encode 3 rate-limit observations → consolidate into principle → recall proactively.

---

## Roadmap

### v0.1.0 — Foundation

- [x] Immutable episodic memory with append-only records
- [x] Compositional confidence formula (source + evidence + recency + retrieval)
- [x] Ebbinghaus-inspired forgetting curves with configurable half-lives
- [x] Dormancy transitions for low-confidence memories
- [x] Confidence-weighted recall across episodic/semantic/procedural types
- [x] Provenance chains (which episodes contributed to which principles)
- [x] Retrieval reinforcement (frequently accessed memories resist decay)
- [x] Consolidation engine with clustering and principle extraction
- [x] Idempotent consolidation with checkpoint cursors
- [x] Full consolidation audit trail (input/output IDs per run)
- [x] Consolidation rollback (undo bad runs, restore episodes)
- [x] Contradiction lifecycle (open/resolved/context_dependent/reopened)
- [x] Circular self-confirmation defense (model-generated cap at 0.6)
- [x] Source type diversity tracking on semantic memories
- [x] Supersedes links for correcting episodic memories
- [x] Pluggable embedding providers (Mock for tests, OpenAI for production)
- [x] Causal context storage (trigger/consequence per episode)
- [x] Introspection API (memory counts, contradiction stats, consolidation history)
- [x] EventEmitter lifecycle hooks (encode, reinforcement, consolidation, decay, rollback, error)
- [x] SQLite with WAL mode, CHECK constraints, indexes, foreign keys
- [x] Transaction safety on all multi-step mutations
- [x] Input validation on public API (content, salience, tags, source)
- [x] Shared utility extraction (cosine similarity, date math, safe JSON parse)
- [x] 104 tests across 12 test files
- [x] Proof-of-concept demo (Stripe rate limit scenario)

### v0.2.0 — LLM Integration

- [x] LLM-powered principle extraction (replace callback with Anthropic/OpenAI calls)
- [x] LLM-based contradiction detection during validation
- [x] Causal mechanism articulation via LLM (not just trigger/consequence)
- [x] Spurious correlation detection (require mechanistic explanation for causal links)
- [x] Context-dependent truth resolution via LLM
- [x] Configurable LLM provider for consolidation (Mock, Anthropic, OpenAI)
- [x] Structured prompt templates for all LLM operations
- [x] 142 tests across 15 test files

### v0.3.0 — Vector Performance

- [x] sqlite-vec native vector indexing (vec0 virtual tables with cosine distance)
- [x] KNN queries for recall, validation, and consolidation clustering (all vector math in C)
- [x] SQL-native metadata filtering in KNN (state, source, consolidated)
- [x] Batch encoding API (`encodeBatch` — encode N episodes in one call)
- [x] Streaming recall with async generators (`recallStream`)
- [x] Dimension configuration and mismatch validation
- [x] Automatic migration from v0.2.0 embedding BLOBs to vec0 tables
- [x] 168 tests across 16 test files

### v0.3.1 — MCP Server (current)

- [x] MCP tool server via `@modelcontextprotocol/sdk` with stdio transport
- [x] 5 tools: `memory_encode`, `memory_recall`, `memory_consolidate`, `memory_introspect`, `memory_resolve_truth`
- [x] Configuration via environment variables (data dir, embedding provider, LLM provider)
- [x] One-command install: `npx audrey install` (auto-detects API keys)
- [x] CLI subcommands: `install`, `uninstall`, `status`
- [x] 194 tests across 17 test files

### v0.3.5 — Embedding Migration (deferred from v0.3.0)

- [ ] Embedding migration pipeline (re-embed when models change)
- [ ] Re-consolidation queue (re-run consolidation with new embedding model)

### v0.4.0 — Type Safety & Developer Experience

- [ ] Full TypeScript conversion with strict mode
- [ ] JSDoc types on all exports (interim before TS conversion)
- [ ] Published type declarations (.d.ts)
- [ ] Schema versioning and migration system
- [ ] Structured logging (optional, pluggable)
- [ ] npm publish with proper package metadata

### v0.5.0 — Advanced Memory Features

- [ ] Adaptive consolidation threshold (learn optimal N per domain, not fixed N=3)
- [ ] Source-aware confidence for semantic memories (track strongest source composition)
- [ ] Configurable decay rates per Audrey instance
- [ ] Configurable confidence weights per Audrey instance
- [ ] PII detection and redaction (opt-in)
- [ ] Memory export/import (JSON snapshot)
- [ ] Auto-consolidation scheduling (setInterval with configurable interval)

### v0.6.0 — Scale

- [ ] pgvector adapter for PostgreSQL backend
- [ ] Redis adapter for distributed caching
- [ ] Connection pooling for concurrent agent access
- [ ] Pagination on recall queries (cursor-based)
- [ ] Benchmarks: encode throughput, recall latency at 10k/100k/1M memories

### v1.0.0 — Production Ready

- [ ] Comprehensive error handling at all boundaries
- [ ] Rate limiting on embedding API calls
- [ ] Memory usage profiling and optimization
- [ ] Security audit (injection, data isolation)
- [ ] Cross-agent knowledge sharing protocol (Hivemind)
- [ ] Documentation site
- [ ] Integration guides (LangChain, CrewAI, Claude Code, custom agents)

## Design Decisions

**Why SQLite, not Postgres?** Zero infrastructure. `npm install` and you have a brain. The adapter pattern means you can migrate to pgvector when you need to scale.

**Why append-only episodes?** Immutability creates a reliable audit trail. Corrections use `supersedes` links rather than mutations. You can always trace back to what actually happened.

**Why Ebbinghaus curves?** Biological forgetting is an adaptive feature, not a bug. It prevents cognitive overload, maintains relevance, and enables generalization. Audrey's forgetting works the same way.

**Why model-generated cap at 0.6?** Prevents the most dangerous exploit in AI memory: circular self-confirmation where an agent's own inferences bootstrap themselves into high-confidence "facts" through repeated retrieval.

**Why no TypeScript yet?** Prototyping speed. TypeScript conversion is on the roadmap for v0.4.0. The pure-math modules (`confidence.js`, `utils.js`) are already type-safe in practice.

## License

MIT
