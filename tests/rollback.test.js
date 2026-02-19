import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rollbackConsolidation, getConsolidationHistory } from '../src/rollback.js';
import { encodeEpisode } from '../src/encode.js';
import { runConsolidation } from '../src/consolidate.js';
import { createDatabase, closeDatabase } from '../src/db.js';
import { MockEmbeddingProvider } from '../src/embedding.js';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const TEST_DIR = './test-rollback-data';

describe('rollback', () => {
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

  it('returns consolidation history', async () => {
    await runConsolidation(db, embedding, { minClusterSize: 3 });
    const history = getConsolidationHistory(db);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);
    expect(history[0]).toHaveProperty('id');
    expect(history[0]).toHaveProperty('status');
  });

  it('rolls back a consolidation run', async () => {
    await encodeEpisode(db, embedding, { content: 'same event', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same event', source: 'told-by-user' });

    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3, similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Test principle', type: 'semantic' }),
    });

    rollbackConsolidation(db, result.runId);

    // Semantic memories rolled back
    const active = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'active'").get();
    expect(active.count).toBe(0);
    const rolledBack = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'rolled_back'").get();
    expect(rolledBack.count).toBe(1);

    // Episodes un-consolidated
    const unconsolidated = db.prepare('SELECT COUNT(*) as count FROM episodes WHERE consolidated = 0').get();
    expect(unconsolidated.count).toBe(3);

    // Run marked as rolled_back
    const run = db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get(result.runId);
    expect(run.status).toBe('rolled_back');
  });

  it('throws for non-existent run ID', () => {
    expect(() => rollbackConsolidation(db, 'nonexistent')).toThrow();
  });

  it('throws for already rolled-back run', async () => {
    await encodeEpisode(db, embedding, { content: 'same', source: 'direct-observation' });
    await encodeEpisode(db, embedding, { content: 'same', source: 'tool-result' });
    await encodeEpisode(db, embedding, { content: 'same', source: 'told-by-user' });
    const result = await runConsolidation(db, embedding, {
      minClusterSize: 3, similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'P', type: 'semantic' }),
    });
    rollbackConsolidation(db, result.runId);
    expect(() => rollbackConsolidation(db, result.runId)).toThrow();
  });
});
