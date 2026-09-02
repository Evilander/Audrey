import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { forgetMemory, forgetByQuery, purgeMemories } from '../dist/src/forget.js';
import { encodeEpisode } from '../dist/src/encode.js';
import { recall } from '../dist/src/recall.js';
import { runConsolidation } from '../dist/src/consolidate.js';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { generateId } from '../dist/src/ulid.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-forget-data';

function insertSemantic(db, embedding, id, content, state = 'active') {
  return (async () => {
    const vector = await embedding.embed(content);
    const buf = embedding.vectorToBuffer(vector);
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(id, content, buf, state, 1, 1, 0, 0, now, embedding.modelName, embedding.modelVersion);
    db.prepare('INSERT INTO vec_semantics(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      id,
      'default',
      buf,
      state,
    );
  })();
}

function insertProcedure(db, embedding, id, content, state = 'active') {
  return (async () => {
    const vector = await embedding.embed(content);
    const buf = embedding.vectorToBuffer(vector);
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO procedures (id, content, embedding, state, success_count, failure_count,
        retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(id, content, buf, state, 3, 0, 0, now, embedding.modelName, embedding.modelVersion);
    db.prepare('INSERT INTO vec_procedures(id, agent, embedding, state) VALUES (?, ?, ?, ?)').run(
      id,
      'default',
      buf,
      state,
    );
  })();
}

describe('forgetMemory', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('soft-deletes an episode', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });

    const result = forgetMemory(db, id);

    expect(result).toEqual({ id, type: 'episodic', purged: false });
    const row = db.prepare('SELECT superseded_by FROM episodes WHERE id = ?').get(id);
    expect(row.superseded_by).toBe('forgotten');
    const vecRow = db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get(id);
    expect(vecRow).toBeUndefined();
  });

  it('soft-deleted episode is excluded from recall', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'unique forgotten memory xyz123',
      source: 'direct-observation',
    });

    forgetMemory(db, id);

    const results = await recall(db, embedding, 'unique forgotten memory xyz123');
    const found = results.find(r => r.id === id);
    expect(found).toBeUndefined();
  });

  it('soft-deletes a semantic memory', async () => {
    const semId = generateId();
    await insertSemantic(db, embedding, semId, 'Rate limits are 100 rps');

    const result = forgetMemory(db, semId);

    expect(result).toEqual({ id: semId, type: 'semantic', purged: false });
    const row = db.prepare('SELECT state FROM semantics WHERE id = ?').get(semId);
    expect(row.state).toBe('superseded');
    const vecRow = db.prepare('SELECT id FROM vec_semantics WHERE id = ?').get(semId);
    expect(vecRow).toBeUndefined();
  });

  it('soft-deletes a procedural memory', async () => {
    const procId = generateId();
    await insertProcedure(db, embedding, procId, 'When rate limited, use exponential backoff');

    const result = forgetMemory(db, procId);

    expect(result).toEqual({ id: procId, type: 'procedural', purged: false });
    const row = db.prepare('SELECT state FROM procedures WHERE id = ?').get(procId);
    expect(row.state).toBe('superseded');
    const vecRow = db.prepare('SELECT id FROM vec_procedures WHERE id = ?').get(procId);
    expect(vecRow).toBeUndefined();
  });

  it('throws on unknown ID', () => {
    expect(() => forgetMemory(db, 'nonexistent-id-12345')).toThrow(
      'Memory not found: nonexistent-id-12345',
    );
  });

  it('hard-deletes an episode with purge: true', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Delete me permanently',
      source: 'direct-observation',
    });

    const result = forgetMemory(db, id, { purge: true });

    expect(result).toEqual({
      id,
      type: 'episodic',
      purged: true,
      cascadedSemantics: 0,
      cascadedProcedures: 0,
    });
    const row = db.prepare('SELECT id FROM episodes WHERE id = ?').get(id);
    expect(row).toBeUndefined();
    const vecRow = db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get(id);
    expect(vecRow).toBeUndefined();
  });

  it('hard-deletes a semantic with purge: true', async () => {
    const semId = generateId();
    await insertSemantic(db, embedding, semId, 'Purge this semantic');

    const result = forgetMemory(db, semId, { purge: true });

    expect(result).toEqual({ id: semId, type: 'semantic', purged: true });
    const row = db.prepare('SELECT id FROM semantics WHERE id = ?').get(semId);
    expect(row).toBeUndefined();
    const vecRow = db.prepare('SELECT id FROM vec_semantics WHERE id = ?').get(semId);
    expect(vecRow).toBeUndefined();
  });
});

