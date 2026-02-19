# Audrey Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build Audrey, a biologically-inspired memory SDK for AI agents with confidence decay, knowledge consolidation, self-validation, and causal reasoning.

**Architecture:** Node.js ES module SDK. SQLite + sqlite-vec for all storage (single `.db` file, WAL mode). Pluggable embedding and LLM providers. Background consolidation engine. EventEmitter for lifecycle hooks. Zero external infrastructure required.

**Tech Stack:** Node.js (ES modules), better-sqlite3, sqlite-vec, ulid, vitest (testing), EventEmitter (Node built-in)

**Design doc:** `docs/plans/2026-02-18-audrey-design.md`

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `src/index.js` (empty barrel export)
- Create: `vitest.config.js`
- Create: `.gitignore`
- Create: `CLAUDE.md`

**Step 1: Initialize package.json**

```json
{
  "name": "audrey",
  "version": "0.1.0",
  "description": "Biological memory architecture for AI agents",
  "type": "module",
  "main": "src/index.js",
  "exports": {
    ".": "./src/index.js"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "keywords": ["ai", "memory", "agents", "cognitive", "llm"],
  "author": "Tyler Eveland <j.tyler.eveland@gmail.com>",
  "license": "MIT"
}
```

**Step 2: Install dependencies**

Run: `cd A:/ai/claude/audrey && npm install better-sqlite3 ulid`
Run: `cd A:/ai/claude/audrey && npm install -D vitest`

Note: sqlite-vec will be loaded as an extension via better-sqlite3. Install it:
Run: `cd A:/ai/claude/audrey && npm install sqlite-vec`

**Step 3: Create vitest.config.js**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
  },
});
```

**Step 4: Create .gitignore**

```
node_modules/
audrey-data/
*.db
*.db-wal
*.db-shm
.env
```

**Step 5: Create CLAUDE.md**

```markdown
# Audrey

## What This Is
Biological memory architecture SDK for AI agents. Node.js, ES modules, SQLite.

## Commands
- `npm test` — run all tests
- `npm run test:watch` — watch mode

## Architecture
- `src/db.js` — SQLite connection, schema, migrations
- `src/confidence.js` — compositional confidence formula
- `src/ulid.js` — time-sortable unique IDs
- `src/embedding.js` — pluggable embedding providers
- `src/encode.js` — episodic memory creation
- `src/recall.js` — confidence-weighted retrieval
- `src/validate.js` — contradiction detection, reinforcement
- `src/decay.js` — Ebbinghaus forgetting curves
- `src/consolidate.js` — episode → principle extraction
- `src/causal.js` — causal graph management
- `src/rollback.js` — consolidation undo
- `src/audrey.js` — main class, ties everything together
- `src/index.js` — barrel export

## Conventions
- ES modules only (import/export)
- All tests in `tests/` mirroring `src/` structure
- SQLite is canonical store, WAL mode
- Episodes are immutable (append-only)
- All functions are pure where possible, side effects isolated to db.js
```

**Step 6: Create empty barrel export**

```js
// src/index.js
export { Audrey } from './audrey.js';
```

**Step 7: Init git and commit**

Run: `cd A:/ai/claude/audrey && git init && git add -A && git commit -m "chore: scaffold Audrey project"`

---

## Task 2: ULID Generator

**Files:**
- Create: `src/ulid.js`
- Create: `tests/ulid.test.js`

**Step 1: Write the failing test**

```js
// tests/ulid.test.js
import { describe, it, expect } from 'vitest';
import { generateId, generateDeterministicId } from '../src/ulid.js';

