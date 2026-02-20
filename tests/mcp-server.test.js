import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../src/index.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-mcp-server';

describe('MCP tool: memory_encode', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('stores an episode and returns an id', async () => {
    const id = await audrey.encode({
      content: 'User prefers dark mode',
      source: 'told-by-user',
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('works with tags', async () => {
    const id = await audrey.encode({
      content: 'API returns 429 on high traffic',
      source: 'direct-observation',
      tags: ['api', 'rate-limit'],
    });
    expect(typeof id).toBe('string');

    const ep = audrey.db.prepare('SELECT tags FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(ep.tags)).toEqual(['api', 'rate-limit']);
  });

  it('rejects empty content', async () => {
    await expect(
      audrey.encode({ content: '', source: 'direct-observation' })
    ).rejects.toThrow('content must be a non-empty string');
  });

  it('rejects invalid source type', async () => {
    await expect(
      audrey.encode({ content: 'valid content', source: 'made-up-source' })
    ).rejects.toThrow('Unknown source type');
  });

  it('respects salience parameter', async () => {
    const id = await audrey.encode({
      content: 'Critical finding',
      source: 'direct-observation',
      salience: 0.9,
    });
    const ep = audrey.db.prepare('SELECT salience FROM episodes WHERE id = ?').get(id);
    expect(ep.salience).toBeCloseTo(0.9);
  });
});

describe('MCP tool: memory_recall', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await audrey.encode({ content: 'Node.js uses V8 engine', source: 'told-by-user' });
    await audrey.encode({ content: 'Python uses CPython', source: 'tool-result' });
    await audrey.encode({ content: 'Rust has zero-cost abstractions', source: 'inference' });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns results matching query', async () => {
    const results = await audrey.recall('Node.js', { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('content');
    expect(results[0]).toHaveProperty('confidence');
    expect(results[0]).toHaveProperty('type');
  });

  it('respects limit option', async () => {
    const results = await audrey.recall('programming', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for impossibly high minConfidence', async () => {
    const results = await audrey.recall('Node.js', { minConfidence: 0.999 });
    expect(results.length).toBe(0);
  });

  it('supports types filter', async () => {
    const results = await audrey.recall('engine', { types: ['episodic'] });
    for (const r of results) {
      expect(r.type).toBe('episodic');
    }
  });
});

describe('MCP tool: memory_consolidate', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('extracts principles from 3+ similar episodes', async () => {
    // Encode identical content to guarantee clustering
    await audrey.encode({ content: 'same observation', source: 'direct-observation' });
    await audrey.encode({ content: 'same observation', source: 'tool-result' });
    await audrey.encode({ content: 'same observation', source: 'told-by-user' });

    const result = await audrey.consolidate({
      minClusterSize: 3,
      similarityThreshold: 0.99,
    });

    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('episodesEvaluated');
    expect(result).toHaveProperty('clustersFound');
    expect(result).toHaveProperty('principlesExtracted');
    expect(result).toHaveProperty('status', 'completed');
    expect(result.principlesExtracted).toBeGreaterThanOrEqual(1);
  });

  it('returns zero principles when nothing to consolidate', async () => {
    const result = await audrey.consolidate();
    expect(result.principlesExtracted).toBe(0);
    expect(result.clustersFound).toBe(0);
  });
});

describe('MCP tool: memory_introspect', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns memory stats after encoding', async () => {
    await audrey.encode({ content: 'First memory', source: 'direct-observation' });
    await audrey.encode({ content: 'Second memory', source: 'tool-result' });

    const stats = audrey.introspect();
    expect(stats.episodic).toBe(2);
    expect(stats.semantic).toBe(0);
    expect(stats.procedural).toBe(0);
    expect(stats).toHaveProperty('causalLinks');
    expect(stats).toHaveProperty('dormant');
    expect(stats).toHaveProperty('contradictions');
    expect(stats).toHaveProperty('lastConsolidation');
    expect(stats).toHaveProperty('totalConsolidationRuns');
  });

  it('returns zeroes on empty database', () => {
    const stats = audrey.introspect();
    expect(stats.episodic).toBe(0);
    expect(stats.semantic).toBe(0);
    expect(stats.procedural).toBe(0);
    expect(stats.causalLinks).toBe(0);
    expect(stats.dormant).toBe(0);
  });
});

describe('MCP tool: memory_resolve_truth', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
      llm: {
        provider: 'mock',
        responses: {
          contextResolution: {
            resolution: 'context_dependent',
            conditions: { summer: 'A applies', winter: 'B applies' },
            explanation: 'Both valid in different seasons',
          },
        },
      },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('resolves a contradiction with mock LLM', async () => {
    // Set up contradiction manually
    audrey.db.prepare(`
      INSERT INTO semantics (id, content, state, created_at, evidence_count,
        supporting_count, source_type_diversity, evidence_episode_ids)
      VALUES (?, ?, 'active', ?, 1, 1, 1, '[]')
    `).run('sem-x', 'Claim X content', new Date().toISOString());

    audrey.db.prepare(`
      INSERT INTO episodes (id, content, source, source_reliability, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('ep-y', 'Claim Y content', 'direct-observation', 0.95, new Date().toISOString());

    audrey.db.prepare(`
      INSERT INTO contradictions (id, claim_a_id, claim_a_type, claim_b_id, claim_b_type,
        state, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run('con-test', 'sem-x', 'semantic', 'ep-y', 'episodic', new Date().toISOString());

    const result = await audrey.resolveTruth('con-test');
    expect(result.resolution).toBe('context_dependent');
    expect(result.conditions).toBeDefined();
    expect(result.explanation).toBe('Both valid in different seasons');

    const row = audrey.db.prepare('SELECT state FROM contradictions WHERE id = ?').get('con-test');
    expect(row.state).toBe('context_dependent');
  });

  it('throws without LLM configured', async () => {
    const noLlm = new Audrey({
      dataDir: TEST_DIR + '-nollm',
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });

    try {
      await expect(noLlm.resolveTruth('any-id')).rejects.toThrow('resolveTruth requires an LLM provider');
    } finally {
      noLlm.close();
      if (existsSync(TEST_DIR + '-nollm')) rmSync(TEST_DIR + '-nollm', { recursive: true });
    }
  });

  it('throws for nonexistent contradiction', async () => {
    await expect(audrey.resolveTruth('nonexistent-id')).rejects.toThrow('Contradiction not found');
  });
});
