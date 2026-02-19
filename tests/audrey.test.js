import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/audrey.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-audrey-main';

describe('Audrey', () => {
  let brain;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    brain = new Audrey({
      dataDir: TEST_DIR,
      agent: 'test-agent',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    brain.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates an Audrey instance', () => {
    expect(brain).toBeInstanceOf(Audrey);
  });

  it('encodes an episodic memory', async () => {
    const id = await brain.encode({
      content: 'Stripe API returned 429',
      source: 'direct-observation',
    });
    expect(typeof id).toBe('string');
  });

  it('recalls memories', async () => {
    await brain.encode({ content: 'Test observation', source: 'direct-observation' });
    const results = await brain.recall('test', {});
    expect(Array.isArray(results)).toBe(true);
  });

  it('emits encode event', async () => {
    let emitted = false;
    brain.on('encode', () => { emitted = true; });
    await brain.encode({ content: 'Test', source: 'direct-observation' });
    expect(emitted).toBe(true);
  });

  it('runs consolidation', async () => {
    const result = await brain.consolidate();
    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('status');
  });

  it('emits consolidation event', async () => {
    let emitted = false;
    brain.on('consolidation', () => { emitted = true; });
    await brain.consolidate();
    expect(emitted).toBe(true);
  });

  it('returns introspection stats', async () => {
    await brain.encode({ content: 'Test', source: 'direct-observation' });
    const stats = brain.introspect();
    expect(stats.episodic).toBe(1);
  });

  it('rolls back consolidation', async () => {
    await brain.encode({ content: 'same', source: 'direct-observation' });
    await brain.encode({ content: 'same', source: 'tool-result' });
    await brain.encode({ content: 'same', source: 'told-by-user' });

    const result = await brain.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      extractPrinciple: () => ({ content: 'Principle', type: 'semantic' }),
    });
    brain.rollback(result.runId);

    const history = brain.consolidationHistory();
    const run = history.find(r => r.id === result.runId);
    expect(run.status).toBe('rolled_back');
  });

  it('applies decay', () => {
    const result = brain.decay();
    expect(result).toHaveProperty('totalEvaluated');
    expect(result).toHaveProperty('transitionedToDormant');
  });

  it('emits decay event', () => {
    let emitted = false;
    brain.on('decay', () => { emitted = true; });
    brain.decay();
    expect(emitted).toBe(true);
  });
});
