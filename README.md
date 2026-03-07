# Audrey

Biological memory architecture for AI agents. Memory that decays, consolidates, feels, and learns — not just a database.

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
| Amygdala | Affect System | Emotional encoding, arousal-salience coupling, mood-congruent recall |

## Install

### MCP Server for Claude Code (one command)

```bash
npx audrey install
```

That's it. Audrey auto-detects API keys from your environment:

- `GOOGLE_API_KEY` or `GEMINI_API_KEY` set? Uses Gemini embeddings (3072d).
- `ANTHROPIC_API_KEY` set? Enables LLM-powered consolidation and contradiction detection.
- Neither? Runs with local embeddings (384d) for semantic search.

To switch providers later, set the relevant env vars and re-run `npx audrey install`, or set `AUDREY_EMBEDDING_PROVIDER=openai` for explicit OpenAI embeddings.

```bash
# Check status
npx audrey status

# Uninstall
npx audrey uninstall
```

Every Claude Code session now has 9 memory tools: `memory_encode`, `memory_recall`, `memory_consolidate`, `memory_introspect`, `memory_resolve_truth`, `memory_export`, `memory_import`, `memory_forget`, `memory_decay`.

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

// 2. Encode observations — with optional emotional context
await brain.encode({
  content: 'Stripe API returns 429 above 100 req/s',
  source: 'direct-observation',
  tags: ['stripe', 'rate-limit'],
  affect: { valence: -0.4, arousal: 0.7, label: 'frustration' },
});

// 3. Recall what you know — mood-congruent retrieval
const memories = await brain.recall('stripe rate limits', {
  limit: 5,
  mood: { valence: -0.3 },  // frustrated right now? memories encoded in frustration surface first
});

// 4. Filtered recall — by tag, source, or date range
const recent = await brain.recall('stripe', {
  tags: ['rate-limit'],
  sources: ['direct-observation'],
  after: '2026-02-01T00:00:00Z',
  context: { task: 'debugging', domain: 'payments' },  // context-dependent retrieval
});

// 5. Consolidate episodes into principles (the "sleep" cycle)
await brain.consolidate();

// 6. Forget something
brain.forget(memoryId);                                 // soft-delete
brain.forget(memoryId, { purge: true });                // hard-delete
await brain.forgetByQuery('old API endpoint', { minSimilarity: 0.9 });

// 7. Check brain health
const stats = brain.introspect();
// { episodic: 47, semantic: 12, procedural: 3, dormant: 8, ... }

// 8. Clean up
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

  // Context-dependent retrieval (v0.8.0)
  context: {
    enabled: true,             // Enable encoding-specificity principle
    weight: 0.3,               // Max 30% confidence boost on full context match
  },

  // Emotional memory (v0.9.0)
  affect: {
    enabled: true,             // Enable affect system
    weight: 0.2,               // Max 20% mood-congruence boost
    arousalWeight: 0.3,        // Yerkes-Dodson arousal-salience coupling
    resonance: {               // Detect emotional echoes across experiences
      enabled: true,
      k: 5,                    // How many past episodes to check
      threshold: 0.5,          // Semantic similarity threshold
      affectThreshold: 0.6,    // Emotional similarity threshold
    },
  },

  // Interference-based forgetting (v0.7.0)
  interference: {
    enabled: true,             // New episodes suppress similar existing memories
    weight: 0.15,              // Suppression strength
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

### Forget and Purge

Memories can be explicitly forgotten — by ID or by semantic query:

**Soft-delete** (default) — Marks the memory as forgotten/superseded and removes its vector index. The record stays in the database but is excluded from recall. Reversible via direct database access.

**Hard-delete** (`purge: true`) — Permanently removes the memory from both the main table and the vector index. Irreversible.

**Bulk purge** — Removes all forgotten, dormant, superseded, and rolled-back memories in one operation. Useful for GDPR compliance or storage cleanup.

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
  context: { task: 'debugging' },    // Optional. Situational context for retrieval.
  affect: {                          // Optional. Emotional context.
    valence: -0.5,                   //   -1 (negative) to 1 (positive)
    arousal: 0.7,                    //   0 (calm) to 1 (activated)
    label: 'frustration',            //   Human-readable emotion label
  },
});
```

Episodes are **immutable**. Corrections create new records with `supersedes` links. The original is preserved.

### `brain.encodeBatch(paramsList)` → `Promise<string[]>`

Encode multiple episodes in one call. Same params as `encode()`, but as an array.

```js
const ids = await brain.encodeBatch([
  { content: 'Stripe returned 429', source: 'direct-observation' },
  { content: 'Redis timed out', source: 'tool-result' },
  { content: 'User reports slow checkout', source: 'told-by-user' },
]);
```

### `brain.recall(query, options)` → `Promise<Memory[]>`

Retrieve memories ranked by `similarity * confidence`.

```js
const memories = await brain.recall('stripe rate limits', {
  limit: 5,                       // Max results (default 10)
  minConfidence: 0.5,             // Filter below this confidence
  types: ['semantic'],            // Filter by memory type
  includeProvenance: true,        // Include evidence chains
  includeDormant: false,          // Include dormant memories
  tags: ['rate-limit'],           // Only episodic memories with these tags
  sources: ['direct-observation'], // Only episodic memories from these sources
  after: '2026-02-01T00:00:00Z', // Only memories created after this date
  before: '2026-03-01T00:00:00Z', // Only memories created before this date
  context: { task: 'debugging' }, // Boost memories encoded in matching context
  mood: { valence: -0.3, arousal: 0.5 }, // Mood-congruent retrieval
});
```

Tag and source filters only apply to episodic memories (semantic and procedural memories don't have tags or sources). Date filters apply to all memory types.

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
  contextMatch: 0.8,   // When retrieval context provided
  moodCongruence: 0.7, // When mood provided
  provenance: {         // When includeProvenance: true
    evidenceEpisodeIds: ['01XYZ...', '01DEF...'],
    evidenceCount: 3,
    supportingCount: 3,
    contradictingCount: 0,
  },
}
```