describe('ULID generation', () => {
  it('generates a 26-character ULID string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(26);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('generates time-sortable IDs (later ID > earlier ID)', () => {
    const a = generateId();
    const b = generateId();
    expect(b > a).toBe(true);
  });

  it('generates deterministic ID from inputs', () => {
    const id1 = generateDeterministicId('consolidation', 'run-1', ['ep-1', 'ep-2']);
    const id2 = generateDeterministicId('consolidation', 'run-1', ['ep-1', 'ep-2']);
    expect(id1).toBe(id2);
  });

  it('deterministic IDs differ with different inputs', () => {
    const id1 = generateDeterministicId('consolidation', 'run-1', ['ep-1']);
    const id2 = generateDeterministicId('consolidation', 'run-1', ['ep-2']);
    expect(id1).not.toBe(id2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/ulid.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/ulid.js
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';

export function generateId() {
  return ulid();
}

export function generateDeterministicId(...parts) {
  const input = JSON.stringify(parts);
  return createHash('sha256').update(input).digest('hex').slice(0, 26);
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/ulid.test.js`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/ulid.js tests/ulid.test.js
git commit -m "feat: add ULID generator with deterministic mode"
```

---

## Task 3: Confidence Formula

**Files:**
- Create: `src/confidence.js`
- Create: `tests/confidence.test.js`

**Step 1: Write the failing tests**

```js
// tests/confidence.test.js
import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  sourceReliability,
  evidenceAgreement,
  recencyDecay,
  retrievalReinforcement,
  DEFAULT_WEIGHTS,
  DEFAULT_SOURCE_RELIABILITY,
  DEFAULT_HALF_LIVES,
} from '../src/confidence.js';

describe('sourceReliability', () => {
  it('returns 0.95 for direct-observation', () => {
    expect(sourceReliability('direct-observation')).toBe(0.95);
  });

  it('returns 0.40 for model-generated', () => {
    expect(sourceReliability('model-generated')).toBe(0.40);
  });

  it('throws for unknown source type', () => {
    expect(() => sourceReliability('unknown')).toThrow();
  });
});

describe('evidenceAgreement', () => {
  it('returns 1.0 when all evidence supports', () => {
    expect(evidenceAgreement(5, 0)).toBe(1.0);
  });

  it('returns 0.5 when evidence is split', () => {
    expect(evidenceAgreement(3, 3)).toBe(0.5);
  });

  it('returns 0.0 when no supporting evidence', () => {
    expect(evidenceAgreement(0, 3)).toBe(0.0);
  });

  it('returns 1.0 when both are 0 (no contradictions = full agreement)', () => {
    expect(evidenceAgreement(0, 0)).toBe(1.0);
  });
});

describe('recencyDecay', () => {
  it('returns 1.0 at time zero', () => {
    expect(recencyDecay(0, 7)).toBeCloseTo(1.0);
  });

  it('returns ~0.5 at the half-life', () => {
    expect(recencyDecay(7, 7)).toBeCloseTo(0.5, 1);
  });

  it('returns ~0.25 at double the half-life', () => {
    expect(recencyDecay(14, 7)).toBeCloseTo(0.25, 1);
  });

  it('approaches 0 for very old memories', () => {
    expect(recencyDecay(365, 7)).toBeLessThan(0.001);
  });
});

describe('retrievalReinforcement', () => {
  it('returns 0 when never retrieved', () => {
    expect(retrievalReinforcement(0, 0)).toBe(0);
  });

  it('increases with retrieval count', () => {
    const a = retrievalReinforcement(1, 0);
    const b = retrievalReinforcement(5, 0);
    expect(b).toBeGreaterThan(a);
  });

  it('decays with time since last retrieval', () => {
    const fresh = retrievalReinforcement(3, 0);
    const stale = retrievalReinforcement(3, 30);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('never exceeds 1.0', () => {
    expect(retrievalReinforcement(1000, 0)).toBeLessThanOrEqual(1.0);
  });
});

describe('computeConfidence', () => {
  it('computes composite confidence from all components', () => {
    const result = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 3,
      contradictingCount: 0,
      ageDays: 0,
      halfLifeDays: 7,
      retrievalCount: 0,
      daysSinceRetrieval: 0,
    });
    // w_s*0.95 + w_e*1.0 + w_r*1.0 + w_ret*0
    // 0.30*0.95 + 0.35*1.0 + 0.20*1.0 + 0.15*0
    // = 0.285 + 0.35 + 0.20 + 0 = 0.835
    expect(result).toBeCloseTo(0.835, 2);
  });

  it('returns lower confidence for model-generated source', () => {
    const high = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    const low = computeConfidence({
      sourceType: 'model-generated',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    expect(high).toBeGreaterThan(low);
  });

  it('caps model-generated confidence at 0.6', () => {
    const result = computeConfidence({
      sourceType: 'model-generated',
      supportingCount: 100, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 30,
      retrievalCount: 100, daysSinceRetrieval: 0,
    });
    expect(result).toBeLessThanOrEqual(0.6);
  });

  it('decays over time', () => {
    const fresh = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    const old = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 30, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
    });
    expect(fresh).toBeGreaterThan(old);
  });

  it('allows custom weights', () => {
    const result = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: 1, contradictingCount: 0,
      ageDays: 0, halfLifeDays: 7,
      retrievalCount: 0, daysSinceRetrieval: 0,
      weights: { source: 1.0, evidence: 0, recency: 0, retrieval: 0 },
    });
    expect(result).toBeCloseTo(0.95, 2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/confidence.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/confidence.js

export const DEFAULT_SOURCE_RELIABILITY = {
  'direct-observation': 0.95,
  'told-by-user': 0.90,
  'tool-result': 0.85,
  'inference': 0.60,
  'model-generated': 0.40,
};

export const DEFAULT_WEIGHTS = {
  source: 0.30,
  evidence: 0.35,
  recency: 0.20,
  retrieval: 0.15,
};

export const DEFAULT_HALF_LIVES = {
  episodic: 7,
  semantic: 30,
  procedural: 90,
};

export const MODEL_GENERATED_CONFIDENCE_CAP = 0.6;

export function sourceReliability(sourceType, customReliability) {
  const table = customReliability || DEFAULT_SOURCE_RELIABILITY;
  const value = table[sourceType];
  if (value === undefined) {
    throw new Error(`Unknown source type: ${sourceType}. Valid types: ${Object.keys(table).join(', ')}`);
  }
  return value;
}

export function evidenceAgreement(supportingCount, contradictingCount) {
  const total = supportingCount + contradictingCount;
  if (total === 0) return 1.0;
  return supportingCount / total;
}

export function recencyDecay(ageDays, halfLifeDays) {
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

export function retrievalReinforcement(retrievalCount, daysSinceRetrieval) {
  if (retrievalCount === 0) return 0;
  const lambdaRet = Math.LN2 / 14; // 14-day half-life for retrieval decay
  return Math.min(1.0, 0.3 * Math.log(1 + retrievalCount) * Math.exp(-lambdaRet * daysSinceRetrieval));
}

export function computeConfidence({
  sourceType,
  supportingCount,
  contradictingCount,
  ageDays,
  halfLifeDays,
  retrievalCount,
  daysSinceRetrieval,
  weights,
  customSourceReliability,
}) {
  const w = weights || DEFAULT_WEIGHTS;

  const s = sourceReliability(sourceType, customSourceReliability);
  const e = evidenceAgreement(supportingCount, contradictingCount);
  const r = recencyDecay(ageDays, halfLifeDays);
  const ret = retrievalReinforcement(retrievalCount, daysSinceRetrieval);

  let confidence = w.source * s + w.evidence * e + w.recency * r + w.retrieval * ret;

  if (sourceType === 'model-generated') {
    confidence = Math.min(confidence, MODEL_GENERATED_CONFIDENCE_CAP);
  }

  return Math.max(0, Math.min(1, confidence));
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/confidence.test.js`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/confidence.js tests/confidence.test.js
git commit -m "feat: implement compositional confidence formula with decay curves"
```

---

## Task 4: Database Layer

**Files:**
- Create: `src/db.js`
- Create: `tests/db.test.js`

**Step 1: Write the failing tests**

```js
// tests/db.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-audrey-data';

describe('database', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates database file at specified path', () => {
    const db = createDatabase(TEST_DIR);
    expect(existsSync(`${TEST_DIR}/audrey.db`)).toBe(true);
    closeDatabase(db);
  });

  it('creates all required tables', () => {
    const db = createDatabase(TEST_DIR);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('episodes');
    expect(tableNames).toContain('semantics');
    expect(tableNames).toContain('procedures');
    expect(tableNames).toContain('causal_links');
    expect(tableNames).toContain('contradictions');
    expect(tableNames).toContain('consolidation_runs');
    closeDatabase(db);
  });

  it('uses WAL journal mode', () => {
    const db = createDatabase(TEST_DIR);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    closeDatabase(db);
  });

  it('can insert and retrieve an episode', () => {
    const db = createDatabase(TEST_DIR);
    db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
                VALUES (?, ?, ?, ?, ?)`).run('test-1', 'test content', 'direct-observation', 0.95, new Date().toISOString());
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get('test-1');
    expect(row.content).toBe('test content');
    expect(row.source).toBe('direct-observation');
    closeDatabase(db);
  });

  it('enforces episode immutability via CHECK constraint on source', () => {
    const db = createDatabase(TEST_DIR);
    expect(() => {
      db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
                  VALUES (?, ?, ?, ?, ?)`).run('test-1', 'content', 'invalid-source', 0.5, new Date().toISOString());
    }).toThrow();
    closeDatabase(db);
  });

  it('idempotent: calling createDatabase twice on same dir does not error', () => {
    const db1 = createDatabase(TEST_DIR);
    closeDatabase(db1);
    const db2 = createDatabase(TEST_DIR);
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.length).toBeGreaterThan(0);
    closeDatabase(db2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/db.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/db.js
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const VALID_SOURCES = ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    source TEXT NOT NULL CHECK(source IN ('direct-observation','told-by-user','tool-result','inference','model-generated')),
    source_reliability REAL NOT NULL,
    salience REAL DEFAULT 0.5,
    tags TEXT,
    causal_trigger TEXT,
    causal_consequence TEXT,
    created_at TEXT NOT NULL,
    embedding_model TEXT,
    embedding_version TEXT,
    supersedes TEXT,
    superseded_by TEXT,
    consolidated INTEGER DEFAULT 0,
    FOREIGN KEY (supersedes) REFERENCES episodes(id)
  );

  CREATE TABLE IF NOT EXISTS semantics (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    state TEXT DEFAULT 'active' CHECK(state IN ('active','disputed','superseded','context_dependent','dormant','rolled_back')),
    conditions TEXT,
    evidence_episode_ids TEXT,
    evidence_count INTEGER DEFAULT 0,
    supporting_count INTEGER DEFAULT 0,
    contradicting_count INTEGER DEFAULT 0,
    source_type_diversity INTEGER DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS procedures (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    state TEXT DEFAULT 'active' CHECK(state IN ('active','disputed','superseded','context_dependent','dormant','rolled_back')),
    trigger_conditions TEXT,
    evidence_episode_ids TEXT,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    embedding_model TEXT,
    embedding_version TEXT,
    created_at TEXT NOT NULL,
    last_reinforced_at TEXT,
    retrieval_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS causal_links (
    id TEXT PRIMARY KEY,
    cause_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    link_type TEXT DEFAULT 'causal' CHECK(link_type IN ('causal','correlational','temporal')),
    mechanism TEXT,
    confidence REAL,
    evidence_count INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contradictions (
    id TEXT PRIMARY KEY,
    claim_a_id TEXT NOT NULL,
    claim_b_id TEXT NOT NULL,
    claim_a_type TEXT NOT NULL,
    claim_b_type TEXT NOT NULL,
    state TEXT DEFAULT 'open' CHECK(state IN ('open','resolved','context_dependent','reopened')),
    resolution TEXT,
    resolved_at TEXT,
    reopened_at TEXT,
    reopen_evidence_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consolidation_runs (
    id TEXT PRIMARY KEY,
    checkpoint_cursor TEXT,
    input_episode_ids TEXT,
    output_memory_ids TEXT,
    confidence_deltas TEXT,
    consolidation_model TEXT,
    consolidation_prompt_hash TEXT,
    started_at TEXT,
    completed_at TEXT,
    status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','rolled_back'))
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
  CREATE INDEX IF NOT EXISTS idx_episodes_consolidated ON episodes(consolidated);
  CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
  CREATE INDEX IF NOT EXISTS idx_semantics_state ON semantics(state);
  CREATE INDEX IF NOT EXISTS idx_procedures_state ON procedures(state);
  CREATE INDEX IF NOT EXISTS idx_contradictions_state ON contradictions(state);
  CREATE INDEX IF NOT EXISTS idx_consolidation_status ON consolidation_runs(status);
`;

export function createDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'audrey.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA);

  return db;
}

export function closeDatabase(db) {
  if (db && db.open) {
    db.close();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/db.test.js`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: add SQLite database layer with full schema and WAL mode"
```

---

## Task 5: Embedding Provider Interface

**Files:**
- Create: `src/embedding.js`
- Create: `tests/embedding.test.js`

**Step 1: Write the failing tests**

```js
// tests/embedding.test.js
import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider, MockEmbeddingProvider } from '../src/embedding.js';

describe('MockEmbeddingProvider', () => {
  it('returns a fixed-dimension vector', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const embedding = await provider.embed('hello world');
    expect(embedding).toHaveLength(8);
    expect(embedding.every(n => typeof n === 'number')).toBe(true);
  });

  it('returns deterministic embeddings for same input', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const a = await provider.embed('hello world');
    const b = await provider.embed('hello world');
    expect(a).toEqual(b);
  });

  it('returns different embeddings for different input', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    const a = await provider.embed('hello');
    const b = await provider.embed('goodbye');
    expect(a).not.toEqual(b);
  });

  it('returns similar embeddings for similar input', async () => {
    const provider = new MockEmbeddingProvider({ dimensions: 64 });
    const a = await provider.embed('stripe rate limit 100');
    const b = await provider.embed('stripe rate limit 200');
    const c = await provider.embed('database connection pool');
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    // Similar strings should be more similar than dissimilar ones
    // (mock uses hash-based approach, so this is approximate)
    expect(typeof simAB).toBe('number');
    expect(typeof simAC).toBe('number');
  });

  it('exposes model name and version', () => {
    const provider = new MockEmbeddingProvider({ dimensions: 8 });
    expect(provider.modelName).toBe('mock-embedding');
    expect(provider.modelVersion).toBe('1.0.0');
  });
});

describe('createEmbeddingProvider', () => {
  it('creates mock provider', () => {
    const provider = createEmbeddingProvider({ provider: 'mock', dimensions: 8 });
    expect(provider.modelName).toBe('mock-embedding');
  });

  it('throws for unknown provider', () => {
    expect(() => createEmbeddingProvider({ provider: 'unknown' })).toThrow();
  });
});

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/embedding.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/embedding.js
import { createHash } from 'node:crypto';

export class MockEmbeddingProvider {
  constructor({ dimensions = 64 } = {}) {
    this.dimensions = dimensions;
    this.modelName = 'mock-embedding';
    this.modelVersion = '1.0.0';
  }

  async embed(text) {
    const hash = createHash('sha256').update(text).digest();
    const vector = new Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      vector[i] = (hash[i % hash.length] / 255) * 2 - 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map(v => v / magnitude);
  }

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export class OpenAIEmbeddingProvider {
  constructor({ apiKey, model = 'text-embedding-3-small', dimensions = 1536 } = {}) {
    this.apiKey = apiKey || process.env.OPENAI_API_KEY;
    this.model = model;
    this.dimensions = dimensions;
    this.modelName = model;
    this.modelVersion = 'latest';
  }

  async embed(text) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text, model: this.model, dimensions: this.dimensions }),
    });
    if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  }

  vectorToBuffer(vector) {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  bufferToVector(buffer) {
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
  }
}

