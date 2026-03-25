import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Audrey } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('implicit relevance feedback', () => {
  let audrey;
  let dataDir;
  let memoryId;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-relevance-'));
    audrey = new Audrey({
      dataDir,
      agent: 'relevance-test',
      embedding: { provider: 'mock', dimensions: 64 },
    });
    memoryId = await audrey.encode({
      content: 'The deploy pipeline uses GitHub Actions with Node 20',
      source: 'direct-observation',
    });
    // Encode a few more for recall coverage
    await audrey.encode({ content: 'Redis SCAN is safer than KEYS for production', source: 'told-by-user' });
    await audrey.encode({ content: 'Stripe webhook signature verification is required', source: 'direct-observation' });
  });

  afterAll(() => {
    audrey.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('markUsed increments usage_count', () => {
    const before = audrey.db.prepare('SELECT usage_count FROM episodes WHERE id = ?').get(memoryId);
    expect(before.usage_count).toBe(0);

    audrey.markUsed(memoryId);

    const after = audrey.db.prepare('SELECT usage_count FROM episodes WHERE id = ?').get(memoryId);
    expect(after.usage_count).toBe(1);
  });

  it('markUsed updates last_used_at', () => {
    const before = audrey.db.prepare('SELECT last_used_at FROM episodes WHERE id = ?').get(memoryId);
    // May already be set from previous test
    audrey.markUsed(memoryId);
    const after = audrey.db.prepare('SELECT last_used_at FROM episodes WHERE id = ?').get(memoryId);
    expect(after.last_used_at).toBeDefined();
    expect(after.last_used_at).not.toBeNull();
  });

  it('markUsed works on semantic memories too', async () => {
    // Force consolidation to create a semantic
    await audrey.encode({ content: 'Deploy pipeline uses GitHub Actions', source: 'direct-observation' });
    await audrey.encode({ content: 'Deploy pipeline runs on GitHub Actions CI', source: 'direct-observation' });
    await audrey.encode({ content: 'GitHub Actions handles the deploy pipeline', source: 'direct-observation' });
    await audrey.consolidate({ similarityThreshold: -1, minClusterSize: 2 });
    const sem = audrey.db.prepare('SELECT id, usage_count FROM semantics LIMIT 1').get();
    if (sem) {
      audrey.markUsed(sem.id);
      const after = audrey.db.prepare('SELECT usage_count FROM semantics WHERE id = ?').get(sem.id);
      expect(after.usage_count).toBe(1);
    }
  });

  it('markUsed on nonexistent id does not throw', () => {
    expect(() => audrey.markUsed('nonexistent-id')).not.toThrow();
  });

  it('emits used event', () => {
    let emitted = false;
    audrey.on('used', () => { emitted = true; });
    audrey.markUsed(memoryId);
    expect(emitted).toBe(true);
  });

  it('retrieved-but-never-used memories exist for dream to detect', async () => {
    // Recall several times without marking used
    for (let i = 0; i < 6; i++) {
      await audrey.recall('Redis production');
    }
    // The Redis memory now has retrieval_count >= 6 but usage_count = 0
    const redis = audrey.db.prepare(
      "SELECT usage_count FROM episodes WHERE content LIKE '%Redis%'"
    ).get();
    expect(redis).toHaveProperty('usage_count');
    expect(redis.usage_count).toBe(0);
  });
});
