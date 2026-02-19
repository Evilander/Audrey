# Audrey: Biological Memory Architecture for AI Agents

**Date:** 2026-02-18
**Status:** Design approved, pending implementation plan
**Author:** Tyler Eveland + Claude

---

## Problem Statement

Every existing AI memory system (Mem0, Zep, LangChain Memory) is a filing cabinet — store stuff, retrieve stuff. None of them do what biological memory actually does:

1. **No self-validation** — Hallucinations get persisted as facts
2. **No confidence decay** — Memories are binary (exists/doesn't exist)
3. **No causal reasoning** — Stores WHAT happened, never WHY
4. **No knowledge metabolism** — No consolidation from episodes to principles
5. **No adversarial integrity** — Contradictory memories coexist silently
6. **No circular self-confirmation defense** — Models reinforce their own hallucinations

AI agents fail ~50% of the time. The root cause: they can't learn from experience.

## Core Invention

Audrey is a biologically-inspired memory SDK that gives AI agents cognitive memory, not storage. Named after the neuroscience term "engram" (the physical trace of a memory in the brain), reimagined as a developer tool.

### Neuroscience Mapping

| Brain Structure | Audrey Component | Function |
|----------------|-----------------|----------|
| Hippocampus | Hot Memory (SQLite, append-only) | Fast episodic capture — raw events, observations, errors |
| Neocortex | Cold Memory (SQLite knowledge graph + vectors) | Consolidated semantic knowledge — principles, patterns |
| Sleep replay | Consolidation Engine | Background extraction of patterns from episodes |
| Prefrontal cortex | Validation Engine | Truth-checking, confidence scoring, contradiction detection |
| Amygdala | Salience Scorer | Importance weighting — critical failures get higher retention |

---

## Architecture

### Design Principles

1. **Episodes are immutable.** Append-only. Updates create new records with `corrects` / `supersedes` links. Full audit trail preserved.
2. **Confidence is compositional.** Not one number — a formula with distinct, inspectable components.
3. **Contradictions are preserved.** Both claims kept with state (`active`, `disputed`, `superseded`, `context_dependent`, `dormant`). New evidence can reopen disputes.
4. **SQLite is canonical.** All data lives in SQLite. JSON exports are snapshots, not sources of truth. Atomic writes with WAL mode.
5. **Embeddings and consolidations are versioned.** Model name, version, and prompt hash stored with every derived artifact. Re-embedding/re-consolidation queues for upgrades.
6. **Consolidation is idempotent.** Resumable with checkpoint cursors. Deterministic output IDs. Full input/output logging.

### Memory Types

```
EPISODIC (Hot)          SEMANTIC (Warm)         PROCEDURAL (Cold)
─────────────          ──────────────          ─────────────────
Raw events             Principles              How-to knowledge
Observations           Patterns                Strategies
Errors + results       Rules                   Workflows
Immutable, fast decay  Consolidated, slow decay Skills, slowest decay

                    CAUSAL GRAPH
                    ────────────
                    Why X caused Y
                    Chains of consequence
                    Mechanistic links (not just correlation)
```

### Storage Architecture

All data in a single SQLite database with sqlite-vec extension:

```
audrey-data/
├── audrey.db            # SQLite + sqlite-vec — all memory types
├── consolidation.log    # Append-only audit trail
└── config.json          # Decay rates, thresholds, model versions
```

**SQLite Tables:**

```sql
-- Immutable episodic memories
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,           -- ULID (time-sortable, unique)
  content TEXT NOT NULL,
  embedding BLOB,                -- sqlite-vec vector
  source TEXT NOT NULL,          -- direct-observation | tool-result | inference | told-by-user | model-generated
  source_reliability REAL,       -- 0.0-1.0
  salience REAL DEFAULT 0.5,
  tags TEXT,                     -- JSON array
  causal_trigger TEXT,           -- what caused this observation
  causal_consequence TEXT,       -- what this observation caused
  created_at TEXT NOT NULL,
  embedding_model TEXT,
  embedding_version TEXT,
  supersedes TEXT,               -- ID of episode this corrects
  superseded_by TEXT,            -- ID of episode that corrected this
  FOREIGN KEY (supersedes) REFERENCES episodes(id)
);

-- Consolidated semantic knowledge
CREATE TABLE semantics (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  embedding BLOB,
  state TEXT DEFAULT 'active',   -- active | disputed | superseded | context_dependent | dormant
  conditions TEXT,               -- JSON: conditions under which this is true (for context_dependent)
  evidence_episode_ids TEXT,     -- JSON array of source episode IDs
  evidence_count INTEGER,
  source_type_diversity INTEGER, -- number of distinct source types in evidence
  consolidation_checkpoint TEXT,
  embedding_model TEXT,
  embedding_version TEXT,
  consolidation_model TEXT,
  consolidation_prompt_hash TEXT,
  created_at TEXT NOT NULL,
  last_reinforced_at TEXT,
  retrieval_count INTEGER DEFAULT 0,
  challenge_count INTEGER DEFAULT 0
);

-- Procedural knowledge (learned workflows)
CREATE TABLE procedures (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  embedding BLOB,
  state TEXT DEFAULT 'active',
  trigger_conditions TEXT,       -- JSON: when to apply this procedure
  evidence_episode_ids TEXT,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  embedding_model TEXT,
  embedding_version TEXT,
  created_at TEXT NOT NULL,
  last_reinforced_at TEXT,
  retrieval_count INTEGER DEFAULT 0
);

-- Causal relationships
CREATE TABLE causal_links (
  id TEXT PRIMARY KEY,
  cause_id TEXT NOT NULL,        -- episode or semantic ID
  effect_id TEXT NOT NULL,
  link_type TEXT DEFAULT 'causal', -- causal | correlational | temporal
  mechanism TEXT,                -- LLM-articulated explanation of WHY
  confidence REAL,
  evidence_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Contradiction tracking
CREATE TABLE contradictions (
  id TEXT PRIMARY KEY,
  claim_a_id TEXT NOT NULL,
  claim_b_id TEXT NOT NULL,
  state TEXT DEFAULT 'open',     -- open | resolved | context_dependent | reopened
  resolution TEXT,               -- JSON: which claim won and why, or context conditions
  resolved_at TEXT,
  reopened_at TEXT,
  reopen_evidence_id TEXT        -- episode that triggered reopen
);

-- Consolidation audit log
CREATE TABLE consolidation_runs (
  id TEXT PRIMARY KEY,
  checkpoint_cursor TEXT,        -- resumption point
  input_episode_ids TEXT,        -- JSON array
  output_memory_ids TEXT,        -- JSON array
  confidence_deltas TEXT,        -- JSON: {memory_id: delta}
  consolidation_model TEXT,
  consolidation_prompt_hash TEXT,
  started_at TEXT,
  completed_at TEXT,
  status TEXT                    -- running | completed | failed | rolled_back
);
```

---

## Confidence Formula

Confidence is compositional, not monolithic:

```
C(m, t) = w_s * S(m) + w_e * E(m) + w_r * R(m, t) + w_ret * Ret(m, t)
```

Where:

| Component | Symbol | Description | Learned/Tuned |
|-----------|--------|-------------|---------------|
| Source reliability | S(m) | Based on source type hierarchy | Hand-tuned defaults, adjustable per agent |
| Evidence agreement | E(m) | supporting / (supporting + contradicting) | Computed |
| Recency decay | R(m, t) | e^(-lambda * t), lambda = ln(2) / half_life | Half-lives are hand-tuned per memory type |
| Retrieval reinforcement | Ret(m, t) | min(1.0, 0.3 * ln(1 + retrieval_count) * e^(-lambda_ret * t_since_retrieval)) | Coefficients hand-tuned initially |

**Default weights:** w_s = 0.30, w_e = 0.35, w_r = 0.20, w_ret = 0.15

**Source reliability defaults:**

| Source Type | Default Reliability |
|------------|-------------------|
| direct-observation | 0.95 |
| told-by-user | 0.90 |
| tool-result | 0.85 |
| inference | 0.60 |
| model-generated | 0.40 |

**Decay half-lives:**

| Memory Type | Half-Life | Rationale |
|------------|-----------|-----------|
| Episodic | 7 days | Raw events become stale fast |
| Semantic | 30 days | Hard-won principles should persist |
| Procedural | 90 days | Skills are the slowest to decay |

---

## Memory Pipeline

### 1. ENCODE (Synchronous, fast)

Agent observes something. Create immutable episodic record:
- Generate ULID (time-sortable)
- Compute embedding via configured model
- Assign source_reliability from source type
- Store with full causal context
- Trigger async validation

### 2. VALIDATE (Async, after encode)

Check new memory against existing knowledge:
- **Reinforcement**: If similar memory exists (embedding similarity > 0.85), boost evidence_count on the existing semantic memory. Do NOT boost confidence from self-citations (same provenance chain).
- **Contradiction**: If memory conflicts with existing knowledge (detected via LLM comparison), create contradiction record. Both claims preserved. Resolution logic:
  - If confidence delta > 0.3: higher-confidence claim becomes `active`, lower becomes `disputed`
  - If confidence delta <= 0.3: both remain `active`, flagged for human/agent review
  - Context-dependent: both marked `context_dependent` with conditions
- **Reopen**: If a `superseded` or `disputed` memory gets 3+ new supporting episodes from independent sources, reopen the contradiction

### 3. CONSOLIDATE (Background, periodic)

The "sleep" cycle. Runs on configurable interval (default: 1 hour).

**Pipeline: Clustering -> Principle Extraction -> Causal Linking -> Conflict Resolution -> Promotion**

```
Step 1: CLUSTER
  - Fetch unconsolidated episodes since last checkpoint
  - Cluster by embedding similarity (threshold: 0.80)
  - Require minimum cluster size (adaptive, not fixed N=3):
    consolidation_threshold = max(
      min_episodes,
      ceil(cluster_variance * confidence_target)
    )
    where cluster_variance is the spread of embeddings in the cluster
    Default min_episodes = 3, confidence_target = 2.0

Step 2: EXTRACT PRINCIPLE
  - For each qualifying cluster, call LLM to extract generalized principle
  - Prompt includes: all episode contents, their sources, confidence scores
  - LLM must articulate the principle AND its boundary conditions
  - LLM must identify whether evidence is from diverse sources
  - Independent evidence requirement: at least 2 distinct source types

Step 3: CAUSAL LINKING
  - For episodes with causal_trigger/causal_consequence fields
  - Call LLM to articulate mechanism (not just "A then B")
  - Classify as causal vs correlational vs temporal
  - Spurious correlation detection: require mechanistic explanation

Step 4: CONFLICT RESOLUTION
  - Check new principles against existing semantic memories
  - If conflict: create contradiction record, apply resolution logic
  - If reinforcement: boost evidence_count

Step 5: PROMOTION
  - Write new semantic/procedural memories
  - Link back to source episodes
  - Mark episodes as consolidated (but don't delete — may need vivid recall)
  - Write consolidation_run record with full audit trail
  - Checkpoint cursor for resumability
```

### 4. RETRIEVE (Synchronous, fast)

When agent needs knowledge:
- Semantic search across all memory types (sqlite-vec)
- Score results: `relevance * confidence * recency_boost`
- Weight by memory type if specified (prefer semantic over episodic for general queries)
- Return with full provenance chain
- **Reinforcement on retrieval**: Increment retrieval_count, update last_reinforced_at
- **Self-citation guard**: If the retriever is the same agent that created the memory via inference, retrieval does NOT boost confidence

### 5. DECAY (Background, continuous)

Ebbinghaus-inspired forgetting:
- Apply decay formula to all memories on configurable schedule
- Memories below threshold (0.1 confidence) become `dormant`
- Dormant memories: still searchable via explicit flag, excluded from default recall
- Memories are never deleted — only dormant

---

## Circular Self-Confirmation Prevention

The critical exploit: agent hallucinates X, encodes it, later retrieves it, "reinforcement" boosts confidence, eventually consolidates false principle.

**Defenses:**

1. **Source lineage tracking**: Every memory tracks full provenance chain. If entire evidence chain traces to same original inference, retrieval does NOT boost confidence.
2. **Independent evidence requirement**: Consolidation requires evidence from >= 2 distinct source types (e.g., direct-observation + tool-result, not 3x inference).
3. **Self-citation detection**: Consolidation engine checks if clustered episodes share a common ancestor. If so, they count as 1 piece of evidence, not N.
4. **Confidence ceiling for model-generated**: Memories from `model-generated` source are capped at 0.6 confidence regardless of reinforcement.
5. **Source diversity score**: Stored on every semantic memory. Low diversity = lower consolidation priority.

---

## Context-Dependent Truth Handling

Not all contradictions have a winner. Model it explicitly:

```json
{
  "claim_a": { "id": "sem-42", "content": "Stripe rate limit is 100 req/s" },
  "claim_b": { "id": "sem-67", "content": "Stripe rate limit is 25 req/s" },
  "state": "context_dependent",
  "conditions": {
    "claim_a": { "context": "live-mode API keys", "confidence": 0.9 },
    "claim_b": { "context": "test-mode API keys", "confidence": 0.85 }
  }
}
```

Memory states: `active` | `disputed` | `superseded` | `context_dependent` | `dormant`

---

## Embedding and Model Versioning

Every derived artifact stores:
- `embedding_model`: e.g., "text-embedding-3-small"
- `embedding_version`: e.g., "2024-01-25"
- `consolidation_model`: e.g., "claude-sonnet-4-6"
- `consolidation_prompt_hash`: SHA-256 of the prompt template

When models change:
- New memories use new model
- Re-embedding queue: background process re-embeds old memories with new model
- Re-consolidation queue: optionally re-run consolidation with new model
- Old embeddings preserved until migration complete

---

## Rollback Strategy

When a bad consolidation pollutes semantic memory:

```js
// Every consolidation run has a numbered checkpoint
const runs = await brain.consolidationHistory();
// [{id: 'run-47', status: 'completed', output_memory_ids: [...], ...}]

// Rollback: remove all semantic/procedural memories created after checkpoint
await brain.rollback('run-47');
// - Marks affected semantic memories as 'rolled_back'
// - Restores episode consolidation states
// - Creates audit record of the rollback
```

Consolidation log is append-only. Every consolidation can be fully unwound.

---

## Red Team Analysis

**Most dangerous exploit: Slow confidence inflation via coordinated low-quality sources.**

Attack vector:
1. Inject many low-confidence memories from `model-generated` sources that agree on a false claim
2. evidence_agreement climbs because N memories "agree"
3. Eventually consolidation extracts false principle

Defenses:
- Independent evidence requirement (source type diversity)
- Confidence ceiling for model-generated source type (0.6 max)
- Source diversity score tracked on semantic memories
- Alert when consolidation produces principle from single source type

**Second most dangerous: Temporal correlation masquerading as causation.**

Attack vector: Two events repeatedly co-occur. System infers causal link where none exists.

Defenses:
- Causal links require LLM-articulated mechanism
- `causal` vs `correlational` vs `temporal` classification
- Correlational links weighted lower in retrieval

---

## SDK Interface

```js
import { Audrey } from 'audrey';

const brain = new Audrey({
  dataDir: './audrey-data',
  agent: 'my-coding-agent',
  embedding: {
    provider: 'openai',        // or 'anthropic', 'ollama', custom
    model: 'text-embedding-3-small'
  },
  consolidation: {
    interval: '1h',
    minEpisodes: 3,
    confidenceTarget: 2.0,
    llm: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6'
    }
  },
  decay: {
    episodic:   { halfLife: '7d' },
    semantic:   { halfLife: '30d' },
    procedural: { halfLife: '90d' },
    dormantThreshold: 0.1
  }
});

// --- ENCODE ---
await brain.encode({
  content: 'Stripe API returned 429 when sending > 100 req/s',
  source: 'direct-observation',
  salience: 0.8,
  causal: {
    trigger: 'batch-payment-processing',
    consequence: 'payment-queue-backed-up'
  },
  tags: ['stripe', 'rate-limiting', 'production']
});

// --- RECALL ---
const memories = await brain.recall('stripe rate limits', {
  minConfidence: 0.5,
  types: ['semantic', 'procedural'],
  limit: 5,
  includeProvenance: true,
  includeDormant: false
});

// --- EVENTS ---
brain.on('contradiction', ({ existing, incoming, resolution }) => {
  // Handle contradiction detection
});

brain.on('consolidation', ({ episodes, principle, checkpoint }) => {
  // Handle new principle extraction
});

brain.on('reopen', ({ contradiction, newEvidence }) => {
  // Handle reopened dispute
});

// --- ROLLBACK ---
await brain.rollback('consolidation-run-47');

// --- INTROSPECTION ---
const stats = await brain.introspect();
// {
//   episodic: 1247, semantic: 89, procedural: 23,
//   causalLinks: 156, dormant: 340,
//   contradictions: { open: 3, resolved: 12, context_dependent: 5 },
//   lastConsolidation: '2026-02-18T14:00:00Z',
//   sourceTypeDiversity: { ... }
// }
```

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|------------|
| Mistake repetition rate | < 5% | How often agent makes same class of mistake twice (vs ~50% without Audrey) |
| Knowledge retrieval precision | > 90% | Relevance + correctness of recalled memories (human eval) |
| Consolidation accuracy | > 85% | Are extracted principles true generalizations? (human eval) |

## Proof-of-Concept Scope

**10-minute demo for a skeptical engineer:**

A coding agent that:
1. Hits a Stripe rate limit, Audrey encodes the observation
2. Hits it again from a different code path, Audrey encodes again
3. Consolidation runs, extracts principle: "Stripe needs request throttling at 100 req/s"
4. On third encounter, agent recalls the principle BEFORE hitting the error
5. Agent implements throttling preemptively

Proves: episodic capture -> consolidation -> proactive recall.

## Scale Boundaries

This architecture breaks first at:
- **~100k episodic memories**: SQLite with sqlite-vec starts to slow on similarity search. Adapter path: pgvector migration.
- **~10 concurrent agents**: File-based locking becomes bottleneck. Adapter path: shared PostgreSQL backend.
- **Consolidation throughput**: 1000+ episodes per consolidation run hits LLM cost/latency. Adapter path: batch embedding, chunked consolidation.

Pre-designed adapter interfaces for pgvector, Redis, and dedicated vector DBs.

## Open Questions

1. Should consolidation be triggered by event count rather than time interval?
2. What's the right privacy model for memories containing PII/secrets?
3. Should the SDK include built-in PII detection and redaction?
4. How should cross-agent knowledge sharing work (future Hivemind integration)?