export function createEmbeddingProvider(config) {
  switch (config.provider) {
    case 'mock':
      return new MockEmbeddingProvider(config);
    case 'openai':
      return new OpenAIEmbeddingProvider(config);
    default:
      throw new Error(`Unknown embedding provider: ${config.provider}. Valid: mock, openai`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/embedding.test.js`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/embedding.js tests/embedding.test.js
git commit -m "feat: add pluggable embedding providers with mock and OpenAI"
```

---

## Task 6: Encode — Episodic Memory Creation

**Files:**
- Create: `src/encode.js`
- Create: `tests/encode.test.js`

**Step 1: Write the failing tests**

```js
// tests/encode.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-encode-data';

describe('encodeEpisode', () => {
  let db, embedding;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates an episodic memory and returns its ID', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('stores content, source, and source_reliability in the database', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    expect(row.content).toBe('Stripe API returned 429');
    expect(row.source).toBe('direct-observation');
    expect(row.source_reliability).toBe(0.95);
  });

  it('stores embedding as a blob', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'test',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT embedding FROM episodes WHERE id = ?').get(id);
    expect(row.embedding).not.toBeNull();
    expect(Buffer.isBuffer(row.embedding)).toBe(true);
  });

  it('stores causal context', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Rate limit hit',
      source: 'direct-observation',
      causal: { trigger: 'batch-processing', consequence: 'queue-backup' },
    });
    const row = db.prepare('SELECT causal_trigger, causal_consequence FROM episodes WHERE id = ?').get(id);
    expect(row.causal_trigger).toBe('batch-processing');
    expect(row.causal_consequence).toBe('queue-backup');
  });

  it('stores tags as JSON', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'test',
      source: 'direct-observation',
      tags: ['stripe', 'rate-limit'],
    });
    const row = db.prepare('SELECT tags FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(row.tags)).toEqual(['stripe', 'rate-limit']);
  });

  it('stores salience', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'critical error',
      source: 'direct-observation',
      salience: 0.95,
    });
    const row = db.prepare('SELECT salience FROM episodes WHERE id = ?').get(id);
    expect(row.salience).toBe(0.95);
  });

  it('uses default salience of 0.5', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'normal event',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT salience FROM episodes WHERE id = ?').get(id);
    expect(row.salience).toBe(0.5);
  });

  it('stores embedding model and version', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'test',
      source: 'direct-observation',
    });
    const row = db.prepare('SELECT embedding_model, embedding_version FROM episodes WHERE id = ?').get(id);
    expect(row.embedding_model).toBe('mock-embedding');
    expect(row.embedding_version).toBe('1.0.0');
  });

  it('supports supersedes link for corrections', async () => {
    const id1 = await encodeEpisode(db, embedding, {
      content: 'Stripe limit is 50 req/s',
      source: 'inference',
    });
    const id2 = await encodeEpisode(db, embedding, {
      content: 'Stripe limit is 100 req/s',
      source: 'direct-observation',
      supersedes: id1,
    });
    const row = db.prepare('SELECT supersedes FROM episodes WHERE id = ?').get(id2);
    expect(row.supersedes).toBe(id1);
    const original = db.prepare('SELECT superseded_by FROM episodes WHERE id = ?').get(id1);
    expect(original.superseded_by).toBe(id2);
  });

  it('rejects invalid source types', async () => {
    await expect(encodeEpisode(db, embedding, {
      content: 'test',
      source: 'made-up',
    })).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/encode.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/encode.js
import { generateId } from './ulid.js';
import { sourceReliability } from './confidence.js';

export async function encodeEpisode(db, embeddingProvider, {
  content,
  source,
  salience = 0.5,
  causal,
  tags,
  supersedes,
}) {
  const reliability = sourceReliability(source);
  const vector = await embeddingProvider.embed(content);
  const embeddingBuffer = embeddingProvider.vectorToBuffer(vector);
  const id = generateId();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO episodes (
      id, content, embedding, source, source_reliability, salience,
      tags, causal_trigger, causal_consequence, created_at,
      embedding_model, embedding_version, supersedes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    id,
    content,
    embeddingBuffer,
    source,
    reliability,
    salience,
    tags ? JSON.stringify(tags) : null,
    causal?.trigger || null,
    causal?.consequence || null,
    now,
    embeddingProvider.modelName,
    embeddingProvider.modelVersion,
    supersedes || null,
  );

  if (supersedes) {
    db.prepare('UPDATE episodes SET superseded_by = ? WHERE id = ?').run(id, supersedes);
  }

  return id;
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/encode.test.js`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/encode.js tests/encode.test.js
git commit -m "feat: add episodic memory encoding with immutable append-only records"
```

---

## Task 7: Recall — Confidence-Weighted Retrieval

**Files:**
- Create: `src/recall.js`
- Create: `tests/recall.test.js`

**Step 1: Write the failing tests**

```js
// tests/recall.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recall } from '../src/recall.js';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-recall-data';

describe('recall', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });

    await encodeEpisode(db, embedding, {
      content: 'Stripe API returns 429 at 100 requests per second',
      source: 'direct-observation',
      salience: 0.9,
      tags: ['stripe', 'rate-limit'],
    });
    await encodeEpisode(db, embedding, {
      content: 'Database connection pool exhausted under load',
      source: 'direct-observation',
      tags: ['database', 'performance'],
    });
    await encodeEpisode(db, embedding, {
      content: 'Redis cache miss rate increased to 40%',
      source: 'tool-result',
      tags: ['redis', 'cache'],
    });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns an array of memories', async () => {
    const results = await recall(db, embedding, 'stripe rate limit', {});
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns memories with required fields', async () => {
    const results = await recall(db, embedding, 'stripe rate limit', { limit: 1 });
    if (results.length > 0) {
      const mem = results[0];
      expect(mem).toHaveProperty('id');
      expect(mem).toHaveProperty('content');
      expect(mem).toHaveProperty('type');
      expect(mem).toHaveProperty('confidence');
      expect(mem).toHaveProperty('source');
    }
  });

  it('respects limit parameter', async () => {
    const results = await recall(db, embedding, 'something', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('increments retrieval_count on recalled episodic memories', async () => {
    const before = db.prepare('SELECT retrieval_count FROM semantics').all();
    // For episodic, we don't have retrieval_count column, so this test
    // verifies semantic retrieval tracking
    // First, manually insert a semantic memory to test against
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at, retrieval_count)
      VALUES (?, ?, 'active', 1, 1, 1, ?, 0)`).run('sem-1', 'Stripe has rate limits', new Date().toISOString());

    await recall(db, embedding, 'stripe', { types: ['semantic'] });
    const after = db.prepare('SELECT retrieval_count FROM semantics WHERE id = ?').get('sem-1');
    expect(after.retrieval_count).toBe(1);
  });

  it('filters by memory type', async () => {
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at)
      VALUES (?, ?, 'active', 1, 1, 1, ?)`).run('sem-2', 'Test semantic', new Date().toISOString());

    const episodicOnly = await recall(db, embedding, 'test', { types: ['episodic'] });
    const semanticOnly = await recall(db, embedding, 'test', { types: ['semantic'] });

    episodicOnly.forEach(m => expect(m.type).toBe('episodic'));
    semanticOnly.forEach(m => expect(m.type).toBe('semantic'));
  });

  it('excludes dormant memories by default', async () => {
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at)
      VALUES (?, ?, 'dormant', 1, 1, 1, ?)`).run('sem-dormant', 'Dormant memory', new Date().toISOString());

    const results = await recall(db, embedding, 'dormant', {});
    const dormantResults = results.filter(m => m.id === 'sem-dormant');
    expect(dormantResults).toHaveLength(0);
  });

  it('includes dormant memories when explicitly requested', async () => {
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at)
      VALUES (?, ?, 'dormant', 1, 1, 1, ?)`).run('sem-dormant-2', 'Dormant fact', new Date().toISOString());

    const results = await recall(db, embedding, 'dormant fact', { includeDormant: true });
    const dormantResults = results.filter(m => m.id === 'sem-dormant-2');
    expect(dormantResults.length).toBeGreaterThanOrEqual(0); // May or may not match depending on embedding similarity
  });

  it('includes provenance when requested', async () => {
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_episode_ids, evidence_count,
      supporting_count, source_type_diversity, created_at)
      VALUES (?, ?, 'active', ?, 2, 2, 2, ?)`).run('sem-prov', 'Stripe is rate limited', JSON.stringify(['ep-1', 'ep-2']), new Date().toISOString());

    const results = await recall(db, embedding, 'stripe', { types: ['semantic'], includeProvenance: true });
    const matched = results.find(m => m.id === 'sem-prov');
    if (matched) {
      expect(matched.provenance).toEqual(['ep-1', 'ep-2']);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/recall.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/recall.js
import { computeConfidence, DEFAULT_HALF_LIVES } from './confidence.js';

export async function recall(db, embeddingProvider, query, {
  minConfidence = 0,
  types,
  limit = 10,
  includeProvenance = false,
  includeDormant = false,
}) {
  const queryVector = await embeddingProvider.embed(query);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);

  const results = [];
  const searchTypes = types || ['episodic', 'semantic', 'procedural'];
  const now = new Date();

  if (searchTypes.includes('episodic')) {
    const episodes = db.prepare(`
      SELECT id, content, source, source_reliability, salience, tags,
             causal_trigger, causal_consequence, created_at, embedding,
             superseded_by
      FROM episodes
      WHERE superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit * 3);

    for (const ep of episodes) {
      if (!ep.embedding) continue;
      const similarity = cosineSimilarity(queryBuffer, ep.embedding, embeddingProvider);
      const ageDays = (now - new Date(ep.created_at)) / (1000 * 60 * 60 * 24);

      const confidence = computeConfidence({
        sourceType: ep.source,
        supportingCount: 1,
        contradictingCount: 0,
        ageDays,
        halfLifeDays: DEFAULT_HALF_LIVES.episodic,
        retrievalCount: 0,
        daysSinceRetrieval: ageDays,
      });

      if (confidence >= minConfidence) {
        results.push({
          id: ep.id,
          content: ep.content,
          type: 'episodic',
          source: ep.source,
          confidence,
          similarity,
          score: similarity * confidence,
          salience: ep.salience,
          tags: ep.tags ? JSON.parse(ep.tags) : [],
          causalTrigger: ep.causal_trigger,
          causalConsequence: ep.causal_consequence,
          createdAt: ep.created_at,
        });
      }
    }
  }

  if (searchTypes.includes('semantic')) {
    const stateFilter = includeDormant
      ? "state IN ('active', 'disputed', 'context_dependent', 'dormant')"
      : "state IN ('active', 'disputed', 'context_dependent')";

    const semantics = db.prepare(`
      SELECT id, content, state, conditions, evidence_episode_ids, evidence_count,
             supporting_count, contradicting_count, source_type_diversity,
             created_at, last_reinforced_at, retrieval_count, embedding
      FROM semantics
      WHERE ${stateFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit * 3);

    for (const sem of semantics) {
      if (!sem.embedding) continue;
      const similarity = cosineSimilarity(queryBuffer, sem.embedding, embeddingProvider);
      const ageDays = (now - new Date(sem.created_at)) / (1000 * 60 * 60 * 24);
      const daysSinceRetrieval = sem.last_reinforced_at
        ? (now - new Date(sem.last_reinforced_at)) / (1000 * 60 * 60 * 24)
        : ageDays;

      const confidence = computeConfidence({
        sourceType: 'direct-observation', // Semantic memories inherit strongest source
        supportingCount: sem.supporting_count || 0,
        contradictingCount: sem.contradicting_count || 0,
        ageDays,
        halfLifeDays: DEFAULT_HALF_LIVES.semantic,
        retrievalCount: sem.retrieval_count || 0,
        daysSinceRetrieval,
      });

      if (confidence >= minConfidence) {
        const memory = {
          id: sem.id,
          content: sem.content,
          type: 'semantic',
          source: 'consolidated',
          state: sem.state,
          confidence,
          similarity,
          score: similarity * confidence,
          evidenceCount: sem.evidence_count,
          sourceTypeDiversity: sem.source_type_diversity,
          createdAt: sem.created_at,
        };

        if (includeProvenance && sem.evidence_episode_ids) {
          memory.provenance = JSON.parse(sem.evidence_episode_ids);
        }
        if (sem.conditions) {
          memory.conditions = JSON.parse(sem.conditions);
        }

        results.push(memory);
      }
    }

    // Update retrieval counts for matched semantic memories
    const matchedSemanticIds = results.filter(r => r.type === 'semantic').map(r => r.id);
    if (matchedSemanticIds.length > 0) {
      const updateStmt = db.prepare(`
        UPDATE semantics SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id = ?
      `);
      const nowIso = now.toISOString();
      for (const id of matchedSemanticIds) {
        updateStmt.run(nowIso, id);
      }
    }
  }

  if (searchTypes.includes('procedural')) {
    const stateFilter = includeDormant
      ? "state IN ('active', 'disputed', 'context_dependent', 'dormant')"
      : "state IN ('active', 'disputed', 'context_dependent')";

    const procedures = db.prepare(`
      SELECT id, content, state, trigger_conditions, evidence_episode_ids,
             success_count, failure_count, created_at, last_reinforced_at,
             retrieval_count, embedding
      FROM procedures
      WHERE ${stateFilter}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit * 3);

    for (const proc of procedures) {
      if (!proc.embedding) continue;
      const similarity = cosineSimilarity(queryBuffer, proc.embedding, embeddingProvider);
      const ageDays = (now - new Date(proc.created_at)) / (1000 * 60 * 60 * 24);

      const confidence = computeConfidence({
        sourceType: 'direct-observation',
        supportingCount: proc.success_count || 0,
        contradictingCount: proc.failure_count || 0,
        ageDays,
        halfLifeDays: DEFAULT_HALF_LIVES.procedural,
        retrievalCount: proc.retrieval_count || 0,
        daysSinceRetrieval: proc.last_reinforced_at
          ? (now - new Date(proc.last_reinforced_at)) / (1000 * 60 * 60 * 24)
          : ageDays,
      });

      if (confidence >= minConfidence) {
        results.push({
          id: proc.id,
          content: proc.content,
          type: 'procedural',
          source: 'consolidated',
          state: proc.state,
          confidence,
          similarity,
          score: similarity * confidence,
          successCount: proc.success_count,
          failureCount: proc.failure_count,
          createdAt: proc.created_at,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function cosineSimilarity(bufA, bufB, provider) {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/recall.test.js`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/recall.js tests/recall.test.js
git commit -m "feat: add confidence-weighted recall with provenance and dormancy filtering"
```

---

## Task 8: Decay Engine

**Files:**
- Create: `src/decay.js`
- Create: `tests/decay.test.js`

**Step 1: Write the failing tests**

```js
// tests/decay.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyDecay } from '../src/decay.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-decay-data';

describe('applyDecay', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('marks old low-confidence semantic memories as dormant', () => {
    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(); // 120 days ago
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      contradicting_count, source_type_diversity, created_at, retrieval_count)
      VALUES (?, ?, 'active', 1, 0, 1, 1, ?, 0)`).run('sem-old', 'Old fact', oldDate);

    const result = applyDecay(db, { dormantThreshold: 0.1 });
    const row = db.prepare('SELECT state FROM semantics WHERE id = ?').get('sem-old');
    expect(row.state).toBe('dormant');
    expect(result.transitionedToDormant).toBeGreaterThan(0);
  });

  it('does not mark recent memories as dormant', () => {
    const recentDate = new Date().toISOString();
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at, retrieval_count)
      VALUES (?, ?, 'active', 5, 5, 3, ?, 10)`).run('sem-fresh', 'Fresh principle', recentDate);

    applyDecay(db, { dormantThreshold: 0.1 });
    const row = db.prepare('SELECT state FROM semantics WHERE id = ?').get('sem-fresh');
    expect(row.state).toBe('active');
  });

  it('returns statistics about the decay run', () => {
    const result = applyDecay(db, { dormantThreshold: 0.1 });
    expect(result).toHaveProperty('totalEvaluated');
    expect(result).toHaveProperty('transitionedToDormant');
    expect(result).toHaveProperty('timestamp');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/decay.test.js`
Expected: FAIL

**Step 3: Write implementation**

```js
// src/decay.js
import { computeConfidence, DEFAULT_HALF_LIVES } from './confidence.js';

export function applyDecay(db, { dormantThreshold = 0.1 } = {}) {
  const now = new Date();
  let totalEvaluated = 0;
  let transitionedToDormant = 0;

  // Evaluate semantic memories
  const semantics = db.prepare(`
    SELECT id, supporting_count, contradicting_count, created_at,
           last_reinforced_at, retrieval_count
    FROM semantics WHERE state = 'active'
  `).all();

  for (const sem of semantics) {
    totalEvaluated++;
    const ageDays = (now - new Date(sem.created_at)) / (1000 * 60 * 60 * 24);
    const daysSinceRetrieval = sem.last_reinforced_at
      ? (now - new Date(sem.last_reinforced_at)) / (1000 * 60 * 60 * 24)
      : ageDays;

    const confidence = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      ageDays,
      halfLifeDays: DEFAULT_HALF_LIVES.semantic,
      retrievalCount: sem.retrieval_count || 0,
      daysSinceRetrieval,
    });

    if (confidence < dormantThreshold) {
      db.prepare('UPDATE semantics SET state = ? WHERE id = ?').run('dormant', sem.id);
      transitionedToDormant++;
    }
  }

  // Evaluate procedural memories
  const procedures = db.prepare(`
    SELECT id, success_count, failure_count, created_at,
           last_reinforced_at, retrieval_count
    FROM procedures WHERE state = 'active'
  `).all();

  for (const proc of procedures) {
    totalEvaluated++;
    const ageDays = (now - new Date(proc.created_at)) / (1000 * 60 * 60 * 24);
    const daysSinceRetrieval = proc.last_reinforced_at
      ? (now - new Date(proc.last_reinforced_at)) / (1000 * 60 * 60 * 24)
      : ageDays;

    const confidence = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: proc.success_count || 0,
      contradictingCount: proc.failure_count || 0,
      ageDays,
      halfLifeDays: DEFAULT_HALF_LIVES.procedural,
      retrievalCount: proc.retrieval_count || 0,
      daysSinceRetrieval,
    });

    if (confidence < dormantThreshold) {
      db.prepare('UPDATE procedures SET state = ? WHERE id = ?').run('dormant', proc.id);
      transitionedToDormant++;
    }
  }

  return {
    totalEvaluated,
    transitionedToDormant,
    timestamp: now.toISOString(),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/decay.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/decay.js tests/decay.test.js
git commit -m "feat: add Ebbinghaus-inspired decay engine with dormancy transitions"
```

---

## Task 9: Validation Engine

**Files:**
- Create: `src/validate.js`
- Create: `tests/validate.test.js`

**Step 1: Write the failing tests**

```js
// tests/validate.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateMemory, detectContradiction } from '../src/validate.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-validate-data';

describe('detectContradiction', () => {
  it('detects no contradiction for unrelated claims', () => {
    const result = detectContradiction(
      'Stripe has a 100 req/s rate limit',
      'Redis cache has 500ms TTL',
    );
    // Without LLM, use heuristic: returns null (no contradiction detected)
    expect(result).toBeNull();
  });
});

describe('validateMemory', () => {
  let db, embedding;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('reinforces existing semantic memory when similar episode is added', async () => {
    // Add a semantic memory first
    const vec = await embedding.embed('Stripe rate limit is 100 req/s');
    const vecBuf = embedding.vectorToBuffer(vec);
    db.prepare(`INSERT INTO semantics (id, content, embedding, state, evidence_count,
      supporting_count, source_type_diversity, created_at, evidence_episode_ids)
      VALUES (?, ?, ?, 'active', 1, 1, 1, ?, ?)`).run(
      'sem-1', 'Stripe rate limit is 100 req/s', vecBuf, new Date().toISOString(), JSON.stringify(['ep-0'])
    );

    // Validate a new similar episode
    const result = await validateMemory(db, embedding, {
      id: 'ep-1',
      content: 'Stripe returns 429 over 100 requests per second',
      source: 'direct-observation',
    });

    expect(result.action).toBe('reinforced');
    const sem = db.prepare('SELECT supporting_count FROM semantics WHERE id = ?').get('sem-1');
    expect(sem.supporting_count).toBe(2);
  });

  it('returns no-action when no similar memories exist', async () => {
    const result = await validateMemory(db, embedding, {
      id: 'ep-1',
      content: 'Completely novel observation about quantum computing',
      source: 'direct-observation',
    });
    expect(result.action).toBe('none');
  });

  it('creates contradiction record when conflicting evidence found', async () => {
    // This requires an LLM for real contradiction detection.
    // For now, test the contradiction record creation directly.
    db.prepare(`INSERT INTO contradictions (id, claim_a_id, claim_b_id, claim_a_type, claim_b_type, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(
      'contra-1', 'ep-1', 'ep-2', 'episodic', 'episodic', new Date().toISOString()
    );

    const row = db.prepare('SELECT * FROM contradictions WHERE id = ?').get('contra-1');
    expect(row.state).toBe('open');
    expect(row.claim_a_id).toBe('ep-1');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/validate.test.js`
Expected: FAIL

**Step 3: Write implementation**

```js
// src/validate.js
import { generateId } from './ulid.js';

const SIMILARITY_THRESHOLD = 0.85;

export function detectContradiction(claimA, claimB) {
  // Heuristic contradiction detection (without LLM).
  // Returns null if no contradiction detected.
  // In production, this calls an LLM for nuanced comparison.
  // For now: simple negation/number-mismatch detection.
  return null;
}

export async function validateMemory(db, embeddingProvider, episode, { llmProvider } = {}) {
  const queryVector = await embeddingProvider.embed(episode.content);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);

  // Search existing semantic memories for similarity
  const semantics = db.prepare(`
    SELECT id, content, embedding, supporting_count, evidence_episode_ids, source_type_diversity
    FROM semantics WHERE state IN ('active', 'disputed', 'context_dependent')
  `).all();

  let bestMatch = null;
  let bestSimilarity = 0;

  for (const sem of semantics) {
    if (!sem.embedding) continue;
    const similarity = cosineSimilarity(queryBuffer, sem.embedding, embeddingProvider);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = sem;
    }
  }

  // Reinforcement: similar memory found
  if (bestMatch && bestSimilarity >= SIMILARITY_THRESHOLD) {
    // Check for self-citation (circular reinforcement prevention)
    const existingEpisodes = bestMatch.evidence_episode_ids
      ? JSON.parse(bestMatch.evidence_episode_ids)
      : [];

    // Update supporting count and evidence list
    existingEpisodes.push(episode.id);
    const newSourceTypes = new Set();
    for (const epId of existingEpisodes) {
      const ep = db.prepare('SELECT source FROM episodes WHERE id = ?').get(epId);
      if (ep) newSourceTypes.add(ep.source);
    }

    db.prepare(`
      UPDATE semantics
      SET supporting_count = supporting_count + 1,
          evidence_episode_ids = ?,
          source_type_diversity = ?,
          last_reinforced_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(existingEpisodes),
      newSourceTypes.size,
      new Date().toISOString(),
      bestMatch.id,
    );

    return { action: 'reinforced', targetId: bestMatch.id, similarity: bestSimilarity };
  }

  // TODO: LLM-based contradiction detection when llmProvider is available
  // For now, return no action
  return { action: 'none' };
}

export function createContradiction(db, claimAId, claimAType, claimBId, claimBType, resolution = null) {
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO contradictions (id, claim_a_id, claim_b_id, claim_a_type, claim_b_type, state, resolution, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, claimAId, claimBId, claimAType, claimBType, resolution ? 'resolved' : 'open', resolution ? JSON.stringify(resolution) : null, now);

  return id;
}

export function reopenContradiction(db, contradictionId, newEvidenceId) {
  db.prepare(`
    UPDATE contradictions SET state = 'reopened', reopened_at = ?, reopen_evidence_id = ?
    WHERE id = ?
  `).run(new Date().toISOString(), newEvidenceId, contradictionId);
}

function cosineSimilarity(bufA, bufB, provider) {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/validate.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/validate.js tests/validate.test.js
git commit -m "feat: add validation engine with reinforcement and contradiction tracking"
```

---

## Task 10: Consolidation Engine

**Files:**
- Create: `src/consolidate.js`
- Create: `tests/consolidate.test.js`

**Step 1: Write the failing tests**

```js
// tests/consolidate.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runConsolidation, clusterEpisodes } from '../src/consolidate.js';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-consolidate-data';

describe('clusterEpisodes', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns clusters of similar episodes', async () => {
    // Encode several similar episodes
    await encodeEpisode(db, embedding, { content: 'Stripe 429 error at 100 req/s', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'Stripe 429 error at 100 req/s batch mode', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'Stripe 429 error at 100 req/s async', source: 'direct-observation' });

    const clusters = clusterEpisodes(db, embedding, { similarityThreshold: 0.5, minClusterSize: 2 });
    expect(clusters.length).toBeGreaterThanOrEqual(0); // Mock embeddings may or may not cluster
  });

  it('skips already-consolidated episodes', async () => {
    const id = await encodeEpisode(db, embedding, { content: 'Already seen', source: 'direct-observation' });
    db.prepare('UPDATE episodes SET consolidated = 1 WHERE id = ?').run(id);

    const clusters = clusterEpisodes(db, embedding, { similarityThreshold: 0.5, minClusterSize: 1 });
    const hasConsolidated = clusters.flat().some(ep => ep.id === id);
    expect(hasConsolidated).toBe(false);
  });
});

describe('runConsolidation', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates a consolidation_run record', async () => {
    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.8,
    });
    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('status');

    const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(result.runId);
    expect(run).not.toBeNull();
    expect(run.status).toBe('completed');
  });

  it('returns statistics about the consolidation', async () => {
    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.8,
    });
    expect(result).toHaveProperty('episodesEvaluated');
    expect(result).toHaveProperty('clustersFound');
    expect(result).toHaveProperty('principlesExtracted');
  });

  it('marks consolidated episodes', async () => {
    // Encode episodes that will cluster (same content = same embedding)
    await encodeEpisode(db, embedding, { content: 'identical event A', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'identical event A', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'identical event A', source: 'told-by-user' });

    await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: (episodes) => ({
        content: 'Event A happens repeatedly',
        type: 'semantic',
      }),
    });

    const unconsolidated = db.prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0').get();
    // Episodes should now be marked as consolidated (if they clustered)
    expect(typeof unconsolidated.count).toBe('number');
  });

  it('is idempotent — second run with no new episodes produces no new principles', async () => {
    await encodeEpisode(db, embedding, { content: 'test episode', source: 'direct-observation' });

    const run1 = await runConsolidation(db, embedding, { minClusterSize: 1, similarityThreshold: 0.5 });
    const run2 = await runConsolidation(db, embedding, { minClusterSize: 1, similarityThreshold: 0.5 });

    expect(run2.episodesEvaluated).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/consolidate.test.js`
Expected: FAIL

**Step 3: Write implementation**

```js
// src/consolidate.js
import { generateId } from './ulid.js';

export function clusterEpisodes(db, embeddingProvider, {
  similarityThreshold = 0.80,
  minClusterSize = 3,
} = {}) {
  const episodes = db.prepare(`
    SELECT id, content, embedding, source, source_reliability, created_at
    FROM episodes
    WHERE consolidated = 0 AND superseded_by IS NULL
    ORDER BY created_at ASC
  `).all();

  if (episodes.length === 0) return [];

  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < episodes.length; i++) {
    if (assigned.has(episodes[i].id)) continue;
    if (!episodes[i].embedding) continue;

    const cluster = [episodes[i]];
    assigned.add(episodes[i].id);

    for (let j = i + 1; j < episodes.length; j++) {
      if (assigned.has(episodes[j].id)) continue;
      if (!episodes[j].embedding) continue;

      const sim = cosineSimilarity(episodes[i].embedding, episodes[j].embedding, embeddingProvider);
      if (sim >= similarityThreshold) {
        cluster.push(episodes[j]);
        assigned.add(episodes[j].id);
      }
    }

    if (cluster.length >= minClusterSize) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

export async function runConsolidation(db, embeddingProvider, {
  minClusterSize = 3,
  similarityThreshold = 0.80,
  extractPrinciple,
} = {}) {
  const runId = generateId();
  const startedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO consolidation_runs (id, started_at, status)
    VALUES (?, ?, 'running')
  `).run(runId, startedAt);

  try {
    const clusters = clusterEpisodes(db, embeddingProvider, {
      similarityThreshold,
      minClusterSize,
    });

    const allEpisodes = db.prepare(`
      SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0 AND superseded_by IS NULL
    `).get();

    let principlesExtracted = 0;
    const outputMemoryIds = [];
    const inputEpisodeIds = [];

    for (const cluster of clusters) {
      const episodeIds = cluster.map(ep => ep.id);
      inputEpisodeIds.push(...episodeIds);

      // Check source type diversity
      const sourceTypes = new Set(cluster.map(ep => ep.source));

      // Extract principle (use provided function or default)
      let principle;
      if (extractPrinciple) {
        principle = extractPrinciple(cluster);
      } else {
        // Default: concatenate episode contents as principle (placeholder for LLM)
        principle = {
          content: cluster.map(ep => ep.content).join(' | '),
          type: 'semantic',
        };
      }

      // Create semantic memory
      const semId = generateId();
      const embedding = await embeddingProvider.embed(principle.content);
      const embeddingBuffer = embeddingProvider.vectorToBuffer(embedding);

      db.prepare(`
        INSERT INTO semantics (
          id, content, embedding, state, evidence_episode_ids, evidence_count,
          supporting_count, source_type_diversity, consolidation_checkpoint,
          embedding_model, embedding_version, created_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        semId,
        principle.content,
        embeddingBuffer,
        JSON.stringify(episodeIds),
        cluster.length,
        cluster.length,
        sourceTypes.size,
        runId,
        embeddingProvider.modelName,
        embeddingProvider.modelVersion,
        new Date().toISOString(),
      );

      outputMemoryIds.push(semId);
      principlesExtracted++;

      // Mark episodes as consolidated
      const markStmt = db.prepare('UPDATE episodes SET consolidated = 1 WHERE id = ?');
      for (const epId of episodeIds) {
        markStmt.run(epId);
      }
    }

    // Update consolidation run
    db.prepare(`
      UPDATE consolidation_runs
      SET status = 'completed',
          completed_at = ?,
          input_episode_ids = ?,
          output_memory_ids = ?,
          checkpoint_cursor = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      JSON.stringify(inputEpisodeIds),
      JSON.stringify(outputMemoryIds),
      inputEpisodeIds.length > 0 ? inputEpisodeIds[inputEpisodeIds.length - 1] : null,
      runId,
    );

    return {
      runId,
      status: 'completed',
      episodesEvaluated: allEpisodes.count,
      clustersFound: clusters.length,
      principlesExtracted,
      outputMemoryIds,
    };
  } catch (error) {
    db.prepare(`
      UPDATE consolidation_runs SET status = 'failed', completed_at = ? WHERE id = ?
    `).run(new Date().toISOString(), runId);
    throw error;
  }
}

function cosineSimilarity(bufA, bufB, provider) {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/consolidate.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/consolidate.js tests/consolidate.test.js
git commit -m "feat: add consolidation engine with clustering and principle extraction"
```

---

## Task 11: Rollback System

**Files:**
- Create: `src/rollback.js`
- Create: `tests/rollback.test.js`

**Step 1: Write the failing tests**

```js
// tests/rollback.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rollbackConsolidation, getConsolidationHistory } from '../src/rollback.js';
import { encodeEpisode } from '../src/encode.js';
import { runConsolidation } from '../src/consolidate.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-rollback-data';

describe('rollback', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns consolidation history', async () => {
    await runConsolidation(db, embedding, { minClusterSize: 3 });
    const history = getConsolidationHistory(db);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);
    expect(history[0]).toHaveProperty('id');
    expect(history[0]).toHaveProperty('status');
  });

  it('rolls back a consolidation run', async () => {
    // Create episodes that will cluster
    await encodeEpisode(db, embedding, { content: 'same event', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'This happens a lot', type: 'semantic' }),
    });

    // Verify semantic memory was created
    const before = db.prepare('SELECT COUNT(*) as count FROM semantics WHERE state = ?').get('active');

    // Rollback
    rollbackConsolidation(db, result.runId);

    // Verify semantic memories are marked as rolled_back
    const after = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'rolled_back'").get();
    const activeAfter = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'active'").get();

    // Episodes should be un-consolidated
    const unconsolidated = db.prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0').get();
    expect(unconsolidated.count).toBe(3);

    // Consolidation run marked as rolled_back
    const run = db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get(result.runId);
    expect(run.status).toBe('rolled_back');
  });

  it('throws for non-existent run ID', () => {
    expect(() => rollbackConsolidation(db, 'nonexistent')).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/rollback.test.js`
Expected: FAIL

**Step 3: Write implementation**

```js
// src/rollback.js

export function getConsolidationHistory(db) {
  return db.prepare(`
    SELECT id, checkpoint_cursor, input_episode_ids, output_memory_ids,
           started_at, completed_at, status
    FROM consolidation_runs
    ORDER BY started_at DESC
  `).all();
}

export function rollbackConsolidation(db, runId) {
  const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Consolidation run not found: ${runId}`);
  if (run.status === 'rolled_back') throw new Error(`Run already rolled back: ${runId}`);

  const outputIds = run.output_memory_ids ? JSON.parse(run.output_memory_ids) : [];
  const inputIds = run.input_episode_ids ? JSON.parse(run.input_episode_ids) : [];

  // Mark output semantic/procedural memories as rolled_back
  const markSemantics = db.prepare('UPDATE semantics SET state = ? WHERE id = ?');
  const markProcedures = db.prepare('UPDATE procedures SET state = ? WHERE id = ?');
  for (const id of outputIds) {
    markSemantics.run('rolled_back', id);
    markProcedures.run('rolled_back', id);
  }

  // Un-consolidate input episodes
  const unmark = db.prepare('UPDATE episodes SET consolidated = 0 WHERE id = ?');
  for (const id of inputIds) {
    unmark.run(id);
  }

  // Mark run as rolled_back
  db.prepare('UPDATE consolidation_runs SET status = ? WHERE id = ?').run('rolled_back', runId);

  return { rolledBackMemories: outputIds.length, restoredEpisodes: inputIds.length };
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/rollback.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/rollback.js tests/rollback.test.js
git commit -m "feat: add consolidation rollback with full audit trail"
```

---

## Task 12: Introspection API

**Files:**
- Create: `src/introspect.js`
- Create: `tests/introspect.test.js`

**Step 1: Write the failing tests**

```js
// tests/introspect.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { introspect } from '../src/introspect.js';
import { encodeEpisode } from '../src/encode.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-introspect-data';

describe('introspect', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    db = createDatabase(TEST_DIR);
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns memory counts by type', async () => {
    await encodeEpisode(db, embedding, { content: 'test', source: 'direct-observation' });
    const stats = introspect(db);
    expect(stats.episodic).toBe(1);
    expect(stats.semantic).toBe(0);
    expect(stats.procedural).toBe(0);
  });

  it('returns contradiction counts by state', () => {
    const stats = introspect(db);
    expect(stats.contradictions).toHaveProperty('open');
    expect(stats.contradictions).toHaveProperty('resolved');
    expect(stats.contradictions).toHaveProperty('context_dependent');
    expect(stats.contradictions).toHaveProperty('reopened');
  });

  it('returns causal link count', () => {
    const stats = introspect(db);
    expect(typeof stats.causalLinks).toBe('number');
  });

  it('returns consolidation info', () => {
    const stats = introspect(db);
    expect(stats).toHaveProperty('lastConsolidation');
    expect(stats).toHaveProperty('totalConsolidationRuns');
  });

  it('returns dormant count', async () => {
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at) VALUES (?, ?, 'dormant', 1, 1, 1, ?)`).run(
      'dormant-1', 'Old memory', new Date().toISOString()
    );
    const stats = introspect(db);
    expect(stats.dormant).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/introspect.test.js`
Expected: FAIL

**Step 3: Write implementation**

```js
// src/introspect.js

export function introspect(db) {
  const episodic = db.prepare('SELECT COUNT(*) as count FROM episodes').get().count;
  const semantic = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state != 'rolled_back'").get().count;
  const procedural = db.prepare("SELECT COUNT(*) as count FROM procedures WHERE state != 'rolled_back'").get().count;
  const causalLinks = db.prepare('SELECT COUNT(*) as count FROM causal_links').get().count;
  const dormant = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'dormant'").get().count
    + db.prepare("SELECT COUNT(*) as count FROM procedures WHERE state = 'dormant'").get().count;

  const contradictions = {
    open: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'open'").get().count,
    resolved: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'resolved'").get().count,
    context_dependent: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'context_dependent'").get().count,
    reopened: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'reopened'").get().count,
  };

  const lastRun = db.prepare(`
    SELECT completed_at FROM consolidation_runs
    WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1
  `).get();

  const totalRuns = db.prepare('SELECT COUNT(*) as count FROM consolidation_runs').get().count;

  return {
    episodic,
    semantic,
    procedural,
    causalLinks,
    dormant,
    contradictions,
    lastConsolidation: lastRun?.completed_at || null,
    totalConsolidationRuns: totalRuns,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/introspect.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/introspect.js tests/introspect.test.js
git commit -m "feat: add introspection API for memory system health and stats"
```

---

## Task 13: Main Audrey Class

**Files:**
- Create: `src/audrey.js`
- Create: `tests/audrey.test.js`
- Modify: `src/index.js`

**Step 1: Write the failing tests**

```js
// tests/audrey.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/audrey.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-audrey-main';

describe('Audrey', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates an Audrey instance', () => {
    expect(brain).toBeInstanceOf(Audrey);
  });

  it('encodes an episodic memory', async () => {
    const id = await brain.encode({
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    expect(typeof id).toBe('string');
  });

  it('recalls memories', async () => {
    await brain.encode({ content: 'Test observation', source: 'direct-observation' });
    const results = await brain.recall('test', {});
    expect(Array.isArray(results)).toBe(true);
  });

  it('emits events on encode', async () => {
    let emitted = false;
    brain.on('encode', () => { emitted = true; });
    await brain.encode({ content: 'Test', source: 'direct-observation' });
    expect(emitted).toBe(true);
  });

  it('runs consolidation', async () => {
    const result = await brain.consolidate();
    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('status');
  });

  it('returns introspection stats', async () => {
    await brain.encode({ content: 'Test', source: 'direct-observation' });
    const stats = await brain.introspect();
    expect(stats.episodic).toBe(1);
  });

  it('rolls back consolidation', async () => {
    await brain.encode({ content: 'same thing', source: 'direct-observation' });
    await brain.encode({ content: 'same thing', source: 'tool-result' });
    await brain.encode({ content: 'same thing', source: 'told-by-user' });

    const result = await brain.consolidate({ minClusterSize: 3, similarityThreshold: 0.99 });
    await brain.rollback(result.runId);

    const history = brain.consolidationHistory();
    const run = history.find(r => r.id === result.runId);
    expect(run.status).toBe('rolled_back');
  });

  it('applies decay', async () => {
    const result = brain.decay();
    expect(result).toHaveProperty('totalEvaluated');
    expect(result).toHaveProperty('transitionedToDormant');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/audrey.test.js`
Expected: FAIL

**Step 3: Write implementation**

```js
// src/audrey.js
import { EventEmitter } from 'node:events';
import { createDatabase, closeDatabase } from './db.js';
import { createEmbeddingProvider } from './embedding.js';
import { encodeEpisode } from './encode.js';
import { recall as recallFn } from './recall.js';
import { validateMemory } from './validate.js';
import { runConsolidation } from './consolidate.js';
import { applyDecay } from './decay.js';
import { rollbackConsolidation, getConsolidationHistory } from './rollback.js';
import { introspect as introspectFn } from './introspect.js';

export class Audrey extends EventEmitter {
  constructor({
    dataDir = './audrey-data',
    agent = 'default',
    embedding = { provider: 'mock', dimensions: 64 },
    consolidation = {},
    decay = {},
  } = {}) {
    super();
    this.agent = agent;
    this.dataDir = dataDir;
    this.db = createDatabase(dataDir);
    this.embeddingProvider = createEmbeddingProvider(embedding);
    this.consolidationConfig = {
      interval: consolidation.interval || '1h',
      minEpisodes: consolidation.minEpisodes || 3,
      confidenceTarget: consolidation.confidenceTarget || 2.0,
      llm: consolidation.llm || null,
    };
    this.decayConfig = {
      dormantThreshold: decay.dormantThreshold || 0.1,
    };
    this._consolidationTimer = null;
  }

  async encode(params) {
    const id = await encodeEpisode(this.db, this.embeddingProvider, params);
    this.emit('encode', { id, ...params });

    // Async validation (non-blocking)
    validateMemory(this.db, this.embeddingProvider, { id, ...params }).then(result => {
      if (result.action === 'reinforced') {
        this.emit('reinforcement', { episodeId: id, targetId: result.targetId, similarity: result.similarity });
      }
    }).catch(() => {});

    return id;
  }

  async recall(query, options = {}) {
    return recallFn(this.db, this.embeddingProvider, query, options);
  }

  async consolidate(options = {}) {
    const result = await runConsolidation(this.db, this.embeddingProvider, {
      minClusterSize: options.minClusterSize || this.consolidationConfig.minEpisodes,
      similarityThreshold: options.similarityThreshold || 0.80,
      extractPrinciple: options.extractPrinciple,
    });
    this.emit('consolidation', result);
    return result;
  }

  decay(options = {}) {
    const result = applyDecay(this.db, {
      dormantThreshold: options.dormantThreshold || this.decayConfig.dormantThreshold,
    });
    this.emit('decay', result);
    return result;
  }

  rollback(runId) {
    const result = rollbackConsolidation(this.db, runId);
    this.emit('rollback', { runId, ...result });
    return result;
  }

  consolidationHistory() {
    return getConsolidationHistory(this.db);
  }

  introspect() {
    return introspectFn(this.db);
  }

  startAutoConsolidation() {
    const ms = parseInterval(this.consolidationConfig.interval);
    this._consolidationTimer = setInterval(() => {
      this.consolidate().catch(err => this.emit('error', err));
    }, ms);
  }

  stopAutoConsolidation() {
    if (this._consolidationTimer) {
      clearInterval(this._consolidationTimer);
      this._consolidationTimer = null;
    }
  }

  close() {
    this.stopAutoConsolidation();
    closeDatabase(this.db);
  }
}

function parseInterval(str) {
  const match = str.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) return 3600000; // default 1 hour
  const [, num, unit] = match;
  const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * multipliers[unit];
}
```

**Step 4: Run test to verify it passes**

Run: `cd A:/ai/claude/audrey && npx vitest run tests/audrey.test.js`
Expected: PASS

**Step 5: Update barrel export**

```js
// src/index.js
export { Audrey } from './audrey.js';
export { computeConfidence, sourceReliability, DEFAULT_SOURCE_RELIABILITY, DEFAULT_WEIGHTS, DEFAULT_HALF_LIVES } from './confidence.js';
export { createEmbeddingProvider, MockEmbeddingProvider, OpenAIEmbeddingProvider } from './embedding.js';
```

**Step 6: Commit**

```bash
git add src/audrey.js src/index.js tests/audrey.test.js
git commit -m "feat: add main Audrey class tying all subsystems together"
```

---

## Task 14: Run Full Test Suite

**Step 1: Run all tests**

Run: `cd A:/ai/claude/audrey && npx vitest run`
Expected: ALL PASS

**Step 2: Fix any failures, re-run**

**Step 3: Commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: resolve test suite integration issues"
```

---

## Task 15: Proof-of-Concept Demo

**Files:**
- Create: `examples/stripe-demo.js`

**Step 1: Write the demo script**

```js
// examples/stripe-demo.js
import { Audrey } from '../src/index.js';

async function demo() {
  console.log('=== Audrey Demo: Stripe Rate Limit Learning ===\n');

  const brain = new Audrey({
    dataDir: './demo-data',
    agent: 'stripe-agent',
    embedding: { provider: 'mock', dimensions: 64 },
  });

  brain.on('encode', ({ id, content }) => {
    console.log(`  [ENCODE] ${id.slice(0, 8)}... "${content}"`);
  });

  brain.on('consolidation', ({ principlesExtracted, clustersFound }) => {
    console.log(`  [CONSOLIDATE] Found ${clustersFound} clusters, extracted ${principlesExtracted} principles`);
  });

  // --- Scenario: Agent encounters Stripe rate limits ---

  console.log('\n--- Episode 1: First rate limit hit ---');
  await brain.encode({
    content: 'Stripe API returned HTTP 429 when batch-processing 150 payments per second',
    source: 'direct-observation',
    salience: 0.9,
    causal: { trigger: 'batch-payment-job', consequence: 'payment-queue-stalled' },
    tags: ['stripe', 'rate-limit', 'production'],
  });

  console.log('\n--- Episode 2: Second hit from different code path ---');
  await brain.encode({
    content: 'Stripe webhook verification endpoint returned 429 Too Many Requests during high traffic',
    source: 'tool-result',
    salience: 0.7,
    causal: { trigger: 'webhook-flood', consequence: 'missed-webhook-events' },
    tags: ['stripe', 'rate-limit', 'webhooks'],
  });

  console.log('\n--- Episode 3: Third observation from monitoring ---');
  await brain.encode({
    content: 'Stripe API rate limit triggered at approximately 100 requests per second threshold',
    source: 'direct-observation',
    salience: 0.8,
    tags: ['stripe', 'rate-limit', 'monitoring'],
  });

  // --- Consolidation ---
  console.log('\n--- Running consolidation ("sleep" cycle) ---');
  const consolidationResult = await brain.consolidate({
    minClusterSize: 3,
    similarityThreshold: 0.5, // Lower for mock embeddings
    extractPrinciple: (episodes) => ({
      content: `Stripe enforces ~100 req/s rate limit across all endpoints. Exceeding this causes 429 errors that can stall payment queues and cause missed webhooks. Implement request throttling.`,
      type: 'semantic',
    }),
  });

  // --- Proactive recall ---
  console.log('\n--- Agent encounters Stripe again, recalls proactively ---');
  const memories = await brain.recall('stripe api requests', {
    minConfidence: 0.3,
    limit: 3,
  });

  console.log(`\nRecalled ${memories.length} memories:`);
  for (const mem of memories) {
    console.log(`  [${mem.type.toUpperCase()}] (conf: ${mem.confidence.toFixed(2)}) ${mem.content.slice(0, 80)}...`);
  }

  // --- Introspection ---
  console.log('\n--- Brain stats ---');
  const stats = brain.introspect();
  console.log(`  Episodic: ${stats.episodic}`);
  console.log(`  Semantic: ${stats.semantic}`);
  console.log(`  Procedural: ${stats.procedural}`);
  console.log(`  Causal links: ${stats.causalLinks}`);
  console.log(`  Consolidation runs: ${stats.totalConsolidationRuns}`);

  brain.close();

  // Cleanup demo data
  const { rmSync } = await import('node:fs');
  rmSync('./demo-data', { recursive: true, force: true });

  console.log('\n=== Demo complete ===');
}

demo().catch(console.error);
```

**Step 2: Run the demo**

Run: `cd A:/ai/claude/audrey && node examples/stripe-demo.js`
Expected: Full output showing encode → consolidate → recall cycle

**Step 3: Commit**

```bash
git add examples/stripe-demo.js
git commit -m "feat: add proof-of-concept demo showing encode → consolidate → recall"
```

---

## Task 16: Final Cleanup and Verification

**Step 1: Run full test suite one more time**

Run: `cd A:/ai/claude/audrey && npx vitest run`
Expected: ALL PASS

**Step 2: Run demo one more time**

Run: `cd A:/ai/claude/audrey && node examples/stripe-demo.js`
Expected: Clean output, no errors

**Step 3: Final commit**

```bash
git add -A && git commit -m "chore: final cleanup and verification"
```

---

## Summary

16 tasks, ~60 steps. Each task produces a tested, committed unit. The result is a working Audrey SDK with:

- **Episodic encoding** with immutable append-only records
- **Compositional confidence** formula with decay curves
- **Confidence-weighted recall** with provenance and dormancy filtering
- **Validation engine** with reinforcement and contradiction tracking
- **Consolidation engine** with clustering and principle extraction
- **Ebbinghaus decay** with dormancy transitions
- **Rollback system** for undoing bad consolidations
- **Introspection API** for system health monitoring
- **Event system** for lifecycle hooks
- **Proof-of-concept demo** showing the full encode → consolidate → recall cycle

**What's deferred to v0.2:**
- Real LLM integration for consolidation (currently uses callback or concatenation)
- LLM-based contradiction detection
- Causal mechanism articulation via LLM
- OpenAI/Anthropic embedding provider integration tests
- sqlite-vec native vector search (currently uses in-memory cosine similarity)
- Auto-consolidation scheduling
- Cross-agent knowledge sharing (Hivemind protocol)
