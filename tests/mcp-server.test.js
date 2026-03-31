import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Audrey } from '../src/index.js';
import { readStoredDimensions } from '../src/db.js';
import {
  buildAudreyConfig,
  buildInitEnv,
  buildInstallArgs,
  DEFAULT_DATA_DIR,
  listInitPresets,
  MCP_ENTRYPOINT,
  SERVER_NAME,
  VERSION,
} from '../mcp-server/config.js';
import {
  MAX_MEMORY_CONTENT_LENGTH,
  buildHooksConfig,
  buildStatusReport,
  formatStatusReport,
  initializeEmbeddingProvider,
  memoryEncodeToolSchema,
  memoryForgetToolSchema,
  memoryImportToolSchema,
  memoryRecallToolSchema,
  registerShutdownHandlers,
  registerDreamTool,
  resolveInitProfilePath,
  resolveSnapshotPath,
  runInitCommand,
  runStatusCommand,
  validateForgetSelection,
} from '../mcp-server/index.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const TEST_DIR = './test-mcp-server';
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

describe('MCP config', () => {
  it('VERSION matches package.json', () => {
    expect(VERSION).toBe(PACKAGE_VERSION);
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

describe('MCP CLI: init presets', () => {
  const envBackup = {};
  const envKeys = [
    'AUDREY_DATA_DIR', 'AUDREY_AGENT', 'AUDREY_EMBEDDING_PROVIDER',
    'AUDREY_LLM_PROVIDER', 'AUDREY_DEVICE', 'GOOGLE_API_KEY',
    'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'AUDREY_HOST', 'AUDREY_PORT', 'AUDREY_API_KEY',
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

  it('lists the supported init presets', () => {
    expect(listInitPresets().map(p => p.name)).toEqual([
      'local-offline',
      'hosted-fast',
      'ci-mock',
      'sidecar-prod',
    ]);
  });

  it('builds a local-offline init env without hosted providers', () => {
    const initEnv = buildInitEnv({
      GOOGLE_API_KEY: 'google-test',
      ANTHROPIC_API_KEY: 'anthropic-test',
      AUDREY_DEVICE: 'cpu',
    }, 'local-offline');

    expect(initEnv.AUDREY_EMBEDDING_PROVIDER).toBe('local');
    expect(initEnv.AUDREY_DEVICE).toBe('cpu');
    expect(initEnv.GOOGLE_API_KEY).toBeUndefined();
    expect(initEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(initEnv.AUDREY_AGENT).toBe('claude-code');
  });

  it('builds a hosted-fast env using detected hosted providers', () => {
    const initEnv = buildInitEnv({
      GOOGLE_API_KEY: 'google-test',
      ANTHROPIC_API_KEY: 'anthropic-test',
    }, 'hosted-fast');

    expect(initEnv.AUDREY_EMBEDDING_PROVIDER).toBe('gemini');
    expect(initEnv.AUDREY_LLM_PROVIDER).toBe('anthropic');
    expect(initEnv.AUDREY_AGENT).toBe('claude-code');
  });

  it('builds a ci-mock env with mock providers', () => {
    const initEnv = buildInitEnv({
      OPENAI_API_KEY: 'openai-test',
      ANTHROPIC_API_KEY: 'anthropic-test',
    }, 'ci-mock');

    expect(initEnv.AUDREY_EMBEDDING_PROVIDER).toBe('mock');
    expect(initEnv.AUDREY_LLM_PROVIDER).toBe('mock');
    expect(initEnv.OPENAI_API_KEY).toBeUndefined();
    expect(initEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(initEnv.AUDREY_AGENT).toBe('audrey-ci');
  });

  it('builds a sidecar-prod env with serving defaults', () => {
    const initEnv = buildInitEnv({}, 'sidecar-prod');

    expect(initEnv.AUDREY_AGENT).toBe('audrey-sidecar');
    expect(initEnv.AUDREY_HOST).toBe('0.0.0.0');
    expect(initEnv.AUDREY_PORT).toBe('3487');
    expect(initEnv.AUDREY_EMBEDDING_PROVIDER).toBe('local');
  });
});

describe('MCP CLI: init command', () => {
  it('resolves the init profile path next to the data directory', () => {
    expect(resolveInitProfilePath('/tmp/audrey/data')).toBe(path.resolve('/tmp/audrey/init-profile.json'));
  });

  it('bootstraps the common Claude path and writes a profile', () => {
    const lines = [];
    const installFn = vi.fn();
    const hooksInstallFn = vi.fn();
    const writeFile = vi.fn();
    const mkdir = vi.fn();
    const execFn = vi.fn();

    const result = runInitCommand({
      argv: ['node', 'mcp-server/index.js', 'init', 'local-offline'],
      env: { AUDREY_DATA_DIR: '/tmp/audrey-data', AUDREY_DEVICE: 'cpu' },
      out: line => lines.push(line),
      installFn,
      hooksInstallFn,
      execFn,
      writeFile,
      mkdir,
    });

    expect(result.preset).toBe('local-offline');
    expect(result.installedMcp).toBe(true);
    expect(result.installedHooks).toBe(true);
    expect(installFn).toHaveBeenCalledOnce();
    expect(hooksInstallFn).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(mkdir).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Init preset: local-offline');
    expect(lines.join('\n')).toContain('npx audrey doctor');

    const profile = JSON.parse(writeFile.mock.calls[0][1]);
    expect(profile.preset).toBe('local-offline');
    expect(profile.embedding.provider).toBe('local');
    expect(profile.hooksInstalled).toBe(true);
  });

  it('supports dry runs without side effects', () => {
    const installFn = vi.fn();
    const hooksInstallFn = vi.fn();
    const writeFile = vi.fn();
    const mkdir = vi.fn();
    const execFn = vi.fn(() => {
      throw new Error('missing claude');
    });

    const result = runInitCommand({
      argv: ['node', 'mcp-server/index.js', 'init', 'hosted-fast', '--dry-run'],
      env: { AUDREY_DATA_DIR: '/tmp/audrey-data' },
      installFn,
      hooksInstallFn,
      execFn,
      writeFile,
      mkdir,
    });

    expect(result.dryRun).toBe(true);
    expect(result.installedMcp).toBe(false);
    expect(installFn).not.toHaveBeenCalled();
    expect(hooksInstallFn).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('skips hooks when requested', () => {
    const hooksInstallFn = vi.fn();

    const result = runInitCommand({
      argv: ['node', 'mcp-server/index.js', 'init', 'local-offline', '--no-hooks'],
      env: { AUDREY_DATA_DIR: '/tmp/audrey-data' },
      installFn: vi.fn(),
      hooksInstallFn,
      execFn: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    });

    expect(result.installedHooks).toBe(false);
    expect(hooksInstallFn).not.toHaveBeenCalled();
  });

  it('does not attempt Claude registration for sidecar-prod', () => {
    const installFn = vi.fn();

    const result = runInitCommand({
      argv: ['node', 'mcp-server/index.js', 'init', 'sidecar-prod'],
      env: { AUDREY_DATA_DIR: '/tmp/audrey-data' },
      installFn,
      hooksInstallFn: vi.fn(),
      execFn: vi.fn(() => {
        throw new Error('missing claude');
      }),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    });

    expect(result.installedMcp).toBe(false);
    expect(result.profile.surface).toBe('sidecar');
    expect(installFn).not.toHaveBeenCalled();
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

  it('waits for pending Audrey work before exiting when waitForIdle is available', async () => {
    const fakeProcess = new EventEmitter();
    fakeProcess.exit = vi.fn();

    let releaseIdle;
    const idle = new Promise(resolve => {
      releaseIdle = resolve;
    });
    const audrey = {
      waitForIdle: vi.fn(() => idle),
      close: vi.fn(),
    };

    registerShutdownHandlers(fakeProcess, audrey, vi.fn());
    fakeProcess.emit('SIGTERM');

    expect(audrey.waitForIdle).toHaveBeenCalledOnce();
    expect(audrey.close).not.toHaveBeenCalled();
    expect(fakeProcess.exit).not.toHaveBeenCalled();

    releaseIdle();
    await idle;
    await new Promise(resolve => setImmediate(resolve));

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
    expect(status.schema_version).toBe(10);
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

describe('buildHooksConfig', () => {
  it('returns hook entries for all four lifecycle events', () => {
    const config = buildHooksConfig();
    expect(config).toHaveProperty('SessionStart');
    expect(config).toHaveProperty('UserPromptSubmit');
    expect(config).toHaveProperty('Stop');
    expect(config).toHaveProperty('PostCompact');
  });

  it('SessionStart matcher targets startup and resume', () => {
    const config = buildHooksConfig();
    expect(config.SessionStart[0].matcher).toBe('startup|resume');
    expect(config.SessionStart[0].hooks[0].command).toContain('audrey greeting');
  });

  it('UserPromptSubmit uses recall command', () => {
    const config = buildHooksConfig();
    expect(config.UserPromptSubmit[0].hooks[0].command).toContain('audrey recall');
  });

  it('Stop uses reflect command', () => {
    const config = buildHooksConfig();
    expect(config.Stop[0].hooks[0].command).toContain('audrey reflect');
  });

  it('PostCompact re-injects with greeting', () => {
    const config = buildHooksConfig();
    expect(config.PostCompact[0].hooks[0].command).toContain('audrey greeting');
  });

  it('all hooks have type command', () => {
    const config = buildHooksConfig();
    for (const entries of Object.values(config)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.type).toBe('command');
        }
      }
    }
  });

  it('all hooks have timeout values', () => {
    const config = buildHooksConfig();
    for (const entries of Object.values(config)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(typeof hook.timeout).toBe('number');
          expect(hook.timeout).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('resolveSnapshotPath', () => {
  it('uses explicit output path when provided', () => {
    const result = resolveSnapshotPath('/tmp/my-snapshot.json', '/data');
    // On Windows, resolve() prepends the drive letter (e.g. D:\tmp\...)
    expect(result).toMatch(/my-snapshot\.json$/);
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('generates timestamped filename when no output arg given', () => {
    const result = resolveSnapshotPath(undefined, '/home/user/.audrey/data');
    expect(result).toMatch(/audrey-snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/);
    // Should be in parent of dataDir (i.e., ~/.audrey/)
    expect(result).toContain(path.join('user', '.audrey', 'audrey-snapshot-'));
  });

  it('resolves relative output path to absolute', () => {
    const result = resolveSnapshotPath('./snapshots/backup.json', '/data');
    expect(result).toContain(path.join('snapshots', 'backup.json'));
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe('snapshot and restore round-trip', () => {
  const SNAP_DIR = './test-snapshot-roundtrip';
  const SNAP_DIR_2 = './test-snapshot-roundtrip-2';
  let audrey;

  beforeEach(() => {
    rmSync(SNAP_DIR, { recursive: true, force: true });
    rmSync(SNAP_DIR_2, { recursive: true, force: true });
    audrey = new Audrey({
      dataDir: SNAP_DIR,
      agent: 'snap-test',
      embedding: { provider: 'mock', dimensions: 64 },
    });
  });

  afterEach(() => {
    audrey.close();
    rmSync(SNAP_DIR, { recursive: true, force: true });
    rmSync(SNAP_DIR_2, { recursive: true, force: true });
  });

  it('exports a valid snapshot with all fields', async () => {
    await audrey.encode({ content: 'test memory alpha', source: 'direct-observation' });
    await audrey.encode({ content: 'test memory beta', source: 'told-by-user' });

    const snapshot = audrey.export();
    expect(snapshot.version).toBe(PACKAGE_VERSION);
    expect(snapshot.exportedAt).toBeTruthy();
    expect(snapshot.episodes).toHaveLength(2);
    expect(snapshot.episodes[0].content).toBe('test memory alpha');
    expect(snapshot).toHaveProperty('semantics');
    expect(snapshot).toHaveProperty('procedures');
    expect(snapshot).toHaveProperty('causalLinks');
    expect(snapshot).toHaveProperty('contradictions');
    expect(snapshot).toHaveProperty('config');
  });

  it('round-trips memories through export and import into a fresh db', async () => {
    await audrey.encode({ content: 'payment failed at gateway', source: 'direct-observation', tags: ['payments'] });
    await audrey.encode({ content: 'retry with exponential backoff', source: 'told-by-user' });

    const snapshot = audrey.export();
    audrey.close();

    // Import into a fresh database
    const audrey2 = new Audrey({
      dataDir: SNAP_DIR_2,
      agent: 'snap-test-2',
      embedding: { provider: 'mock', dimensions: 64 },
    });

    await audrey2.import(snapshot);
    const stats = audrey2.introspect();
    expect(stats.episodic).toBe(2);

    const results = await audrey2.recall('payment retry', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    audrey2.close();
    // Re-assign so afterEach cleanup works
    audrey = new Audrey({
      dataDir: SNAP_DIR,
      agent: 'snap-test',
      embedding: { provider: 'mock', dimensions: 64 },
    });
  });

  it('snapshot JSON is git-friendly (valid JSON, human-readable)', async () => {
    await audrey.encode({ content: 'this is diffable', source: 'direct-observation' });

    const snapshot = audrey.export();
    const json = JSON.stringify(snapshot, null, 2);

    // Valid JSON
    expect(() => JSON.parse(json)).not.toThrow();

    // Human-readable (contains newlines, indentation)
    expect(json).toContain('\n');
    expect(json).toContain('  ');

    // Contains searchable content
    expect(json).toContain('this is diffable');
  });

  it('preserves tags, source, and metadata through round-trip', async () => {
    await audrey.encode({
      content: 'important fact about auth',
      source: 'told-by-user',
      tags: ['auth', 'security'],
      salience: 0.9,
    });

    const snapshot = audrey.export();
    const ep = snapshot.episodes[0];
    expect(ep.source).toBe('told-by-user');
    expect(ep.tags).toEqual(['auth', 'security']);
    expect(ep.salience).toBe(0.9);
  });
});
