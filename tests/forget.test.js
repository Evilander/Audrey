import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { forgetMemory, forgetByQuery, purgeMemories } from '../src/forget.js';
import { encodeEpisode } from '../src/encode.js';
import { recall } from '../src/recall.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { generateId } from '../src/ulid.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-forget-data';

function insertSemantic(db, embedding, id, content, state = 'active') {
  const vec = embedding.embedSync
    ? embedding.embedSync(content)
    : null;
  return (async () => {
    const vector = await embedding.embed(content);
    const buf = embedding.vectorToBuffer(vector);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO semantics (id, content, embedding, state, evidence_count, supporting_count,
        contradicting_count, retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, content, buf, state, 1, 1, 0, 0, now, embedding.modelName, embedding.modelVersion);
    db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)').run(id, buf, state);
  })();
}

function insertProcedure(db, embedding, id, content, state = 'active') {
  return (async () => {
    const vector = await embedding.embed(content);
    const buf = embedding.vectorToBuffer(vector);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO procedures (id, content, embedding, state, success_count, failure_count,
        retrieval_count, created_at, embedding_model, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, content, buf, state, 3, 0, 0, now, embedding.modelName, embedding.modelVersion);
    db.prepare('INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)').run(id, buf, state);
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
    expect(() => forgetMemory(db, 'nonexistent-id-12345')).toThrow('Memory not found: nonexistent-id-12345');
  });

  it('hard-deletes an episode with purge: true', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Delete me permanently',
      source: 'direct-observation',
    });

    const result = forgetMemory(db, id, { purge: true });

    expect(result).toEqual({ id, type: 'episodic', purged: true });
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
    await insertProcedure(db, embedding, rolledBackProcId, 'Rolled back procedure goes', 'rolled_back');

    const result = purgeMemories(db);

    expect(result.episodes).toBe(1);
    expect(result.semantics).toBe(2);
    expect(result.procedures).toBe(1);

    expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get(activeEpId)).toBeDefined();
    expect(db.prepare('SELECT id FROM episodes WHERE id = ?').get(forgottenEpId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(activeSemId)).toBeDefined();
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(dormantSemId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM semantics WHERE id = ?').get(supersededSemId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM procedures WHERE id = ?').get(activeProcId)).toBeDefined();
    expect(db.prepare('SELECT id FROM procedures WHERE id = ?').get(rolledBackProcId)).toBeUndefined();
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

    const result = await forgetByQuery(db, embedding, 'Stripe API returned 429', { minSimilarity: 0.5 });

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

    const result = await forgetByQuery(db, embedding, 'quantum physics dark matter', { minSimilarity: 0.999 });

    expect(result).toBeNull();
  });

  it('supports purge on forgetByQuery', async () => {
    const id = await encodeEpisode(db, embedding, {
      content: 'Purge me via query',
      source: 'direct-observation',
    });

    const result = await forgetByQuery(db, embedding, 'Purge me via query', { minSimilarity: 0.5, purge: true });

    expect(result).not.toBeNull();
    expect(result.purged).toBe(true);
    const row = db.prepare('SELECT id FROM episodes WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });
});
