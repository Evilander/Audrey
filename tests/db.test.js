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

  it('enforces source CHECK constraint on episodes', () => {
    const db = createDatabase(TEST_DIR);
    expect(() => {
      db.prepare(`INSERT INTO episodes (id, content, source, source_reliability, created_at)
                  VALUES (?, ?, ?, ?, ?)`).run('test-1', 'content', 'invalid-source', 0.5, new Date().toISOString());
    }).toThrow();
    closeDatabase(db);
  });

  it('enforces state CHECK constraint on semantics', () => {
    const db = createDatabase(TEST_DIR);
    expect(() => {
      db.prepare(`INSERT INTO semantics (id, content, state, created_at)
                  VALUES (?, ?, ?, ?)`).run('sem-1', 'content', 'invalid-state', new Date().toISOString());
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
