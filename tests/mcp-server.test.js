import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { Audrey } from '../dist/src/index.js';
import { readStoredDimensions } from '../dist/src/db.js';
import { buildAudreyConfig, buildInstallArgs, DEFAULT_DATA_DIR, MCP_ENTRYPOINT, SERVER_NAME, VERSION } from '../dist/mcp-server/config.js';
import {
  MAX_MEMORY_CONTENT_LENGTH,
  buildStatusReport,
  formatStatusReport,
  initializeEmbeddingProvider,
  memoryEncodeToolSchema,
  memoryForgetToolSchema,
  memoryImportToolSchema,
  memoryRecallToolSchema,
  registerShutdownHandlers,
  registerDreamTool,
  runStatusCommand,
  validateForgetSelection,
} from '../dist/mcp-server/index.js';
import { existsSync, rmSync } from 'node:fs';

const TEST_DIR = './test-mcp-server';

describe('MCP config', () => {
  it('VERSION is 0.19.0', () => {
    expect(VERSION).toBe('0.19.0');
  });
});

describe('MCP CLI: buildAudreyConfig', () => {
  const envBackup = {};
  const envKeys = [
    'AUDREY_DATA_DIR', 'AUDREY_AGENT', 'AUDREY_EMBEDDING_PROVIDER',
    'AUDREY_EMBEDDING_DIMENSIONS', 'AUDREY_LLM_PROVIDER',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUDREY_DEVICE',
    'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] !== undefined) process.env[key] = envBackup[key];
      else delete process.env[key];
    }
  });

  it('uses defaults when no env vars set', () => {
    const config = buildAudreyConfig();
    expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
    expect(config.agent).toBe('claude-code');
    expect(config.embedding.provider).toBe('local');
    expect(config.embedding.dimensions).toBe(384);
    expect(config.llm).toBeUndefined();
  });

  it('respects AUDREY_DATA_DIR and AUDREY_AGENT', () => {
    process.env.AUDREY_DATA_DIR = '/custom/path';
    process.env.AUDREY_AGENT = 'my-agent';
    const config = buildAudreyConfig();
    expect(config.dataDir).toBe('/custom/path');
    expect(config.agent).toBe('my-agent');
  });

  it('configures openai embeddings with API key', () => {
    process.env.AUDREY_EMBEDDING_PROVIDER = 'openai';
    process.env.AUDREY_EMBEDDING_DIMENSIONS = '1536';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const config = buildAudreyConfig();
    expect(config.embedding.provider).toBe('openai');
    expect(config.embedding.dimensions).toBe(1536);
    expect(config.embedding.apiKey).toBe('sk-test-key');
  });

  it('configures anthropic LLM provider', () => {
    process.env.AUDREY_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = buildAudreyConfig();
    expect(config.llm.provider).toBe('anthropic');
    expect(config.llm.apiKey).toBe('sk-ant-test');
  });

  it('configures mock LLM provider', () => {
    process.env.AUDREY_LLM_PROVIDER = 'mock';
    const config = buildAudreyConfig();
    expect(config.llm.provider).toBe('mock');
  });

  it('auto-detects OpenAI LLM when only OPENAI_API_KEY is present', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const config = buildAudreyConfig();
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.apiKey).toBe('sk-openai-test');
  });

  it('does not set LLM when provider is not specified and no keys are present', () => {
    const config = buildAudreyConfig();
    expect(config.llm).toBeUndefined();
  });

  it('reads AUDREY_DEVICE env var', () => {
    process.env.AUDREY_DEVICE = 'cpu';
    const config = buildAudreyConfig();
    expect(config.embedding.device).toBe('cpu');
  });

  it('defaults device to gpu when not set', () => {
    const config = buildAudreyConfig();
    expect(config.embedding.device).toBe('gpu');
  });

  it('passes device only for local provider', () => {
    process.env.AUDREY_EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    const config = buildAudreyConfig();
    expect(config.embedding.device).toBeUndefined();
  });
});

