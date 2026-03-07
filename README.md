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
| Cerebellum | Procedural Memory | Learned workflows and conditional behaviors |
| Sleep Replay | Dream Cycle | Consolidates episodes into principles, applies decay |
| Prefrontal Cortex | Validation Engine | Truth-checking, contradiction detection |
| Amygdala | Affect System | Emotional encoding, arousal-salience coupling, mood-congruent recall |

## Install

### MCP Server for Claude Code (one command)

```bash
npx audrey install
```

That's it. Audrey auto-detects API keys from your environment:

- `GOOGLE_API_KEY` or `GEMINI_API_KEY` set? Uses Gemini embeddings (3072d).
- Neither? Runs with local embeddings (384d, MiniLM via @huggingface/transformers — zero API key, works offline).
- `AUDREY_EMBEDDING_PROVIDER=openai` for explicit OpenAI embeddings (1536d).
- `ANTHROPIC_API_KEY` set? Enables LLM-powered consolidation, contradiction detection, and reflection.

```bash
# Check status
npx audrey status

# Uninstall
npx audrey uninstall
```

Every Claude Code session now has 13 memory tools: `memory_encode`, `memory_recall`, `memory_consolidate`, `memory_dream`, `memory_introspect`, `memory_resolve_truth`, `memory_export`, `memory_import`, `memory_forget`, `memory_decay`, `memory_status`, `memory_reflect`, `memory_greeting`.

### CLI Subcommands

```bash
npx audrey install          # Register MCP server with Claude Code
npx audrey uninstall        # Remove MCP server registration
npx audrey status           # Show memory store health and stats
npx audrey greeting         # Output session briefing (mood, principles, recent memories)
npx audrey greeting "auth"  # Briefing + context-relevant memories for "auth"
npx audrey reflect          # Reflect on conversation + dream cycle (reads turns from stdin)
npx audrey dream            # Run consolidation + decay cycle
npx audrey reembed          # Re-embed all memories with current provider
```

`greeting` and `reflect` are designed for Claude Code hooks — wire them into SessionStart and Stop events for automatic memory lifecycle.

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
  embedding: { provider: 'local', dimensions: 384 },  // or 'gemini', 'openai'
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

// 5. Dream — the biological sleep cycle
const dream = await brain.dream();
// Consolidates episodes into principles, applies forgetting curves, reports health

// 6. Reflect on a conversation — form lasting memories
const result = await brain.reflect([
  { role: 'user', content: 'How do I handle rate limits?' },
  { role: 'assistant', content: 'Use exponential backoff with jitter...' },
]);
// LLM extracts what matters, encodes it as lasting memories

// 7. Session greeting — wake up with context
const briefing = await brain.greeting({ context: 'debugging stripe' });
// Returns mood, principles, recent memories, identity, unresolved threads

// 8. Forget something
brain.forget(memoryId);                                 // soft-delete
brain.forget(memoryId, { purge: true });                // hard-delete
await brain.forgetByQuery('old API endpoint', { minSimilarity: 0.9 });

// 9. Check brain health
const stats = brain.introspect();
// { episodic: 47, semantic: 12, procedural: 3, dormant: 8, ... }

