import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { existsSync, rmSync } from 'node:fs';

describe('multi-agent memory', () => {
  let audreyA;
  let audreyB;
  const dataDir = './test-multi-agent';

  beforeAll(async () => {
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    audreyA = new Audrey({
      dataDir,
      agent: 'agent-alpha',
      embedding: { provider: 'mock', dimensions: 64 },
    });
    audreyB = new Audrey({
      dataDir,
      agent: 'agent-beta',
      embedding: { provider: 'mock', dimensions: 64 },
    });
  });

  afterAll(async () => {
    await audreyA.closeAsync();
    await audreyB.closeAsync();
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it('encodes memories with agent identity', async () => {
    const idA = await audreyA.encode({ content: 'Alpha remembers the deployment', source: 'direct-observation' });
    const idB = await audreyB.encode({ content: 'Beta remembers the incident', source: 'direct-observation' });
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
  });

  it('recall with scope=shared returns all agents memories (default)', async () => {
    const results = await audreyA.recall('deployment incident', { limit: 10 });
    const contents = results.map(r => r.content);
    expect(contents.some(c => c.includes('Alpha'))).toBe(true);
    expect(contents.some(c => c.includes('Beta'))).toBe(true);
  });

  it('recall with scope=agent returns only own agent memories', async () => {
    const resultsA = await audreyA.recall('deployment incident', { limit: 10, scope: 'agent' });
    for (const r of resultsA) {
      expect(r.agent).toBe('agent-alpha');
    }

    const resultsB = await audreyB.recall('deployment incident', { limit: 10, scope: 'agent' });
    for (const r of resultsB) {
      expect(r.agent).toBe('agent-beta');
    }
  });

  it('introspect shows per-agent counts when agent is set', () => {
    const statsA = audreyA.introspect();
    expect(statsA.episodic).toBeGreaterThanOrEqual(1);
  });

  it('legacy memories without agent column are visible to all agents', async () => {
    // Memories encoded before multi-agent have agent='default'
    // Both agents should see them in shared scope
    const results = await audreyA.recall('deployment', { limit: 20 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('scope=agent with no matching memories returns empty', async () => {
    const audreyC = new Audrey({
      dataDir,
      agent: 'agent-gamma',
      embedding: { provider: 'mock', dimensions: 64 },
    });
    const results = await audreyC.recall('deployment', { limit: 10, scope: 'agent' });
    expect(results.length).toBe(0);
    audreyC.close();
  });

  it('keyword-only recall preserves agent attribution', async () => {
    const results = await audreyA.recall('Alpha', {
      limit: 10,
      scope: 'agent',
      retrieval: 'keyword',
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.agent).toBe('agent-alpha');
    }
  });

  it('keeps consolidated memories scoped to the consolidating agent', async () => {
    await audreyA.encode({ content: 'Alpha-only consolidation marker', source: 'direct-observation' });
    await audreyA.encode({ content: 'Alpha-only consolidation marker', source: 'tool-result' });
    await audreyA.encode({ content: 'Alpha-only consolidation marker', source: 'told-by-user' });
    await audreyB.encode({ content: 'Beta-only consolidation marker', source: 'direct-observation' });
    await audreyB.encode({ content: 'Beta-only consolidation marker', source: 'tool-result' });
    await audreyB.encode({ content: 'Beta-only consolidation marker', source: 'told-by-user' });

    await audreyA.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Alpha-owned semantic principle', type: 'semantic' }),
    });
    await audreyB.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Beta-owned semantic principle', type: 'semantic' }),
    });

    const rows = audreyA.db.prepare(`
      SELECT content, agent FROM semantics
      WHERE content IN ('Alpha-owned semantic principle', 'Beta-owned semantic principle')
      ORDER BY content
    `).all();

    expect(rows).toEqual([
      { content: 'Alpha-owned semantic principle', agent: 'agent-alpha' },
      { content: 'Beta-owned semantic principle', agent: 'agent-beta' },
    ]);
  });
});