describe('MCP CLI: buildInstallArgs', () => {
  it('pins the installed command and persists the default local embedding config', () => {
    const args = buildInstallArgs({});
    expect(args).toContain(SERVER_NAME);
    const dashDashIdx = args.indexOf('--');
    expect(args[dashDashIdx + 1]).toBe(process.execPath);
    expect(args[dashDashIdx + 2]).toBe(MCP_ENTRYPOINT);
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    // Local is the default, so the install args should persist local embedding config without API keys.
    expect(envPairsStr).toContain(`AUDREY_DATA_DIR=${DEFAULT_DATA_DIR}`);
    expect(envPairsStr).toContain('AUDREY_EMBEDDING_PROVIDER=local');
    expect(envPairsStr).toContain('AUDREY_DEVICE=gpu');
    expect(envPairsStr).not.toContain('OPENAI_API_KEY');
  });

  it('respects an explicit local embedding choice even when Gemini keys are present', () => {
    const args = buildInstallArgs({
      AUDREY_EMBEDDING_PROVIDER: 'local',
      AUDREY_DEVICE: 'cpu',
      GOOGLE_API_KEY: 'google-test',
    });
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    expect(envPairsStr).toContain('AUDREY_EMBEDDING_PROVIDER=local');
    expect(envPairsStr).toContain('AUDREY_DEVICE=cpu');
    expect(envPairsStr).not.toContain('GOOGLE_API_KEY=google-test');
  });

  it('detects ANTHROPIC_API_KEY and enables LLM provider', () => {
    const args = buildInstallArgs({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    expect(envPairsStr).toContain('AUDREY_LLM_PROVIDER=anthropic');
    expect(envPairsStr).toContain('ANTHROPIC_API_KEY=sk-ant-test');
  });

  it('persists a custom data directory', () => {
    const args = buildInstallArgs({ AUDREY_DATA_DIR: '/custom/audrey' });
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    expect(envPairsStr).toContain('AUDREY_DATA_DIR=/custom/audrey');
  });

  it('persists explicit OpenAI LLM config when selected', () => {
    const args = buildInstallArgs({
      AUDREY_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-openai-test',
    });
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    expect(envPairsStr).toContain('AUDREY_LLM_PROVIDER=openai');
    expect(envPairsStr).toContain('OPENAI_API_KEY=sk-openai-test');
  });

  it('places server name before -e flags to avoid variadic parsing bug', () => {
    const args = buildInstallArgs({ OPENAI_API_KEY: 'sk-test' });
    const nameIdx = args.indexOf(SERVER_NAME);
    const firstEnvIdx = args.indexOf('-e');
    expect(nameIdx).toBeLessThan(firstEnvIdx);
  });
});

describe('MCP validation hardening', () => {
  it('memory_encode rejects empty or whitespace-only content', () => {
    const schema = z.object(memoryEncodeToolSchema);
    expect(schema.safeParse({
      content: '',
      source: 'direct-observation',
    }).success).toBe(false);
    expect(schema.safeParse({
      content: '   ',
      source: 'direct-observation',
    }).success).toBe(false);
  });

  it('memory_encode rejects content above the maximum length', () => {
    const schema = z.object(memoryEncodeToolSchema);
    const content = 'x'.repeat(MAX_MEMORY_CONTENT_LENGTH + 1);
    expect(schema.safeParse({
      content,
      source: 'direct-observation',
    }).success).toBe(false);
  });

  it('memory_recall enforces limit bounds', () => {
    const schema = z.object(memoryRecallToolSchema);
    expect(schema.safeParse({ query: 'test', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: 'test', limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ query: 'test', limit: 50 }).success).toBe(true);
  });

  it('memory_import accepts consolidationMetrics snapshots', () => {
    const schema = z.object(memoryImportToolSchema);
    expect(schema.safeParse({
      snapshot: {
        version: '0.15.0',
        episodes: [],
        consolidationMetrics: [{ id: 'metric-1' }],
      },
    }).success).toBe(true);
  });

  it('memory_forget rejects both id and query together', () => {
    expect(() => validateForgetSelection('ep-1', 'query')).toThrow('Provide exactly one of id or query');
  });

  it('initializes async embedding providers for the dream CLI path', async () => {
    const provider = { ready: vi.fn().mockResolvedValue(undefined) };
    await initializeEmbeddingProvider(provider);
    expect(provider.ready).toHaveBeenCalledOnce();
  });

  it('does nothing for providers without async initialization', async () => {
    await expect(initializeEmbeddingProvider({})).resolves.toBeUndefined();
  });

  it('exports memory_forget schema fields', () => {
    expect(Object.keys(memoryForgetToolSchema)).toEqual([
      'id',
      'query',
      'min_similarity',
      'purge',
    ]);
  });
});

describe('MCP lifecycle hardening', () => {
  it('closes Audrey on SIGTERM and exits cleanly', () => {
    const fakeProcess = new EventEmitter();
    fakeProcess.exit = vi.fn();
    const audrey = { close: vi.fn() };

    registerShutdownHandlers(fakeProcess, audrey, vi.fn());
    fakeProcess.emit('SIGTERM');

    expect(audrey.close).toHaveBeenCalledOnce();
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero on unhandled rejections', () => {
    const fakeProcess = new EventEmitter();
    fakeProcess.exit = vi.fn();
    const audrey = { close: vi.fn() };
    const logger = vi.fn();

    registerShutdownHandlers(fakeProcess, audrey, logger);
    fakeProcess.emit('unhandledRejection', new Error('boom'));

    expect(audrey.close).toHaveBeenCalledOnce();
    expect(fakeProcess.exit).toHaveBeenCalledWith(1);
    expect(logger).toHaveBeenCalled();
  });
});

describe('MCP status automation', () => {
  afterEach(() => {
    process.exitCode = undefined;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('builds a machine-readable report when no data directory exists yet', () => {
    const report = buildStatusReport({
      dataDir: './missing-audrey-dir',
      claudeJsonPath: './missing-claude-config.json',
    });

    expect(report.registered).toBe(false);
    expect(report.exists).toBe(false);
    expect(report.stats).toBeNull();
    expect(report.health).toBeNull();
    expect(report.error).toBeNull();
  });

  it('formats the missing-directory case for humans', () => {
    const text = formatStatusReport({
      registered: false,
      dataDir: './missing-audrey-dir',
      exists: false,
    });

    expect(text).toContain('Registration: not registered');
    expect(text).toContain('not yet created');
  });

  it('emits JSON and exits non-zero when fail-on-unhealthy is set', async () => {
    const audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'status-json-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await audrey.encode({ content: 'health drift episode', source: 'direct-observation' });
    audrey.db.exec('DELETE FROM vec_episodes');
    audrey.db.prepare(
      "UPDATE audrey_config SET value = ? WHERE key = 'dimensions'"
    ).run('16');
    audrey.close();

    const lines = [];
    const { report, exitCode } = runStatusCommand({
      argv: ['node', 'mcp-server/index.js', 'status', '--json', '--fail-on-unhealthy'],
      dataDir: TEST_DIR,
      claudeJsonPath: './missing-claude-config.json',
      out: line => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(report.health.healthy).toBe(false);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.health.healthy).toBe(false);
    expect(parsed.health.reembed_recommended).toBe(true);
  });
});

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

describe('MCP tool: memory_dream', () => {
  it('exists and calls audrey.dream with translated options', async () => {
    const registeredTools = new Map();
    const server = {
      tool(name, schema, handler) {
        registeredTools.set(name, { schema, handler });
      },
    };
    const dreamResult = {
      consolidation: {
        runId: 'run-1',
        episodesEvaluated: 3,
        clustersFound: 1,
        principlesExtracted: 1,
        semanticsCreated: 1,
        proceduresCreated: 0,
        status: 'completed',
      },
      decay: {
        totalEvaluated: 4,
        transitionedToDormant: 1,
        timestamp: '2026-03-07T00:00:00.000Z',
      },
      stats: {
        episodic: 3,
        semantic: 1,
        procedural: 0,
        causalLinks: 0,
        dormant: 1,
        contradictions: { open: 0, resolved: 0, context_dependent: 0, reopened: 0 },
        lastConsolidation: null,
        totalConsolidationRuns: 1,
      },
    };
    const audrey = {
      dream: vi.fn().mockResolvedValue(dreamResult),
    };

    registerDreamTool(server, audrey);

    const dreamTool = registeredTools.get('memory_dream');
    expect(dreamTool).toBeDefined();
    expect(Object.keys(dreamTool.schema)).toEqual([
      'min_cluster_size',
      'similarity_threshold',
      'dormant_threshold',
    ]);

    const rawResult = await dreamTool.handler({
      min_cluster_size: 3,
      similarity_threshold: 0.99,
      dormant_threshold: 0.1,
    });

    expect(audrey.dream).toHaveBeenCalledWith({
      minClusterSize: 3,
      similarityThreshold: 0.99,
      dormantThreshold: 0.1,
    });
    expect(rawResult.isError).not.toBe(true);
    expect(JSON.parse(rawResult.content[0].text)).toEqual(dreamResult);
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

describe('MCP tool: memory_recall filters', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'Debug log from server', source: 'direct-observation', tags: ['debug', 'server'] });
    await audrey.encode({ content: 'User likes dark mode', source: 'told-by-user', tags: ['prefs'] });
    await audrey.encode({ content: 'API returned 500', source: 'tool-result', tags: ['debug', 'api'] });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('filters by tags', async () => {
    const results = await audrey.recall('debug', { tags: ['debug'], types: ['episodic'] });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.content).toMatch(/Debug|API/);
    }
  });

  it('filters by sources', async () => {
    const results = await audrey.recall('observation', { sources: ['told-by-user'], types: ['episodic'] });
    for (const r of results) {
      expect(r.source).toBe('told-by-user');
    }
  });

  it('filters by after date', async () => {
    const longAgo = '2000-01-01T00:00:00.000Z';
    const results = await audrey.recall('debug', { after: longAgo, types: ['episodic'] });
    expect(results.length).toBeGreaterThan(0);
  });

  it('filters by before date excludes future', async () => {
    const longAgo = '2000-01-01T00:00:00.000Z';
    const results = await audrey.recall('debug', { before: longAgo, types: ['episodic'] });
    expect(results.length).toBe(0);
  });
});

describe('MCP tool: memory_export + memory_import', () => {
  let audrey;
  const EXPORT_DIR = './test-mcp-export';
  const IMPORT_DIR = './test-mcp-import';

  beforeEach(async () => {
    if (existsSync(EXPORT_DIR)) rmSync(EXPORT_DIR, { recursive: true });
    if (existsSync(IMPORT_DIR)) rmSync(IMPORT_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: EXPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'MCP export test', source: 'told-by-user' });
  });

  afterEach(() => {
    audrey?.close();
    if (existsSync(EXPORT_DIR)) rmSync(EXPORT_DIR, { recursive: true });
    if (existsSync(IMPORT_DIR)) rmSync(IMPORT_DIR, { recursive: true });
  });

  it('round-trips through export and import', async () => {
    const snapshot = audrey.export();
    expect(snapshot.episodes.length).toBe(1);

    const dest = new Audrey({
      dataDir: IMPORT_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await dest.import(snapshot);
    const stats = dest.introspect();
    expect(stats.episodic).toBe(1);
    dest.close();
  });
});

describe('MCP tool: context parameters', () => {
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

  it('memory_encode accepts context parameter', async () => {
    const id = await audrey.encode({
      content: 'mcp context test',
      source: 'direct-observation',
      context: { task: 'mcp-testing' },
    });
    expect(typeof id).toBe('string');
    const row = audrey.db.prepare('SELECT context FROM episodes WHERE id = ?').get(id);
    expect(JSON.parse(row.context)).toEqual({ task: 'mcp-testing' });
  });

  it('memory_recall accepts context parameter', async () => {
    await audrey.encode({
      content: 'mcp recall context test',
      source: 'direct-observation',
      context: { task: 'mcp-testing' },
    });
    const results = await audrey.recall('mcp recall context test', {
      types: ['episodic'],
      context: { task: 'mcp-testing' },
    });
    expect(results.length).toBeGreaterThan(0);
    const match = results.find(r => r.content === 'mcp recall context test');
    expect(match).toBeDefined();
    expect(match.contextMatch).toBe(1.0);
  });
});

describe('MCP tool: memory_forget + memory_decay', () => {
  let audrey;
  const TOOL_DIR = './test-mcp-forget';

  beforeEach(async () => {
    if (existsSync(TOOL_DIR)) rmSync(TOOL_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TOOL_DIR,
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey?.close();
    if (existsSync(TOOL_DIR)) rmSync(TOOL_DIR, { recursive: true });
  });

  it('forgets a memory by ID via SDK', async () => {
    const id = await audrey.encode({ content: 'MCP forget test', source: 'direct-observation' });
    const result = audrey.forget(id);
    expect(result.type).toBe('episodic');
    expect(result.purged).toBe(false);

    const results = await audrey.recall('MCP forget test', { types: ['episodic'] });
    expect(results.find(r => r.id === id)).toBeUndefined();
  });

  it('forgets by query via SDK', async () => {
    await audrey.encode({ content: 'Forget by query MCP', source: 'told-by-user' });
    const result = await audrey.forgetByQuery('forget by query MCP', { minSimilarity: 0.5 });
    expect(result).not.toBeNull();
    expect(result.type).toBe('episodic');
  });

  it('decay runs via SDK', () => {
    const result = audrey.decay();
    expect(result).toHaveProperty('totalEvaluated');
    expect(result).toHaveProperty('transitionedToDormant');
    expect(result).toHaveProperty('timestamp');
  });

  it('purge runs via SDK', async () => {
    const id = await audrey.encode({ content: 'Purge MCP test', source: 'direct-observation' });
    audrey.forget(id);
    const result = audrey.purge();
    expect(result.episodes).toBe(1);

    const ep = audrey.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    expect(ep).toBeUndefined();
  });
});

describe('MCP tool: memory_status', () => {
  let audrey;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'mcp-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    await audrey.encode({ content: 'status test memory', source: 'direct-observation' });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns health status with matching counts', () => {
    const status = audrey.memoryStatus();
    expect(status.episodes).toBe(1);
    expect(status.vec_episodes).toBe(1);
    expect(status.semantics).toBe(0);
    expect(status.vec_semantics).toBe(0);
    expect(status.procedures).toBe(0);
    expect(status.vec_procedures).toBe(0);
    expect(status.dimensions).toBe(8);
    expect(status.schema_version).toBe(7);
    expect(status.healthy).toBe(true);
  });

  it('reports unhealthy when vec counts diverge', () => {
    audrey.db.exec('DELETE FROM vec_episodes');
    const status = audrey.memoryStatus();
    expect(status.episodes).toBe(1);
    expect(status.vec_episodes).toBe(0);
    expect(status.healthy).toBe(false);
  });
});


