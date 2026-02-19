import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-vec-data';

function makeVector(dimensions, seed = 1.0) {
  const v = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    v[i] = Math.sin(seed * (i + 1));
  }
  // Normalize
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < dimensions; i++) v[i] /= mag;
  return v;
}

describe('sqlite-vec foundation', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('loads sqlite-vec and creates vec0 tables when dimensions provided', () => {
    const db = createDatabase(TEST_DIR, { dimensions: 8 });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(t => t.name);
    expect(tables).toContain('vec_episodes');
    expect(tables).toContain('vec_semantics');
    expect(tables).toContain('vec_procedures');
    closeDatabase(db);
  });

  it('creates audrey_config table and stores dimensions', () => {
    const db = createDatabase(TEST_DIR, { dimensions: 64 });
    const row = db.prepare(
      "SELECT value FROM audrey_config WHERE key = 'dimensions'"
    ).get();
    expect(row).toBeDefined();
    expect(row.value).toBe('64');
    closeDatabase(db);
  });

  it('validates dimensions on re-open — throws on mismatch', () => {
    const db1 = createDatabase(TEST_DIR, { dimensions: 64 });
    closeDatabase(db1);
    expect(() => createDatabase(TEST_DIR, { dimensions: 128 })).toThrow(/dimension/i);
  });

  it('re-opens successfully with matching dimensions', () => {
    const db1 = createDatabase(TEST_DIR, { dimensions: 64 });
    closeDatabase(db1);
    const db2 = createDatabase(TEST_DIR, { dimensions: 64 });
    const row = db2.prepare(
      "SELECT value FROM audrey_config WHERE key = 'dimensions'"
    ).get();
    expect(row.value).toBe('64');
    closeDatabase(db2);
  });

  it('does NOT create vec0 tables when dimensions not provided (backwards compat)', () => {
    const db = createDatabase(TEST_DIR);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(t => t.name);
    expect(tables).not.toContain('vec_episodes');
    expect(tables).not.toContain('vec_semantics');
    expect(tables).not.toContain('vec_procedures');
    // audrey_config should still exist (for future use) but no dimensions stored
    expect(tables).toContain('audrey_config');
    closeDatabase(db);
  });

  it('can insert and KNN query a vector in vec_episodes', () => {
    const dims = 8;
    const db = createDatabase(TEST_DIR, { dimensions: dims });

    const v1 = makeVector(dims, 1.0);
    const v2 = makeVector(dims, 2.0);
    const v3 = makeVector(dims, 1.01); // very similar to v1

    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-1', Buffer.from(v1.buffer), 'direct-observation', BigInt(0));
    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-2', Buffer.from(v2.buffer), 'inference', BigInt(0));
    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-3', Buffer.from(v3.buffer), 'direct-observation', BigInt(1));

    // KNN: find 2 nearest to v1
    const results = db.prepare(
      'SELECT id, distance FROM vec_episodes WHERE embedding MATCH ? AND k = ?'
    ).all(Buffer.from(v1.buffer), 2);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('ep-1'); // exact match
    expect(results[0].distance).toBeCloseTo(0, 5);
    expect(results[1].id).toBe('ep-3'); // very similar
    closeDatabase(db);
  });

  it('supports metadata filtering in KNN queries', () => {
    const dims = 8;
    const db = createDatabase(TEST_DIR, { dimensions: dims });

    const v1 = makeVector(dims, 1.0);
    const v2 = makeVector(dims, 1.01);
    const v3 = makeVector(dims, 1.02);

    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-1', Buffer.from(v1.buffer), 'direct-observation', BigInt(0));
    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-2', Buffer.from(v2.buffer), 'inference', BigInt(0));
    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run('ep-3', Buffer.from(v3.buffer), 'direct-observation', BigInt(1));

    // Filter by source
    const results = db.prepare(
      'SELECT id, distance FROM vec_episodes WHERE embedding MATCH ? AND k = ? AND source = ?'
    ).all(Buffer.from(v1.buffer), 3, 'direct-observation');

    expect(results).toHaveLength(2);
    const ids = results.map(r => r.id);
    expect(ids).toContain('ep-1');
    expect(ids).toContain('ep-3');
    expect(ids).not.toContain('ep-2');

    closeDatabase(db);
  });

  it('can insert and KNN query vec_semantics with state filtering', () => {
    const dims = 8;
    const db = createDatabase(TEST_DIR, { dimensions: dims });

    const v1 = makeVector(dims, 1.0);
    const v2 = makeVector(dims, 1.01);

    db.prepare(
      'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
    ).run('sem-1', Buffer.from(v1.buffer), 'active');
    db.prepare(
      'INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)'
    ).run('sem-2', Buffer.from(v2.buffer), 'dormant');

    const results = db.prepare(
      'SELECT id, distance FROM vec_semantics WHERE embedding MATCH ? AND k = ? AND state = ?'
    ).all(Buffer.from(v1.buffer), 2, 'active');

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('sem-1');

    closeDatabase(db);
  });

  it('can insert and KNN query vec_procedures with state filtering', () => {
    const dims = 8;
    const db = createDatabase(TEST_DIR, { dimensions: dims });

    const v1 = makeVector(dims, 1.0);
    const v2 = makeVector(dims, 1.01);

    db.prepare(
      'INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)'
    ).run('proc-1', Buffer.from(v1.buffer), 'active');
    db.prepare(
      'INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)'
    ).run('proc-2', Buffer.from(v2.buffer), 'superseded');

    const results = db.prepare(
      'SELECT id, distance FROM vec_procedures WHERE embedding MATCH ? AND k = ? AND state = ?'
    ).all(Buffer.from(v1.buffer), 2, 'active');

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('proc-1');

    closeDatabase(db);
  });

  describe('migration: existing embedding BLOBs to vec0', () => {
    it('copies episode embeddings to vec_episodes on first open with dimensions', () => {
      const dims = 8;
      // First: create DB without dimensions (old-style)
      const db1 = createDatabase(TEST_DIR);
      const v1 = makeVector(dims, 1.0);
      const v2 = makeVector(dims, 2.0);
      db1.prepare(`INSERT INTO episodes (id, content, embedding, source, source_reliability, consolidated, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'ep-1', 'test content 1', Buffer.from(v1.buffer), 'direct-observation', 0.95, 0, new Date().toISOString()
      );
      db1.prepare(`INSERT INTO episodes (id, content, embedding, source, source_reliability, consolidated, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'ep-2', 'test content 2', Buffer.from(v2.buffer), 'inference', 0.7, 1, new Date().toISOString()
      );
      // Also one with NULL embedding — should be skipped
      db1.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
                    VALUES (?, ?, ?, ?, ?)`).run(
        'ep-3', 'no embedding', 'told-by-user', 0.85, new Date().toISOString()
      );
      closeDatabase(db1);

      // Re-open WITH dimensions — migration should run
      const db2 = createDatabase(TEST_DIR, { dimensions: dims });
      const rows = db2.prepare(
        'SELECT id, distance FROM vec_episodes WHERE embedding MATCH ? AND k = ?'
      ).all(Buffer.from(v1.buffer), 10);

      expect(rows.length).toBe(2); // ep-1 and ep-2 migrated, ep-3 skipped (no embedding)
      const ids = rows.map(r => r.id);
      expect(ids).toContain('ep-1');
      expect(ids).toContain('ep-2');

      closeDatabase(db2);
    });

    it('copies semantic embeddings to vec_semantics on first open with dimensions', () => {
      const dims = 8;
      const db1 = createDatabase(TEST_DIR);
      const v1 = makeVector(dims, 1.0);
      db1.prepare(`INSERT INTO semantics (id, content, embedding, state, created_at)
                    VALUES (?, ?, ?, ?, ?)`).run(
        'sem-1', 'test principle', Buffer.from(v1.buffer), 'active', new Date().toISOString()
      );
      closeDatabase(db1);

      const db2 = createDatabase(TEST_DIR, { dimensions: dims });
      const rows = db2.prepare(
        'SELECT id, distance FROM vec_semantics WHERE embedding MATCH ? AND k = ?'
      ).all(Buffer.from(v1.buffer), 10);

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('sem-1');

      closeDatabase(db2);
    });

    it('copies procedure embeddings to vec_procedures on first open with dimensions', () => {
      const dims = 8;
      const db1 = createDatabase(TEST_DIR);
      const v1 = makeVector(dims, 3.0);
      db1.prepare(`INSERT INTO procedures (id, content, embedding, state, created_at)
                    VALUES (?, ?, ?, ?, ?)`).run(
        'proc-1', 'test procedure', Buffer.from(v1.buffer), 'active', new Date().toISOString()
      );
      closeDatabase(db1);

      const db2 = createDatabase(TEST_DIR, { dimensions: dims });
      const rows = db2.prepare(
        'SELECT id, distance FROM vec_procedures WHERE embedding MATCH ? AND k = ?'
      ).all(Buffer.from(v1.buffer), 10);

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('proc-1');

      closeDatabase(db2);
    });

    it('does not duplicate if migration already ran', () => {
      const dims = 8;
      const db1 = createDatabase(TEST_DIR);
      const v1 = makeVector(dims, 1.0);
      db1.prepare(`INSERT INTO episodes (id, content, embedding, source, source_reliability, consolidated, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'ep-1', 'test', Buffer.from(v1.buffer), 'direct-observation', 0.95, 0, new Date().toISOString()
      );
      closeDatabase(db1);

      // Open with dimensions (triggers migration)
      const db2 = createDatabase(TEST_DIR, { dimensions: dims });
      closeDatabase(db2);

      // Open again (migration should not duplicate)
      const db3 = createDatabase(TEST_DIR, { dimensions: dims });
      const rows = db3.prepare(
        'SELECT id, distance FROM vec_episodes WHERE embedding MATCH ? AND k = ?'
      ).all(Buffer.from(v1.buffer), 10);

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe('ep-1');

      closeDatabase(db3);
    });
  });
});
