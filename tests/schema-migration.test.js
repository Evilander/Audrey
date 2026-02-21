import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, closeDatabase } from '../src/db.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-schema-migration';

describe('v0.7.0 schema columns', () => {
  let db;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    ({ db } = createDatabase(TEST_DIR));
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('semantics has interference_count column defaulting to 0', () => {
    db.prepare(
      `INSERT INTO semantics (id, content, created_at) VALUES (?, ?, ?)`
    ).run('sem-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT interference_count FROM semantics WHERE id = ?').get('sem-1');
    expect(row.interference_count).toBe(0);
  });

  it('semantics has salience column defaulting to 0.5', () => {
    db.prepare(
      `INSERT INTO semantics (id, content, created_at) VALUES (?, ?, ?)`
    ).run('sem-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT salience FROM semantics WHERE id = ?').get('sem-1');
    expect(row.salience).toBe(0.5);
  });

  it('procedures has interference_count column defaulting to 0', () => {
    db.prepare(
      `INSERT INTO procedures (id, content, created_at) VALUES (?, ?, ?)`
    ).run('proc-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT interference_count FROM procedures WHERE id = ?').get('proc-1');
    expect(row.interference_count).toBe(0);
  });

  it('procedures has salience column defaulting to 0.5', () => {
    db.prepare(
      `INSERT INTO procedures (id, content, created_at) VALUES (?, ?, ?)`
    ).run('proc-1', 'test', new Date().toISOString());
    const row = db.prepare('SELECT salience FROM procedures WHERE id = ?').get('proc-1');
    expect(row.salience).toBe(0.5);
  });
});
