import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase, readStoredDimensions } from '../src/db.js';
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
    const { db } = createDatabase(TEST_DIR);
    expect(existsSync(`${TEST_DIR}/audrey.db`)).toBe(true);
    closeDatabase(db);
  });

  it('creates all required tables', () => {
    const { db } = createDatabase(TEST_DIR);
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
    const { db } = createDatabase(TEST_DIR);
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    closeDatabase(db);
  });

  it('can insert and retrieve an episode', () => {
    const { db } = createDatabase(TEST_DIR);
    db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
                VALUES (?, ?, ?, ?, ?)`).run('test-1', 'test content', 'direct-observation', 0.95, new Date().toISOString());
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get('test-1');
    expect(row.content).toBe('test content');
    expect(row.source).toBe('direct-observation');
    closeDatabase(db);
  });

  it('enforces source CHECK constraint on episodes', () => {
    const { db } = createDatabase(TEST_DIR);
    expect(() => {
      db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
                  VALUES (?, ?, ?, ?, ?)`).run('test-1', 'content', 'invalid-source', 0.5, new Date().toISOString());
    }).toThrow();
    closeDatabase(db);
  });

  it('enforces state CHECK constraint on semantics', () => {
    const { db } = createDatabase(TEST_DIR);
    expect(() => {
      db.prepare(`INSERT INTO semantics (id, content, state, created_at)
                  VALUES (?, ?, ?, ?)`).run('sem-1', 'content', 'invalid-state', new Date().toISOString());
    }).toThrow();
    closeDatabase(db);
  });

  it('idempotent: calling createDatabase twice on same dir does not error', () => {
    const { db: db1 } = createDatabase(TEST_DIR);
    closeDatabase(db1);
    const { db: db2 } = createDatabase(TEST_DIR);
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(tables.length).toBeGreaterThan(0);
    closeDatabase(db2);
  });
});

describe('readStoredDimensions', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns stored dimensions from existing database', () => {
    const { db } = createDatabase(TEST_DIR, { dimensions: 1536 });
    closeDatabase(db);
    expect(readStoredDimensions(TEST_DIR)).toBe(1536);
  });

  it('returns null when no dimensions stored', () => {
    const { db } = createDatabase(TEST_DIR);
    closeDatabase(db);
    expect(readStoredDimensions(TEST_DIR)).toBeNull();
  });

  it('returns null when database does not exist', () => {
    expect(readStoredDimensions('./nonexistent-dir-xyz')).toBeNull();
  });
});

describe('dimension migration', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('migrates vec0 tables when dimensions change', () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    closeDatabase(db1);

    const { db: db2, migrated } = createDatabase(TEST_DIR, { dimensions: 1536 });
    expect(migrated).toBe(true);

    const storedDims = db2.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get();
    expect(parseInt(storedDims.value, 10)).toBe(1536);

    const vecTables = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_%' ORDER BY name"
    ).all().map(t => t.name);
    expect(vecTables).toContain('vec_episodes');
    expect(vecTables).toContain('vec_semantics');
    expect(vecTables).toContain('vec_procedures');

    closeDatabase(db2);
  });

  it('returns migrated=false when dimensions match', () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 1536 });
    closeDatabase(db1);

    const { db: db2, migrated } = createDatabase(TEST_DIR, { dimensions: 1536 });
    expect(migrated).toBe(false);
    closeDatabase(db2);
  });

  it('returns migrated=false for fresh database', () => {
    const { db, migrated } = createDatabase(TEST_DIR, { dimensions: 1536 });
    expect(migrated).toBe(false);
    closeDatabase(db);
  });

  it('preserves episode text data after migration', () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    db1.prepare(
      `INSERT INTO episodes (id, content, source, source_reliability, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('ep-1', 'remember this', 'direct-observation', 0.9, new Date().toISOString());
    closeDatabase(db1);

    const { db: db2, migrated } = createDatabase(TEST_DIR, { dimensions: 1536 });
    expect(migrated).toBe(true);

    const row = db2.prepare('SELECT content, source FROM episodes WHERE id = ?').get('ep-1');
    expect(row.content).toBe('remember this');
    expect(row.source).toBe('direct-observation');
    closeDatabase(db2);
  });

  it('skips legacy BLOBs with mismatched dimensions during migration', () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const bigEmbedding = Buffer.from(new Float32Array(16).fill(0.5).buffer);
    db1.prepare(
      `INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ep-big', 'big embedding', bigEmbedding, 'direct-observation', 0.9, new Date().toISOString());
    const goodEmbedding = Buffer.from(new Float32Array(8).fill(0.1).buffer);
    db1.prepare(
      `INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ep-good', 'good embedding', goodEmbedding, 'direct-observation', 0.9, new Date().toISOString());
    db1.exec('DELETE FROM vec_episodes');
    closeDatabase(db1);

    const { db: db2 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const vecCount = db2.prepare('SELECT COUNT(*) as c FROM vec_episodes').get().c;
    expect(vecCount).toBe(1);
    const vecRow = db2.prepare('SELECT id FROM vec_episodes').get();
    expect(vecRow.id).toBe('ep-good');
    closeDatabase(db2);
  });

  it('clears vec tables after migration', () => {
    const { db: db1 } = createDatabase(TEST_DIR, { dimensions: 8 });
    const embedding = new Float32Array(8).fill(0.1);
    db1.prepare(
      `INSERT INTO episodes (id, content, embedding, source, source_reliability, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ep-1', 'test', Buffer.from(embedding.buffer), 'direct-observation', 0.9, new Date().toISOString());
    db1.prepare(
      `INSERT INTO vec_episodes (id, embedding, source, consolidated) VALUES (?, ?, ?, ?)`
    ).run('ep-1', Buffer.from(embedding.buffer), 'direct-observation', BigInt(0));
    closeDatabase(db1);

    const { db: db2, migrated } = createDatabase(TEST_DIR, { dimensions: 1536 });
    expect(migrated).toBe(true);

    const vecCount = db2.prepare('SELECT COUNT(*) as c FROM vec_episodes').get().c;
    expect(vecCount).toBe(0);
    closeDatabase(db2);
  });
});

describe('schema migrations', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('migration 7: adds private column to episodes', () => {
    const { db } = createDatabase(TEST_DIR);
    const cols = db.pragma('table_info(episodes)').map(c => c.name);
    expect(cols).toContain('private');
    closeDatabase(db);
  });

  it('private column defaults to 0', () => {
    const { db } = createDatabase(TEST_DIR);
    const cols = db.pragma('table_info(episodes)');
    const col = cols.find(c => c.name === 'private');
    expect(col.dflt_value).toBe('0');
    closeDatabase(db);
  });
});