Retrieval automatically reinforces matched memories (boosts confidence, resets decay clock).

### `brain.recallStream(query, options)` → `AsyncGenerator<Memory>`

Streaming version of `recall()`. Yields results one at a time. Supports early `break`. Same options as `recall()`.

```js
for await (const memory of brain.recallStream('stripe issues', { limit: 10 })) {
  console.log(memory.content, memory.score);
  if (memory.score > 0.9) break;
}
```

### `brain.forget(id, options)` → `ForgetResult`

Forget a memory by ID. Works on any memory type (episodic, semantic, procedural).

```js
brain.forget(memoryId);                       // soft-delete
brain.forget(memoryId, { purge: true });      // hard-delete (permanent)
// { id, type: 'episodic', purged: false }
```

### `brain.forgetByQuery(query, options)` → `Promise<ForgetResult | null>`

Find the closest matching memory by semantic search and forget it. Searches all three memory types, picks the best match.

```js
const result = await brain.forgetByQuery('old API endpoint', {
  minSimilarity: 0.9,    // Threshold for match (default 0.9)
  purge: false,          // Hard-delete? (default false)
});
// null if no match above threshold
```

### `brain.purge()` → `PurgeCounts`

Bulk hard-delete all dead memories: forgotten episodes, dormant/superseded/rolled-back semantics and procedures.

```js
const counts = brain.purge();
// { episodes: 12, semantics: 3, procedures: 0 }
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

### `brain.export()` / `brain.import(snapshot)`

Export all memories as a JSON snapshot, or import from one.

```js
const snapshot = brain.export();   // { version, episodes, semantics, procedures, ... }
await brain.import(snapshot);      // Re-embeds everything with current provider
```

### Events

```js
brain.on('encode', ({ id, content, source }) => { ... });
brain.on('reinforcement', ({ episodeId, targetId, similarity }) => { ... });
brain.on('contradiction', ({ episodeId, contradictionId, semanticId, resolution }) => { ... });
brain.on('consolidation', ({ runId, principlesExtracted }) => { ... });
brain.on('decay', ({ totalEvaluated, transitionedToDormant }) => { ... });
brain.on('rollback', ({ runId, rolledBackMemories }) => { ... });
brain.on('forget', ({ id, type, purged }) => { ... });
brain.on('purge', ({ episodes, semantics, procedures }) => { ... });
brain.on('interference', ({ newEpisodeId, suppressedId, similarity }) => { ... });
brain.on('resonance', ({ episodeId, resonances }) => { ... });
brain.on('migration', ({ episodes, semantics, procedures }) => { ... });
brain.on('error', (err) => { ... });
```

### `brain.close()`

Close the database connection.

## Architecture

```
audrey-data/
  audrey.db          <- Single SQLite file. WAL mode. That's your brain.
```

```
src/
  audrey.js          Main class. EventEmitter. Public API surface.
  causal.js          Causal graph management. LLM-powered mechanism articulation.
  confidence.js      Compositional confidence formula. Pure math.
  consolidate.js     "Sleep" cycle. KNN clustering -> LLM extraction -> promote.
  db.js              SQLite + sqlite-vec. Schema, vec0 tables, migrations.
  decay.js           Ebbinghaus forgetting curves.
  embedding.js       Pluggable providers (Mock, OpenAI). Batch embedding.
  encode.js          Immutable episodic memory creation + vec0 writes.
  affect.js          Emotional memory: arousal-salience coupling, mood-congruent recall, resonance.
  context.js         Context-dependent retrieval modifier (encoding specificity).
  interference.js    Competitive memory suppression (engram competition).
  forget.js          Soft-delete, hard-delete, query-based forget, bulk purge.
  introspect.js      Health dashboard queries.
  llm.js             Pluggable LLM providers (Mock, Anthropic, OpenAI).
  prompts.js         Structured prompt templates for LLM operations.
  recall.js          KNN retrieval + confidence scoring + filtered recall + streaming.
  rollback.js        Undo consolidation runs.
  utils.js           Date math, safe JSON parse.
  validate.js        KNN validation + LLM contradiction detection.
  migrate.js         Dimension migration re-embedding.
  adaptive.js        Adaptive consolidation parameter suggestions.
  export.js          Memory export (JSON snapshots).
  import.js          Memory import with re-embedding.
  index.js           Barrel export.

