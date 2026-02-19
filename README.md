# Audrey

Biological memory architecture for AI agents. Gives agents cognitive memory that decays, consolidates, self-validates, and learns from experience — not just a database.

Named after the neuroscience concept of an [engram](https://en.wikipedia.org/wiki/Engram_(neuropsychology)) — the physical trace of a memory in the brain.

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

```bash
npm install audrey
```

Zero external infrastructure. One SQLite file. That's it.

## Quick Start

```js
import { Audrey } from 'audrey';

const brain = new Audrey({
  dataDir: './agent-memory',
  agent: 'my-agent',
  embedding: { provider: 'openai', model: 'text-embedding-3-small' },
});

// Agent observes something
await brain.encode({
  content: 'Stripe API returns 429 above 100 req/s',
  source: 'direct-observation',
  salience: 0.9,
  causal: { trigger: 'batch-payment-job', consequence: 'queue-stalled' },
  tags: ['stripe', 'rate-limit'],
});

// Later — agent encounters Stripe again
const memories = await brain.recall('stripe rate limits', {
  minConfidence: 0.5,
  types: ['semantic', 'procedural'],
  limit: 5,
});

// Run consolidation (the "sleep" cycle)
await brain.consolidate();

// Check brain health
const stats = brain.introspect();
// { episodic: 47, semantic: 12, procedural: 3, dormant: 8, ... }

brain.close();
```

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

```js
const brain = new Audrey({
  dataDir: './audrey-data',       // Where the SQLite DB lives
  agent: 'my-agent',             // Agent identifier
  embedding: {
    provider: 'openai',          // 'openai' | 'mock'
    model: 'text-embedding-3-small',
    apiKey: process.env.OPENAI_API_KEY,
  },
  consolidation: {
    interval: '1h',              // Auto-consolidation interval
    minEpisodes: 3,              // Minimum cluster size
    confidenceTarget: 2.0,       // Adaptive threshold multiplier
  },
  decay: {
    dormantThreshold: 0.1,       // Below this → dormant
  },
});
```

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
  confidence.js      Compositional confidence formula. Pure math.
  consolidate.js     "Sleep" cycle. Cluster → extract → promote.
  db.js              SQLite schema. 6 tables. CHECK constraints. Indexes.
  decay.js           Ebbinghaus forgetting curves.
  embedding.js       Pluggable providers (Mock, OpenAI).
  encode.js          Immutable episodic memory creation.
  introspect.js      Health dashboard queries.
  recall.js          Confidence-weighted vector retrieval.
  rollback.js        Undo consolidation runs.
  utils.js           Shared: cosine similarity, date math, safe JSON parse.
  validate.js        Reinforcement + contradiction lifecycle.
  index.js           Barrel export.
```

### Database Schema (6 tables)

| Table | Purpose | Key Columns |
|---|---|---|
| `episodes` | Immutable raw events | content, embedding, source, salience, causal_trigger/consequence, supersedes |
| `semantics` | Consolidated principles | content, embedding, state, evidence_episode_ids, source_type_diversity |
| `procedures` | Learned workflows | content, embedding, trigger_conditions, success/failure_count |
| `causal_links` | Why things happened | cause_id, effect_id, link_type (causal/correlational/temporal), mechanism |
| `contradictions` | Dispute tracking | claim_a/b_id, state (open/resolved/context_dependent/reopened), resolution |
| `consolidation_runs` | Audit trail | input_episode_ids, output_memory_ids, status, checkpoint_cursor |

All mutations use SQLite transactions for atomicity. CHECK constraints enforce valid states and source types.

## Running Tests

```bash
npm test          # 104 tests, ~760ms
npm run test:watch
```

## Running the Demo

```bash
node examples/stripe-demo.js
```

Demonstrates the full pipeline: encode 3 rate-limit observations → consolidate into principle → recall proactively.

---

## Roadmap

### v0.1.0 — Foundation (current)

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

- [ ] LLM-powered principle extraction (replace callback with Anthropic/OpenAI calls)
- [ ] LLM-based contradiction detection during validation
- [ ] Causal mechanism articulation via LLM (not just trigger/consequence)
- [ ] Spurious correlation detection (require mechanistic explanation for causal links)
- [ ] Context-dependent truth resolution via LLM
- [ ] Configurable LLM provider for consolidation (Anthropic, OpenAI, Ollama, local)

### v0.3.0 — Vector Performance

- [ ] sqlite-vec native vector indexing (currently brute-force cosine similarity in JS)
- [ ] Approximate nearest neighbor search for large memory stores
- [ ] Embedding migration pipeline (re-embed when models change)
- [ ] Re-consolidation queue (re-run consolidation with new embedding model)
- [ ] Batch encoding API (encode N episodes in one call)
- [ ] Streaming recall with async iteration

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