// 10. Clean up
brain.close();
```

### Configuration

```js
const brain = new Audrey({
  dataDir: './audrey-data',     // SQLite database directory
  agent: 'my-agent',           // Agent identifier

  // Embedding provider (required)
  embedding: {
    provider: 'local',         // 'mock' (test), 'local' (384d MiniLM), 'gemini' (3072d), 'openai' (1536d)
    dimensions: 384,           // Must match provider
    apiKey: '...',             // Required for gemini/openai
    device: 'gpu',             // 'gpu' or 'cpu' — for local provider only
  },

  // LLM provider (optional — enables smart consolidation + contradiction detection + reflection)
  llm: {
    provider: 'anthropic',     // 'mock', 'anthropic', or 'openai'
    apiKey: '...',             // Required for anthropic/openai
    model: 'claude-sonnet-4-6', // Optional model override
  },

  // Consolidation settings
  consolidation: {
    minEpisodes: 3,            // Minimum cluster size for principle extraction
  },

  // Context-dependent retrieval
  context: {
    enabled: true,             // Enable encoding-specificity principle
    weight: 0.3,               // Max 30% confidence boost on full context match
  },

  // Emotional memory
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

  // Interference-based forgetting
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

**Without an LLM provider**, consolidation uses a default text-based extractor and contradiction detection is similarity-only. **With an LLM provider**, Audrey extracts real generalized principles (semantic and procedural), detects semantic contradictions, resolves context-dependent truths, and reflects on conversations to form lasting memories.

### Environment Variables (MCP Server)

| Variable | Default | Purpose |
|---|---|---|
| `AUDREY_DATA_DIR` | `~/.audrey/data` | SQLite database directory |
| `AUDREY_AGENT` | `claude-code` | Agent identifier |
| `AUDREY_EMBEDDING_PROVIDER` | auto-detect | `local`, `gemini`, `openai`, or `mock` |
| `AUDREY_LLM_PROVIDER` | auto-detect | `anthropic`, `openai`, or `mock` |
| `AUDREY_DEVICE` | `gpu` | Device for local embedding provider |
| `GOOGLE_API_KEY` | — | Gemini embeddings (auto-selected when present) |
| `ANTHROPIC_API_KEY` | — | Anthropic LLM (consolidation, reflection, contradiction detection) |
| `OPENAI_API_KEY` | — | OpenAI embeddings/LLM (must be explicitly selected for embeddings) |

## Core Concepts

### Four Memory Types

**Episodic** (hot, fast decay) — Raw events. "Stripe returned 429 at 3pm." Immutable. Append-only. Never modified.

**Semantic** (warm, slow decay) — Consolidated principles. "Stripe enforces 100 req/s rate limit." Extracted automatically from clusters of episodic memories.

**Procedural** (cold, slowest decay) — Learned workflows. "When Stripe rate-limits, implement exponential backoff." Skills the agent has acquired. Routed automatically when the LLM identifies a principle as procedural.

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

### Dream Cycle (The "Sleep" Cycle)

`brain.dream()` runs the full biological sleep analog:

1. **Consolidate** — Cluster similar episodic memories via KNN, extract principles via LLM, route to semantic or procedural tables
2. **Decay** — Apply forgetting curves, transition low-confidence memories to dormant
3. **Introspect** — Report memory system health

The pipeline is fully transactional — if any cluster fails mid-run, all writes roll back. Consolidation is idempotent. Re-running on the same data produces no duplicates.

### Consolidation Routing

When the LLM extracts a principle, it classifies it:

- `type: 'semantic'` → goes to the `semantics` table (general knowledge)
- `type: 'procedural'` → goes to the `procedures` table with `trigger_conditions` (actionable skills)

### Contradiction Handling

When memories conflict, Audrey doesn't force a winner. Contradictions have a lifecycle:

```
open -> resolved | context_dependent | reopened
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
// Semantic memories -> rolled_back state
// Source episodes -> un-consolidated
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

### `brain.encode(params)` -> `Promise<string>`

Encode an episodic memory. Returns the memory ID.

```js
const id = await brain.encode({
  content: 'What happened',          // Required. Non-empty string, max 50000 chars.
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
  private: true,                     // Optional. If true, excluded from public recall.
});
```

Episodes are **immutable**. Corrections create new records with `supersedes` links. The original is preserved.

### `brain.encodeBatch(paramsList)` -> `Promise<string[]>`

Encode multiple episodes in one call. Same params as `encode()`, but as an array.

```js
const ids = await brain.encodeBatch([
  { content: 'Stripe returned 429', source: 'direct-observation' },
  { content: 'Redis timed out', source: 'tool-result' },
  { content: 'User reports slow checkout', source: 'told-by-user' },
]);
```

### `brain.recall(query, options)` -> `Promise<Memory[]>`

Retrieve memories ranked by `similarity * confidence`.

```js
const memories = await brain.recall('stripe rate limits', {
  limit: 5,                       // Max results (default 10, max 50)
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

Tag and source filters only apply to episodic memories (semantic and procedural memories don't have tags or sources). Date filters apply to all memory types. Recall gracefully degrades — if one memory type's vector search fails, the others still return results.

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

### `brain.recallStream(query, options)` -> `AsyncGenerator<Memory>`

Streaming version of `recall()`. Yields results one at a time. Supports early `break`. Same options as `recall()`.

```js
for await (const memory of brain.recallStream('stripe issues', { limit: 10 })) {
  console.log(memory.content, memory.score);
  if (memory.score > 0.9) break;
}
```

### `brain.dream(options)` -> `Promise<DreamResult>`

Run the full biological sleep cycle: consolidate + decay + introspect.

```js
const result = await brain.dream({
  minClusterSize: 3,           // Min episodes per cluster
  similarityThreshold: 0.85,   // KNN clustering threshold
  dormantThreshold: 0.1,       // Below this = dormant
});
// {
//   consolidation: { episodesEvaluated, clustersFound, principlesExtracted, semanticsCreated, proceduresCreated },
//   decay: { totalEvaluated, transitionedToDormant },
//   stats: { episodic, semantic, procedural, ... },
// }
```

### `brain.reflect(turns)` -> `Promise<ReflectResult>`

Feed a conversation to the LLM and extract lasting memories. Requires an LLM provider.

```js
const result = await brain.reflect([
  { role: 'user', content: 'How do I handle rate limits?' },
  { role: 'assistant', content: 'Use exponential backoff...' },
]);
// { encoded: 2, memories: [...] }
```

### `brain.greeting(options)` -> `Promise<GreetingResult>`

Session-start briefing. Returns mood, principles, identity, recent memories, and unresolved threads.

```js
const briefing = await brain.greeting({
  context: 'debugging stripe',  // Optional — also returns relevant memories
  recentLimit: 10,
  principleLimit: 5,
  identityLimit: 5,
});
// { recent, principles, mood, unresolved, identity, contextual }
```

### `brain.forget(id, options)` -> `ForgetResult`

Forget a memory by ID. Works on any memory type (episodic, semantic, procedural).

```js
brain.forget(memoryId);                       // soft-delete
brain.forget(memoryId, { purge: true });      // hard-delete (permanent)
// { id, type: 'episodic', purged: false }
```

### `brain.forgetByQuery(query, options)` -> `Promise<ForgetResult | null>`

Find the closest matching memory by semantic search and forget it. Searches all three memory types, picks the best match.

```js
const result = await brain.forgetByQuery('old API endpoint', {
  minSimilarity: 0.9,    // Threshold for match (default 0.9)
  purge: false,          // Hard-delete? (default false)
});
// null if no match above threshold
```

### `brain.purge()` -> `PurgeCounts`

Bulk hard-delete all dead memories: forgotten episodes, dormant/superseded/rolled-back semantics and procedures.

```js
const counts = brain.purge();
// { episodes: 12, semantics: 3, procedures: 0 }
```

### `brain.consolidate(options)` -> `Promise<ConsolidationResult>`

Run the consolidation engine manually. Fully transactional — if any cluster fails, all writes roll back.

```js
const result = await brain.consolidate({
  minClusterSize: 3,
  similarityThreshold: 0.80,
  extractPrinciple: (episodes) => ({    // Optional LLM callback
    content: 'Extracted principle text',
    type: 'semantic',                   // or 'procedural'
    conditions: ['trigger conditions'], // for procedural only
  }),
});
// { runId, status, episodesEvaluated, clustersFound, principlesExtracted, semanticsCreated, proceduresCreated }
```

### `brain.decay(options)` -> `DecayResult`

Apply forgetting curves. Transitions low-confidence memories to dormant.

```js
const result = brain.decay({ dormantThreshold: 0.1 });
// { totalEvaluated, transitionedToDormant, timestamp }
```

### `brain.memoryStatus()` -> `HealthStatus`

Check brain health: vector index sync, dimension consistency, re-embed recommendations.

```js
brain.memoryStatus();
// { healthy, vec_episodes, searchable_episodes, vec_semantics, ..., reembed_recommended }
```

### `brain.rollback(runId)` -> `RollbackResult`

Undo a consolidation run.

```js
brain.rollback('01ABC...');
// { rolledBackMemories: 3, restoredEpisodes: 9 }
```

### `brain.resolveTruth(contradictionId)` -> `Promise<Resolution>`

Resolve an open contradiction using LLM reasoning. Requires an LLM provider configured.

```js
const resolution = await brain.resolveTruth('contradiction-id');
// { resolution: 'context_dependent', conditions: { a: 'live keys', b: 'test keys' }, explanation: '...' }
```

### `brain.introspect()` -> `Stats`

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

### `brain.consolidationHistory()` -> `ConsolidationRun[]`

Full audit trail of all consolidation runs.

### `brain.export()` / `brain.import(snapshot)`

Export all memories as a JSON snapshot, or import from one. Full-fidelity: preserves consolidation metrics, run metadata, and config. Import re-embeds everything with the current provider in a single atomic transaction.

```js
const snapshot = brain.export();   // { version, episodes, semantics, procedures, consolidationMetrics, ... }
await brain.import(snapshot);      // Re-embeds everything with current provider
```

### Events

```js
brain.on('encode', ({ id, content, source }) => { ... });
brain.on('reinforcement', ({ episodeId, targetId, similarity }) => { ... });
brain.on('contradiction', ({ episodeId, contradictionId, semanticId, resolution }) => { ... });
brain.on('consolidation', ({ runId, principlesExtracted }) => { ... });
brain.on('decay', ({ totalEvaluated, transitionedToDormant }) => { ... });
brain.on('dream', ({ consolidation, decay, stats }) => { ... });
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
  embedding.js       Pluggable providers (Mock, Local/MiniLM, Gemini, OpenAI). Batch embedding.
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
  export.js          Memory export (JSON snapshots with consolidation metrics).
  import.js          Memory import with batch re-embedding in atomic transactions.
  index.js           SDK barrel export (all providers, database utilities).

mcp-server/
  index.js           MCP tool server (13 tools, stdio transport) + CLI subcommands.
  config.js          Shared config (env var parsing, provider resolution, install arg builder).
```

### Database Schema

| Table | Purpose |
|---|---|
| `episodes` | Immutable raw events (content, source, salience, causal context, affect, private flag) |
| `semantics` | Consolidated principles (content, state, evidence chain) |
| `procedures` | Learned workflows (trigger conditions, success/failure counts) |
| `causal_links` | Causal relationships (cause, effect, mechanism, link type) |
| `contradictions` | Dispute tracking (claims, state, resolution) |
| `consolidation_runs` | Audit trail (inputs, outputs, status, checkpoint cursor) |
| `consolidation_metrics` | Per-run metrics and confidence deltas |
| `vec_episodes` | sqlite-vec KNN index for episode embeddings |
| `vec_semantics` | sqlite-vec KNN index for semantic embeddings |
| `vec_procedures` | sqlite-vec KNN index for procedural embeddings |
| `audrey_config` | Dimension configuration, embedding model info, metadata |

All mutations use SQLite transactions. CHECK constraints enforce valid states and source types. Vector search uses sqlite-vec with cosine distance.

## Running Tests

```bash
npm test          # 463 tests across 29 files
npm run test:watch
```

## Running the Demo

```bash
node examples/stripe-demo.js
```

Demonstrates the full pipeline: encode 3 rate-limit observations, consolidate into principle, recall proactively.

---

## Changelog

### v0.16.0 (current)

- Version bump for npm publish with all v0.15.0 features included
- 463 tests across 29 test files

### v0.15.0 — Production Hardening + Dream Cycle

- `dream()` method: consolidation + decay + introspect (biological sleep analog)
- `memory_dream` MCP tool with configurable thresholds
- `greeting` and `reflect` CLI subcommands for hook integration
- Consolidation routes procedural principles to `procedures` table (previously all went to semantics)
- Fully transactional consolidation — mid-run failures roll back all writes
- Recall gracefully degrades per memory type (independent try/catch per KNN search)
- sqlite-vec crash guard for empty vector tables
- LLM JSON parsing strips markdown code fences from any provider
- Input validation: empty content rejected, 50K char limit, forget requires exactly one target
- Full-fidelity export/import: preserves consolidation metrics, run metadata, config
- Import uses batch embedding in a single atomic transaction
- Expanded SDK exports: all embedding/LLM providers, database utilities
- Shared `resolveLLMConfig()` for CLI commands
- 463 tests across 29 test files

### v0.14.0 — Memory Intelligence

- `memory_reflect` MCP tool — form lasting memories from conversation turns
- `memory_greeting` MCP tool — session-start context briefing
- `greeting()` method: mood, principles, identity, recent memories, unresolved threads
- `reflect()` method: LLM-powered conversation analysis and memory formation
- Rewritten consolidation prompt for deeper principle extraction
- Rewritten reflection prompt for relational and emotional depth
- `npx audrey status` shows last consolidation time

### v0.13.0 — GPU-Accelerated Embeddings

- GPU device configuration for LocalEmbeddingProvider
- True single-forward-pass batch embedding for LocalEmbeddingProvider
- Gemini `batchEmbedContents` API for batch embedding
- `reembedAll` uses `embedBatch` for performance
- `AUDREY_DEVICE` env var, `memoryStatus` reports device

### v0.11.0 — Multi-Provider Embeddings + Privacy

- `LocalEmbeddingProvider` — 384d MiniLM via @huggingface/transformers (zero API key, works offline)
- `GeminiEmbeddingProvider` — 3072d via Google text-embedding-004
- `private: true` memory flag — memories visible to AI only, excluded from public recall
- Auto-select embedding provider: local -> gemini (if API key present) -> explicit openai
- `npx audrey reembed` CLI subcommand for provider migration
- `reflect()` method for post-conversation memory formation
- 409 tests across 29 test files

### v0.9.0 — Emotional Memory

- Valence-arousal affect model (Russell's circumplex) on every episode
- Arousal-salience coupling via Yerkes-Dodson inverted-U curve
- Mood-congruent recall — matching emotional state boosts retrieval confidence
- Emotional resonance detection — new experiences that echo past emotional patterns emit events
- MCP server: `memory_encode` accepts `affect`, `memory_recall` accepts `mood`

### v0.8.0 — Context-Dependent Retrieval

- Encoding specificity principle: context stored with memory, matching context boosts recall
- MCP server: `memory_encode` and `memory_recall` accept `context`

### v0.7.0 — Interference + Salience

- Interference-based forgetting: new memories competitively suppress similar existing ones
- Salience-weighted confidence: high-salience memories resist decay
- Spaced-repetition reconsolidation: retrieval intervals affect reinforcement strength

### v0.6.0 — Filtered Recall + Forget

- Filtered recall: tag, source, and date-range filters on `recall()` and `recallStream()`
- `forget()`, `forgetByQuery()`, `purge()`
- `memory_forget` and `memory_decay` MCP tools

### v0.5.0 — Feature Depth

- Configurable confidence weights and decay rates per instance
- Memory export/import (JSON snapshots with re-embedding)
- `memory_export` and `memory_import` MCP tools
- Auto-consolidation scheduling
- Adaptive consolidation parameter suggestions

### v0.3.1 — MCP Server

- MCP tool server via `@modelcontextprotocol/sdk` with stdio transport
- One-command install: `npx audrey install` (auto-detects API keys)
- CLI subcommands: `install`, `uninstall`, `status`

### v0.3.0 — Vector Performance

- sqlite-vec native vector indexing (vec0 virtual tables with cosine distance)
- KNN queries for recall, validation, and consolidation clustering
- Batch encoding API and streaming recall with async generators

### v0.2.0 — LLM Integration

- LLM-powered principle extraction, contradiction detection, causal articulation
- Context-dependent truth resolution
- Configurable LLM providers (Mock, Anthropic, OpenAI)

### v0.1.0 — Foundation

- Immutable episodic memory, compositional confidence, Ebbinghaus forgetting curves
- Consolidation engine, contradiction lifecycle, rollback
- Circular self-confirmation defense, causal context, introspection

## Design Decisions

**Why SQLite, not Postgres?** Zero infrastructure. `npm install` and you have a brain. The adapter pattern means you can migrate to pgvector when you need to scale.

**Why append-only episodes?** Immutability creates a reliable audit trail. Corrections use `supersedes` links rather than mutations. You can always trace back to what actually happened.

**Why Ebbinghaus curves?** Biological forgetting is an adaptive feature, not a bug. It prevents cognitive overload, maintains relevance, and enables generalization. Audrey's forgetting works the same way.

**Why model-generated cap at 0.6?** Prevents the most dangerous exploit in AI memory: circular self-confirmation where an agent's own inferences bootstrap themselves into high-confidence "facts" through repeated retrieval.

**Why soft-delete by default?** Hard-deletes are irreversible. Soft-delete preserves data integrity and audit trails while excluding the memory from recall. Use `purge: true` or `brain.purge()` when you need permanent removal (GDPR, storage cleanup).

**Why emotional memory?** Every memory system stores facts. Biological memory stores facts with emotional context — and that context changes how memories are retrieved. Emotional arousal modulates encoding strength (amygdala-hippocampal interaction). Current mood biases which memories surface (Bower, 1981). This isn't a novelty feature — it's the foundation for AI that remembers like it cares.

**Why a dream cycle?** Biological sleep isn't downtime — it's when the brain consolidates episodic memories into long-term semantic knowledge, prunes weak connections, and strengthens important ones. Audrey's `dream()` does the same: cluster episodes, extract principles, apply decay, report health. Wire it into session hooks and your agent gets smarter every time it sleeps.

## License

MIT