mcp-server/
  index.js           MCP tool server (9 tools, stdio transport) + CLI subcommands.
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
npm test          # 379 tests across 28 files
npm run test:watch
```

## Running the Demo

```bash
node examples/stripe-demo.js
```

Demonstrates the full pipeline: encode 3 rate-limit observations, consolidate into principle, recall proactively.

---

## Changelog

### v0.9.0 — Emotional Memory (current)

- Valence-arousal affect model (Russell's circumplex) on every episode
- Arousal-salience coupling via Yerkes-Dodson inverted-U curve
- Mood-congruent recall — matching emotional state boosts retrieval confidence
- Emotional resonance detection — new experiences that echo past emotional patterns emit events
- MCP server: `memory_encode` accepts `affect`, `memory_recall` accepts `mood`
- 379 tests across 28 test files

### v0.8.0 — Context-Dependent Retrieval

- Encoding specificity principle: context stored with memory, matching context boosts recall
- MCP server: `memory_encode` and `memory_recall` accept `context`
- 340 tests across 27 test files

### v0.7.0 — Interference + Salience

- Interference-based forgetting: new memories competitively suppress similar existing ones
- Salience-weighted confidence: high-salience memories resist decay
- Spaced-repetition reconsolidation: retrieval intervals affect reinforcement strength
- 310 tests across 25 test files

### v0.6.0 — Filtered Recall + Forget

- Filtered recall: tag, source, and date-range filters on `recall()` and `recallStream()`
- `forget()` — soft-delete any memory by ID
- `forgetByQuery()` — find closest match by semantic search and forget it
- `purge()` — bulk hard-delete all forgotten/dormant/superseded memories
- `memory_forget` and `memory_decay` MCP tools (9 tools total)
- 278 tests across 23 files

### v0.5.0 — Feature Depth

- Configurable confidence weights and decay rates per instance
- Memory export/import (JSON snapshots with re-embedding)
- `memory_export` and `memory_import` MCP tools
- Auto-consolidation scheduling
- Adaptive consolidation parameter suggestions
- 243 tests across 22 files

### v0.3.1 — MCP Server

- MCP tool server via `@modelcontextprotocol/sdk` with stdio transport
- One-command install: `npx audrey install` (auto-detects API keys)
- CLI subcommands: `install`, `uninstall`, `status`
- JSDoc type annotations on all public exports
- Published to npm
- 194 tests across 17 files

### v0.3.0 — Vector Performance

- sqlite-vec native vector indexing (vec0 virtual tables with cosine distance)
- KNN queries for recall, validation, and consolidation clustering
- Batch encoding API and streaming recall with async generators
- Dimension configuration and automatic migration from v0.2.0
- 168 tests across 16 files

### v0.2.0 — LLM Integration

- LLM-powered principle extraction, contradiction detection, causal articulation
- Context-dependent truth resolution
- Configurable LLM providers (Mock, Anthropic, OpenAI)
- 142 tests across 15 files

### v0.1.0 — Foundation

- Immutable episodic memory, compositional confidence, Ebbinghaus forgetting curves
- Consolidation engine, contradiction lifecycle, rollback
- Circular self-confirmation defense, causal context, introspection
- 104 tests across 12 files

## Design Decisions

**Why SQLite, not Postgres?** Zero infrastructure. `npm install` and you have a brain. The adapter pattern means you can migrate to pgvector when you need to scale.

**Why append-only episodes?** Immutability creates a reliable audit trail. Corrections use `supersedes` links rather than mutations. You can always trace back to what actually happened.

**Why Ebbinghaus curves?** Biological forgetting is an adaptive feature, not a bug. It prevents cognitive overload, maintains relevance, and enables generalization. Audrey's forgetting works the same way.

**Why model-generated cap at 0.6?** Prevents the most dangerous exploit in AI memory: circular self-confirmation where an agent's own inferences bootstrap themselves into high-confidence "facts" through repeated retrieval.

**Why soft-delete by default?** Hard-deletes are irreversible. Soft-delete preserves data integrity and audit trails while excluding the memory from recall. Use `purge: true` or `brain.purge()` when you need permanent removal (GDPR, storage cleanup).

**Why emotional memory?** Every memory system stores facts. Biological memory stores facts with emotional context — and that context changes how memories are retrieved. Emotional arousal modulates encoding strength (amygdala-hippocampal interaction). Current mood biases which memories surface (Bower, 1981). This isn't a novelty feature — it's the foundation for AI that remembers like it cares.

## License

MIT
