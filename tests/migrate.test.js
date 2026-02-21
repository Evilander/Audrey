import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import { createEmbeddingProvider } from '../src/embedding.js';
import { reembedAll } from '../src/migrate.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

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

  it('handles empty database', async () => {
    ({ db } = createDatabase(TEST_DIR, { dimensions: 16 }));
    const counts = await reembedAll(db, provider16);

    expect(counts).toEqual({
      episodes: 0,
      semantics: 0,
      procedures: 0,
    });
  });
});