describe('purgeMemories', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('bulk deletes all forgotten/dormant/superseded memories, leaves active ones', async () => {
    const activeEpId = await encodeEpisode(db, embedding, {
      content: 'Active episode stays',
      source: 'direct-observation',
    });
    const forgottenEpId = await encodeEpisode(db, embedding, {
      content: 'Forgotten episode goes',
      source: 'direct-observation',
    });
    forgetMemory(db, forgottenEpId);

    const activeSemId = generateId();
    await insertSemantic(db, embedding, activeSemId, 'Active semantic stays', 'active');
    const dormantSemId = generateId();
    await insertSemantic(db, embedding, dormantSemId, 'Dormant semantic goes', 'dormant');
    const supersededSemId = generateId();
    await insertSemantic(db, embedding, supersededSemId, 'Superseded semantic goes', 'superseded');

    const activeProcId = generateId();
    await insertProcedure(db, embedding, activeProcId, 'Active procedure stays', 'active');
    const rolledBackProcId = generateId();
    await insertProcedure(
      db,
      embedding,
      rolledBackProcId,
      'Rolled back procedure goes',
      'rolled_back',
    );

    const result = purgeMemories(db);

    expect(result.episodes).toBe(1);
    expect(result.semantics).toBe(2);
    expect(result.procedures).toBe(1);

    expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get(activeEpId)).toBeDefined();
    expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get(forgottenEpId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(activeSemId)).toBeDefined();
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(dormantSemId)).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM semantics WHERE id = ?').get(supersededSemId),
    ).toBeUndefined();
    expect(db.prepare('SELECT id FROM procedures WHERE id = ?').get(activeProcId)).toBeDefined();
    expect(
      db.prepare('SELECT id FROM procedures WHERE id = ?').get(rolledBackProcId),
    ).toBeUndefined();
  });

  it('returns zero counts when nothing to purge', async () => {
    await encodeEpisode(db, embedding, {
      content: 'Healthy episode',
      source: 'direct-observation',
    });

    const result = purgeMemories(db);

    expect(result).toEqual({ episodes: 0, semantics: 0, procedures: 0 });
  });
});

describe('forgetByQuery', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('forgets closest matching memory by query', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });

    const result = await forgetByQuery(db, embedding, 'Stripe API returned 429', {
      minSimilarity: 0.5,
    });

    expect(result).not.toBeNull();
    expect(result.id).toBe(id);
    expect(result.type).toBe('episodic');
    expect(result.purged).toBe(false);
    const row = db.prepare('SELECT superseded_by FROM episodes WHERE id = ?').get(id);
    expect(row.superseded_by).toBe('forgotten');
  });

  it('returns null when no match above threshold', async () => {
    await encodeEpisode(db, embedding, {
      content: 'Completely unrelated memory about cooking pasta',
      source: 'direct-observation',
    });

    const result = await forgetByQuery(db, embedding, 'quantum physics dark matter', {
      minSimilarity: 0.999,
    });

    expect(result).toBeNull();
  });

  it('supports purge on forgetByQuery', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Purge me via query',
      source: 'direct-observation',
    });

    const result = await forgetByQuery(db, embedding, 'Purge me via query', {
      minSimilarity: 0.5,
      purge: true,
    });

    expect(result).not.toBeNull();
    expect(result.purged).toBe(true);
    const row = db.prepare('SELECT id FROM episodes WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('scopes the destructive lookup to the given agent', async () => {
    const otherAgentId = await encodeEpisode(db, embedding, {
      content: 'agent-b private working note',
      source: 'direct-observation',
      agent: 'agent-b',
    });

    const crossAgent = await forgetByQuery(db, embedding, 'agent-b private working note', {
      minSimilarity: 0.5,
      agent: 'agent-a',
    });
    expect(crossAgent).toBeNull();
    expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get(otherAgentId)).toBeDefined();

    const sameAgent = await forgetByQuery(db, embedding, 'agent-b private working note', {
      minSimilarity: 0.5,
      agent: 'agent-b',
    });
    expect(sameAgent).not.toBeNull();
    expect(sameAgent.id).toBe(otherAgentId);
  });
});

