import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-adaptive';

describe('suggestConsolidationParams', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns defaults when no history exists', () => {
    const params = audrey.suggestConsolidationParams();
    expect(params).toHaveProperty('minClusterSize');
    expect(params).toHaveProperty('similarityThreshold');
    expect(params).toHaveProperty('confidence');
    expect(params.confidence).toBe('no_data');
  });

  it('suggests params based on historical success', async () => {
    const now = new Date().toISOString();

    const insertRun = audrey.db.prepare(`
      INSERT INTO consolidation_runs (id, started_at, status, input_episode_ids, output_memory_ids)
      VALUES (?, ?, 'completed', '[]', '[]')
    `);
    insertRun.run('r1', now);
    insertRun.run('r2', now);
    insertRun.run('r3', now);

    const insert = audrey.db.prepare(`
      INSERT INTO consolidation_metrics (id, run_id, min_cluster_size, similarity_threshold,
        episodes_evaluated, clusters_found, principles_extracted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('m1', 'r1', 3, 0.85, 10, 1, 2, now);
    insert.run('m2', 'r2', 2, 0.70, 10, 3, 5, now);
    insert.run('m3', 'r3', 2, 0.70, 15, 4, 6, now);

    const params = audrey.suggestConsolidationParams();
    expect(params.confidence).not.toBe('no_data');
    expect(params.minClusterSize).toBe(2);
    expect(params.similarityThreshold).toBeCloseTo(0.70, 1);
  });
});
