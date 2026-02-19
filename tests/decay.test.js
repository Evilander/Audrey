import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyDecay } from '../src/decay.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { generateId } from '../src/ulid.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-decay-data';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

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
    // 120 days old, no supporting evidence, all contradicting, never retrieved.
    // confidence = 0.30*0.95 + 0.35*0.0 + 0.20*~0.063 + 0.15*0 = ~0.298
    // With dormantThreshold=0.3 this goes dormant.
    const id = generateId();
    db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'Old forgotten fact', 'active', 0, 3, 0, daysAgo(120));

    const result = applyDecay(db, { dormantThreshold: 0.3 });

    const row = db.prepare('SELECT state FROM semantics WHERE id = ?').get(id);
    expect(row.state).toBe('dormant');
    expect(result.transitionedToDormant).toBeGreaterThanOrEqual(1);
  });

  it('does NOT mark recent high-evidence memories as dormant', () => {
    // Fresh, well-supported, recently retrieved. Confidence ~0.835+
    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, last_reinforced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'Fresh well-supported fact', 'active', 10, 0, 5, now, now);

    applyDecay(db, { dormantThreshold: 0.3 });

    const row = db.prepare('SELECT state FROM semantics WHERE id = ?').get(id);
    expect(row.state).toBe('active');
  });

  it('returns statistics (totalEvaluated, transitionedToDormant, timestamp)', () => {
    // One memory that will decay: old, all contradicting evidence, no retrieval
    db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), 'Will decay', 'active', 0, 5, 0, daysAgo(200));

    // One that will survive: fresh, well-supported, recently retrieved
    db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, last_reinforced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), 'Will survive', 'active', 5, 0, 3, new Date().toISOString(), new Date().toISOString());

    const result = applyDecay(db, { dormantThreshold: 0.3 });

    expect(result).toHaveProperty('totalEvaluated');
    expect(result).toHaveProperty('transitionedToDormant');
    expect(result).toHaveProperty('timestamp');
    expect(typeof result.totalEvaluated).toBe('number');
    expect(typeof result.transitionedToDormant).toBe('number');
    expect(typeof result.timestamp).toBe('string');
    expect(result.totalEvaluated).toBe(2);
    expect(result.transitionedToDormant).toBe(1);
  });

  it('evaluates procedural memories and marks old ones dormant', () => {
    // Old procedural: 200 days old, all failures, no retrieval
    // procedural half-life = 90 days, so 200 days = ~2.2 half-lives
    // confidence = 0.30*0.95 + 0.35*0.0 + 0.20*exp(-ln2/90*200) + 0.15*0
    //            = 0.285 + 0 + 0.20*0.214 + 0 = 0.285 + 0.043 = ~0.328
    // Need threshold slightly above that, use 0.35
    const oldProcId = generateId();
    db.prepare(`
      INSERT INTO procedures (id, content, state, success_count, failure_count,
        retrieval_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(oldProcId, 'Old failed procedure', 'active', 0, 5, 0, daysAgo(200));

    // Fresh procedural: just created, all successes, recently retrieved
    const freshProcId = generateId();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO procedures (id, content, state, success_count, failure_count,
        retrieval_count, last_reinforced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(freshProcId, 'Fresh successful procedure', 'active', 10, 0, 5, now, now);

    const result = applyDecay(db, { dormantThreshold: 0.35 });

    const oldRow = db.prepare('SELECT state FROM procedures WHERE id = ?').get(oldProcId);
    const freshRow = db.prepare('SELECT state FROM procedures WHERE id = ?').get(freshProcId);
    expect(oldRow.state).toBe('dormant');
    expect(freshRow.state).toBe('active');
    expect(result.totalEvaluated).toBe(2);
    expect(result.transitionedToDormant).toBe(1);
  });

  it('skips memories already in dormant state', () => {
    const id = generateId();
    db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'Already dormant', 'dormant', 0, 0, 0, daysAgo(200));

    const result = applyDecay(db);

    expect(result.totalEvaluated).toBe(0);
    expect(result.transitionedToDormant).toBe(0);
  });

  it('respects custom dormantThreshold', () => {
    // With a very high threshold (0.9), even recent memories with some contradictions go dormant
    const id = generateId();
    db.prepare(`
      INSERT INTO semantics (id, content, state, supporting_count, contradicting_count,
        retrieval_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'Medium confidence fact', 'active', 1, 1, 0, daysAgo(30));

    const result = applyDecay(db, { dormantThreshold: 0.9 });

    const row = db.prepare('SELECT state FROM semantics WHERE id = ?').get(id);
    expect(row.state).toBe('dormant');
    expect(result.transitionedToDormant).toBe(1);
  });

  it('handles empty database gracefully', () => {
    const result = applyDecay(db);

    expect(result.totalEvaluated).toBe(0);
    expect(result.transitionedToDormant).toBe(0);
    expect(result.timestamp).toBeTruthy();
  });
});