describe('purge cascade to derived memories', () => {
  let db, embedding;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    embedding = new MockEmbeddingProvider({ dimensions: 8 });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  async function consolidateSentinel() {
    const ids = [];
    for (const source of ['direct-observation', 'tool-result', 'told-by-user']) {
      ids.push(
        await encodeEpisode(db, embedding, {
          content: 'sentinel fact the semantic will restate',
          source,
        }),
      );
    }
    await runConsolidation(db, embedding, { minClusterSize: 3, similarityThreshold: 0.99 });
    const semantic = db.prepare("SELECT * FROM semantics WHERE state = 'active'").get();
    expect(semantic).toBeDefined();
    expect(semantic.content).toContain('sentinel fact');
    return { ids, semantic };
  }

  it('purging an evidence episode purges the derived semantic and requeues survivors', async () => {
    const { ids, semantic } = await consolidateSentinel();

    const result = forgetMemory(db, ids[0], { purge: true });

    expect(result.purged).toBe(true);
    expect(result.cascadedSemantics).toBe(1);
    expect(result.cascadedProcedures).toBe(0);

    // The derived row that restated the purged content is gone everywhere.
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(semantic.id)).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM vec_semantics WHERE id = ?').get(semantic.id),
    ).toBeUndefined();
    const recalled = await recall(db, embedding, 'sentinel fact the semantic will restate');
    expect(recalled.find(r => r.id === semantic.id)).toBeUndefined();

    // Survivors are eligible to re-consolidate without the purged episode.
    for (const survivorId of ids.slice(1)) {
      const row = db.prepare('SELECT consolidated FROM episodes WHERE id = ?').get(survivorId);
      expect(row.consolidated).toBe(0);
      const vecRow = db
        .prepare('SELECT consolidated FROM vec_episodes WHERE id = ?')
        .get(survivorId);
      expect(Number(vecRow.consolidated)).toBe(0);
    }

    const rerun = await runConsolidation(db, embedding, {
      minClusterSize: 2,
      similarityThreshold: 0.99,
    });
    expect(rerun.principlesExtracted).toBe(1);
  });

  it('soft forget does not cascade to derived memories', async () => {
    const { ids, semantic } = await consolidateSentinel();

    const result = forgetMemory(db, ids[0]);

    expect(result.purged).toBe(false);
    expect(result.cascadedSemantics).toBeUndefined();
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(semantic.id)).toBeDefined();
  });

  it('bulk purgeMemories cascades from soft-forgotten episodes to their derived rows', async () => {
    // The standard erasure flow: soft forget now, empty the trash later.
    // The bulk purge must erase the derived text exactly like a direct
    // purge would, or the semantic keeps restating the forgotten content.
    const { ids, semantic } = await consolidateSentinel();

    forgetMemory(db, ids[0]);
    const result = purgeMemories(db);

    expect(result.episodes).toBe(1);
    expect(result.semantics).toBe(1);
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(semantic.id)).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM vec_semantics WHERE id = ?').get(semantic.id),
    ).toBeUndefined();
    for (const survivorId of ids.slice(1)) {
      expect(
        db.prepare('SELECT consolidated FROM episodes WHERE id = ?').get(survivorId).consolidated,
      ).toBe(0);
    }
  });

  it('purge removes memory anchors for the purged and cascaded rows', async () => {
    const { ids, semantic } = await consolidateSentinel();
    const now = new Date().toISOString();
    const insertAnchor = db.prepare(`
      INSERT INTO memory_anchors
        (id, memory_id, memory_type, agent, project_root, kind, value, state, created_at, last_verified_at)
      VALUES (?, ?, ?, 'default', ?, 'path', ?, 'intact', ?, ?)
    `);
    insertAnchor.run(generateId(), ids[0], 'episodic', TEST_DIR, 'src/app.ts', now, now);
    insertAnchor.run(generateId(), semantic.id, 'semantic', TEST_DIR, 'src/app.ts', now, now);

    forgetMemory(db, ids[0], { purge: true });

    const remaining = db
      .prepare('SELECT COUNT(*) AS c FROM memory_anchors WHERE memory_id IN (?, ?)')
      .get(ids[0], semantic.id);
    expect(remaining.c).toBe(0);
  });
});

describe('Audrey.forgetByQuery agent scoping', () => {
  const CLASS_DIR = './test-forget-class-data';
  let audrey;

  beforeEach(() => {
    if (existsSync(CLASS_DIR)) rmSync(CLASS_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: CLASS_DIR,
      agent: 'agent-a',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(CLASS_DIR)) rmSync(CLASS_DIR, { recursive: true });
  });

  it('defaults the destructive lookup to the instance agent; agent: null widens explicitly', async () => {
    const foreignId = await audrey.encode({
      content: 'foreign namespace deletion target',
      source: 'direct-observation',
      agent: 'agent-b',
    });

    // Default: scoped to agent-a, so agent-b's memory is untouchable. This
    // is the exact wiring MCP memory_forget and POST /v1/forget rely on.
    const scoped = await audrey.forgetByQuery('foreign namespace deletion target', {
      minSimilarity: 0.5,
    });
    expect(scoped).toBeNull();
    expect(audrey.db.prepare('SELECT id FROM episodes WHERE id = ?').get(foreignId)).toBeDefined();

    // Explicit widening reaches it.
    const widened = await audrey.forgetByQuery('foreign namespace deletion target', {
      minSimilarity: 0.5,
      agent: null,
    });
    expect(widened).not.toBeNull();
    expect(widened.id).toBe(foreignId);
  });
});
