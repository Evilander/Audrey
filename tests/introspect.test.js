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
    db = createDatabase(TEST_DIR, { dimensions: 8 });
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

  it('returns dormant count', () => {
    db.prepare(`INSERT INTO semantics (id, content, state, evidence_count, supporting_count,
      source_type_diversity, created_at) VALUES (?, ?, 'dormant', 1, 1, 1, ?)`).run(
      'dormant-1', 'Old memory', new Date().toISOString()
    );
    const stats = introspect(db);
    expect(stats.dormant).toBe(1);
  });
});
