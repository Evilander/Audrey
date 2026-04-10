import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../dist/src/db.js';
import { createEmbeddingProvider } from '../dist/src/embedding.js';
import { reembedAll } from '../dist/src/migrate.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';
import { encodeEpisode } from '../dist/src/encode.js';

const TEST_DIR = './test-migrate-data';

describe('reembedAll', () => {
  let db, provider8, provider16;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    provider8 = createEmbeddingProvider({ provider: 'mock', dimensions: 8 });
    provider16 = createEmbeddingProvider({ provider: 'mock', dimensions: 16 });
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('re-embeds episodes into vec table', async () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const embedding8 = provider8.vectorToBuffer(await provider8.embed('test episode'));
    db1.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ep-1', 'test episode', embedding8, 'direct-observation', 0.9, new Date().toISOString());
    db1.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-1', embedding8, 'direct-observation', BigInt(0));
    closeDatabase(db1);

    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    await reembedAll(db, provider16);

    const vecRow = db.prepare('SELECT * FROM vec_episodes WHERE id = ?').get('ep-1');
    expect(vecRow).not.toBeNull();
    const storedVector = provider16.bufferToVector(vecRow.embedding);
    expect(storedVector).toHaveLength(16);
  });

  it('re-embeds semantics into vec table', async () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const embedding8 = provider8.vectorToBuffer(await provider8.embed('test semantic'));
    db1.prepare(
      'INSERT INTO semantics (id, content, embedding, state, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('sem-1', 'test semantic', embedding8, 'active', new Date().toISOString());
    db1.prepare(
      'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
    ).run('sem-1', embedding8, 'active');
    closeDatabase(db1);

    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    await reembedAll(db, provider16);

    const vecRow = db.prepare('SELECT * FROM vec_semantics WHERE id = ?').get('sem-1');
    expect(vecRow).not.toBeNull();
    const storedVector = provider16.bufferToVector(vecRow.embedding);
    expect(storedVector).toHaveLength(16);
  });

  it('re-embeds procedures into vec table', async () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const embedding8 = provider8.vectorToBuffer(await provider8.embed('test procedure'));
    db1.prepare(
      'INSERT INTO procedures (id, content, embedding, state, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('proc-1', 'test procedure', embedding8, 'active', new Date().toISOString());
    db1.prepare(
      'INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)'
    ).run('proc-1', embedding8, 'active');
    closeDatabase(db1);

    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    await reembedAll(db, provider16);

    const vecRow = db.prepare('SELECT * FROM vec_procedures WHERE id = ?').get('proc-1');
    expect(vecRow).not.toBeNull();
    const storedVector = provider16.bufferToVector(vecRow.embedding);
    expect(storedVector).toHaveLength(16);
  });

  it('returns counts', async () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const emb = provider8.vectorToBuffer(await provider8.embed('content'));
    db1.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ep-1', 'content', emb, 'direct-observation', 0.9, new Date().toISOString());
    db1.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-1', emb, 'direct-observation', BigInt(0));
    db1.prepare(
      'INSERT INTO semantics (id, content, embedding, state, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('sem-1', 'content', emb, 'active', new Date().toISOString());
    db1.prepare(
      'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
    ).run('sem-1', emb, 'active');
    closeDatabase(db1);

    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    const counts = await reembedAll(db, provider16);

    expect(counts).toEqual({
      episodes: 1,
      semantics: 1,
      procedures: 0,
    });
  });

  it('preserves consolidated episode state in vec_episodes during re-embed', async () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const emb = provider8.vectorToBuffer(await provider8.embed('content'));
    db1.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, consolidated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('ep-1', 'content', emb, 'direct-observation', 0.9, 1, new Date().toISOString());
    db1.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-1', emb, 'direct-observation', BigInt(1));
    closeDatabase(db1);

    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    await reembedAll(db, provider16);

    const row = db.prepare('SELECT consolidated FROM vec_episodes WHERE id = ?').get('ep-1');
    expect(Number(row.consolidated)).toBe(1);
  });

  it('rolls back all changes if embedding fails mid-way', async () => {
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    const emb = provider8.vectorToBuffer(await provider8.embed('ep one'));
    db.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ep-1', 'ep one', emb, 'direct-observation', 0.9, new Date().toISOString());
    db.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ep-2', 'ep two', emb, 'direct-observation', 0.9, new Date().toISOString());
    db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)').run('ep-1', emb, 'direct-observation', BigInt(0));
    db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)').run('ep-2', emb, 'direct-observation', BigInt(0));

    let callCount = 0;
    const failingProvider = {
      dimensions: 8,
      async embed() {
        callCount++;
        if (callCount > 1) throw new Error('embedding service down');
        return new Float32Array(8).fill(0.1);
      },
      async embedBatch(texts) {
        return Promise.all(texts.map(t => this.embed(t)));
      },
      vectorToBuffer(v) { return Buffer.from(v.buffer); },
    };

    await expect(reembedAll(db, failingProvider)).rejects.toThrow('embedding service down');

    // Legacy embedding column should be unchanged for BOTH episodes
    // (transaction rolled back, so even ep-1's update should be reverted)
    const ep1 = db.prepare('SELECT embedding FROM episodes WHERE id = ?').get('ep-1');
    const ep2 = db.prepare('SELECT embedding FROM episodes WHERE id = ?').get('ep-2');
    expect(Buffer.compare(ep1.embedding, emb)).toBe(0);
    expect(Buffer.compare(ep2.embedding, emb)).toBe(0);
  });

  it('handles empty database', async () => {
    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    const counts = await reembedAll(db, provider16);

    expect(counts).toEqual({
      episodes: 0,
      semantics: 0,
      procedures: 0,
    });
  });

  it('uses embedBatch instead of per-row embed', async () => {
    ({ db } = createDatabase(TEST_DIR, { dimensions: 8 }));
    const emb = provider8.vectorToBuffer(await provider8.embed('ep one'));
    db.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ep-1', 'ep one', emb, 'direct-observation', 0.9, new Date().toISOString());
    db.prepare(
      'INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ep-2', 'ep two', emb, 'direct-observation', 0.9, new Date().toISOString());
    db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)').run('ep-1', emb, 'direct-observation', BigInt(0));
    db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)').run('ep-2', emb, 'direct-observation', BigInt(0));

    let embedBatchCalled = false;
    const spyProvider = {
      dimensions: 16,
      async embed(text) { return provider16.embed(text); },
      async embedBatch(texts) {
        embedBatchCalled = true;
        return Promise.all(texts.map(t => this.embed(t)));
      },
      vectorToBuffer(v) { return provider16.vectorToBuffer(v); },
      bufferToVector(b) { return provider16.bufferToVector(b); },
    };

    await reembedAll(db, spyProvider, { dropAndRecreate: true });
    expect(embedBatchCalled).toBe(true);
  });

  it('reembedAll with dropAndRecreate repopulates vec0 tables', async () => {
    const tmpDir = join(tmpdir(), `audrey-reembed-test-${Date.now()}`);
    const provider8 = new MockEmbeddingProvider({ dimensions: 8 });
    const { db: testDb } = createDatabase(tmpDir, { dimensions: 8 });

    await encodeEpisode(testDb, provider8, { content: 'test memory', source: 'direct-observation' });

    const provider16 = new MockEmbeddingProvider({ dimensions: 16 });
    const counts = await reembedAll(testDb, provider16, { dropAndRecreate: true });

    expect(counts.episodes).toBe(1);

    const vecRow = testDb.prepare('SELECT id FROM vec_episodes').get();
    expect(vecRow).not.toBeNull();

    testDb.close();
  });
});
