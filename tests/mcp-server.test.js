import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Audrey } from '../dist/src/index.js';
import { readStoredDimensions } from '../dist/src/db.js';
import {
  buildAudreyConfig,
  buildInstallArgs,
  buildStdioMcpServerConfig,
  DEFAULT_AGENT,
  DEFAULT_DATA_DIR,
  formatMcpHostConfig,
  MCP_ENTRYPOINT,
  SERVER_NAME,
  VERSION,
} from '../dist/mcp-server/config.js';
import {
  MAX_MEMORY_CONTENT_LENGTH,
  buildDoctorReport,
  buildStatusReport,
  formatDoctorReport,
  formatInstallGuide,
  formatStatusReport,
  initializeEmbeddingProvider,
  memoryEncodeToolSchema,
  memoryForgetToolSchema,
  memoryValidateToolSchema,
  memoryImportToolSchema,
  memoryGuardAfterToolSchema,
  memoryGuardBeforeToolSchema,
  memoryPreflightToolSchema,
  memoryRecallToolSchema,
  memoryReflexesToolSchema,
  registerHostPrompts,
  registerHostResources,
  registerShutdownHandlers,
  registerDreamTool,
  runDemoCommand,
  runDoctorCommand,
  runStatusCommand,
  validateForgetSelection,
} from '../dist/mcp-server/index.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const TEST_DIR = './test-mcp-server';

describe('MCP config', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});

describe('CLI surface', () => {
  // Spawning the CLI exercises the dispatcher in mcp-server/index.ts. Without these,
  // a future refactor could silently re-introduce the bug where `audrey --help`
  // dropped the user into an MCP stdio server waiting on stdin.
  const cli = resolve('dist/mcp-server/index.js');

  afterEach(() => {
    for (const dir of ['./test-cli-guard', './test-cli-guard-after']) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--help prints help and exits 0', () => {
    const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: audrey');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('demo');
    expect(r.stdout).toContain('guard');
    expect(r.stdout).toContain('guard-after');
  });

  it('--version prints version and exits 0', () => {
    const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`audrey ${VERSION}`);
  });

  it('unknown subcommand exits 2 with help on stderr', () => {
    const r = spawnSync(process.execPath, [cli, 'definitelynotacommand'], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown command 'definitelynotacommand'");
    expect(r.stdout).toContain('Usage: audrey');
  });

  it('guard --json emits a before-action decision', () => {
    const r = spawnSync(
      process.execPath,
      [cli, 'guard', '--json', '--tool', 'Bash', 'list files before editing'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          AUDREY_DATA_DIR: './test-cli-guard',
          AUDREY_EMBEDDING_PROVIDER: 'mock',
        },
      },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.receipt_id).toMatch(/^01/);
    expect(parsed.decision).toBe('go');
    expect(Array.isArray(parsed.evidence_ids)).toBe(true);
  });

  it('guard exits 2 when action is missing', () => {
    const r = spawnSync(process.execPath, [cli, 'guard'], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AUDREY_DATA_DIR: './test-cli-guard',
        AUDREY_EMBEDDING_PROVIDER: 'mock',
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('[audrey] guard: action is required');
  });

  it('guard-after records an action outcome from hook-shaped stdin', () => {
    const env = {
      ...process.env,
      AUDREY_DATA_DIR: './test-cli-guard-after',
      AUDREY_EMBEDDING_PROVIDER: 'mock',
    };
    const before = spawnSync(
      process.execPath,
      [cli, 'guard', '--json', '--tool', 'Bash', 'run a safe command'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env,
      },
    );
    expect(before.status).toBe(0);
    const receipt = JSON.parse(before.stdout);

    const after = spawnSync(
      process.execPath,
      [cli, 'guard-after', '--receipt', receipt.receipt_id],
      {
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          session_id: 'S-cli',
          tool_response: { success: true, stdout: 'ok' },
        }),
        encoding: 'utf8',
        timeout: 10000,
        env,
      },
    );
    expect(after.status).toBe(0);
    const parsed = JSON.parse(after.stdout);
    expect(parsed.receipt_id).toBe(receipt.receipt_id);
    expect(parsed.post_event_id).toMatch(/^01/);
    expect(parsed.outcome).toBe('succeeded');
  });

  it('guard-after exits 2 when receipt is missing', () => {
    const r = spawnSync(process.execPath, [cli, 'guard-after'], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AUDREY_DATA_DIR: './test-cli-guard-after',
        AUDREY_EMBEDDING_PROVIDER: 'mock',
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('[audrey] guard-after: --receipt is required');
  });
});

describe('MCP CLI: buildAudreyConfig', () => {
  const envBackup = {};
  const envKeys = [
    'AUDREY_DATA_DIR', 'AUDREY_AGENT', 'AUDREY_EMBEDDING_PROVIDER',
    'AUDREY_EMBEDDING_DIMENSIONS', 'AUDREY_LLM_PROVIDER',
    'AUDREY_ENABLE_ADMIN_TOOLS',
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
    expect(config.agent).toBe(DEFAULT_AGENT);
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

  it('does not include auto-detected LLM provider secrets by default', () => {
    const args = buildInstallArgs({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    expect(envPairsStr).not.toContain('AUDREY_LLM_PROVIDER=anthropic');
    expect(envPairsStr).not.toContain('ANTHROPIC_API_KEY=sk-ant-test');
  });

  it('includes provider secrets only when explicitly requested', () => {
    const args = buildInstallArgs({ ANTHROPIC_API_KEY: 'sk-ant-test' }, { includeSecrets: true });
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
    expect(envPairsStr).not.toContain('OPENAI_API_KEY=sk-openai-test');
  });

  it('places server name before -e flags to avoid variadic parsing bug', () => {
    const args = buildInstallArgs({ OPENAI_API_KEY: 'sk-test' });
    const nameIdx = args.indexOf(SERVER_NAME);
    const firstEnvIdx = args.indexOf('-e');
    expect(nameIdx).toBeLessThan(firstEnvIdx);
  });

  it('keeps claude-code as the agent name for the Claude CLI installer', () => {
    const args = buildInstallArgs({});
    const envPairsStr = args.filter((_, i) => args[i - 1] === '-e').join(' ');
    expect(envPairsStr).toContain('AUDREY_AGENT=claude-code');
  });
});

describe('MCP CLI: host-neutral config output', () => {
  it('builds a generic stdio config with the local-agent default', () => {
    const config = buildStdioMcpServerConfig({});
    expect(config.command).toBe(process.execPath);
    expect(config.args).toEqual([MCP_ENTRYPOINT]);
    expect(config.env.AUDREY_AGENT).toBe(DEFAULT_AGENT);
    expect(config.env.AUDREY_EMBEDDING_PROVIDER).toBe('local');
  });

  it('formats Codex TOML with a codex agent identity', () => {
    const text = formatMcpHostConfig('codex', {});
    expect(text).toContain(`[mcp_servers.${SERVER_NAME}]`);
    expect(text).toContain('AUDREY_AGENT = "codex"');
    expect(text).toContain('AUDREY_EMBEDDING_PROVIDER = "local"');
  });

  it('formats VS Code MCP JSON using the servers envelope', () => {
    const text = formatMcpHostConfig('vscode', {});
    const parsed = JSON.parse(text);
    expect(parsed.servers[SERVER_NAME].type).toBe('stdio');
    expect(parsed.servers[SERVER_NAME].env.AUDREY_AGENT).toBe('vscode-copilot');
  });

  it('does not print provider secrets in generated host configs', () => {
    const text = formatMcpHostConfig('codex', {
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai-secret',
    });
    expect(text).not.toContain('sk-ant-secret');
    expect(text).not.toContain('sk-openai-secret');
    expect(text).not.toContain('ANTHROPIC_API_KEY');
    expect(text).not.toContain('OPENAI_API_KEY');
  });
});

describe('MCP CLI: install guidance', () => {
  it('prints safe Codex setup without mutating host files', () => {
    const text = formatInstallGuide('codex', {}, true);
    expect(text).toContain('No host config files were modified');
    expect(text).toContain(`[mcp_servers.${SERVER_NAME}]`);
    expect(text).toContain('AUDREY_AGENT = "codex"');
    expect(text).toContain('npx audrey doctor');
  });

  it('prints a Claude Code dry-run path before invoking the installer', () => {
    const text = formatInstallGuide('claude-code', {}, true);
    expect(text).toContain('claude-code');
    expect(text).toContain('Run without --dry-run');
    expect(text).toContain('AUDREY_AGENT');
  });
});

describe('MCP CLI: demo command', () => {
  it('prints a self-contained memory demo without external services', async () => {
    const lines = [];
    await runDemoCommand({ out: (...args) => lines.push(args.join(' ')) });
    const output = lines.join('\n');
    expect(output).toContain('Audrey 60-second memory demo');
    expect(output).toContain('Capsule highlights:');
    expect(output).toContain('Recall proof:');
    expect(output).toContain('npx audrey doctor');
    expect(output).toContain('npx audrey mcp-config codex');
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

  it('memory_recall accepts public retrieval modes', () => {
    const schema = z.object(memoryRecallToolSchema);
    expect(schema.safeParse({ query: 'test', retrieval: 'hybrid' }).success).toBe(true);
    expect(schema.safeParse({ query: 'test', retrieval: 'vector' }).success).toBe(true);
    expect(schema.safeParse({ query: 'test', retrieval: 'keyword' }).success).toBe(false);
    expect(schema.safeParse({ query: 'test', retrieval: 'hybrid_strict' }).success).toBe(false);
  });

  it('memory_encode accepts wait_for_consolidation', () => {
    const schema = z.object(memoryEncodeToolSchema);
    expect(schema.safeParse({
      content: 'wait for post encode work',
      source: 'direct-observation',
      wait_for_consolidation: true,
    }).success).toBe(true);
  });

  it('memory_preflight rejects empty actions and accepts strict risk checks', () => {
    const schema = z.object(memoryPreflightToolSchema);
    expect(schema.safeParse({ action: '', tool: 'Bash' }).success).toBe(false);
    expect(schema.safeParse({
      action: 'run npm test',
      tool: 'npm test',
      strict: true,
      failure_window_hours: 24,
      record_event: true,
      include_capsule: false,
    }).success).toBe(true);
  });

  it('memory_guard_before rejects empty actions and accepts preflight-style strict options', () => {
    const schema = z.object(memoryGuardBeforeToolSchema);
    expect(memoryGuardBeforeToolSchema).not.toHaveProperty('record_event');
    expect(schema.safeParse({ action: '', tool: 'Bash' }).success).toBe(false);
    expect(schema.safeParse({
      action: 'run npm test',
      tool: 'npm test',
      session_id: 'session-1',
      cwd: '/tmp/audrey',
      files: ['package.json'],
      strict: true,
      limit: 8,
      budget_chars: 1000,
      mode: 'conservative',
      failure_window_hours: 24,
      include_status: true,
      include_capsule: false,
      scope: 'shared',
    }).success).toBe(true);
  });

  it('memory_guard_after accepts observe-tool outcomes with evidence feedback', () => {
    const schema = z.object(memoryGuardAfterToolSchema);
    expect(schema.safeParse({
      receipt_id: 'receipt-1',
      tool: 'Bash',
      session_id: 'session-1',
      input: { command: 'npm test' },
      output: { exitCode: 0 },
      outcome: 'succeeded',
      error_summary: 'none',
      cwd: '/tmp/audrey',
      files: ['package.json'],
      metadata: { task: 'guard' },
      retain_details: true,
      evidence_feedback: {
        'ep-1': 'used',
        'sem-1': 'helpful',
        'proc-1': 'wrong',
      },
    }).success).toBe(true);
    expect(schema.safeParse({
      receipt_id: 'receipt-1',
      outcome: 'maybe',
    }).success).toBe(false);
  });

  it('memory_reflexes accepts preflight inputs plus include_preflight', () => {
    const schema = z.object(memoryReflexesToolSchema);
    expect(schema.safeParse({ action: '', tool: 'Bash' }).success).toBe(false);
    expect(schema.safeParse({
      action: 'deploy Audrey',
      tool: 'deploy',
      strict: true,
      include_preflight: true,
      include_capsule: false,
    }).success).toBe(true);
  });

  it('memory_import accepts consolidationMetrics snapshots', () => {
    const schema = z.object(memoryImportToolSchema);
    expect(schema.safeParse({
      snapshot: {
        version: '0.15.0',
        episodes: [],
        consolidationMetrics: [{
          id: 'metric-1',
          run_id: 'run-1',
          min_cluster_size: 2,
          similarity_threshold: 0.7,
          episodes_evaluated: 4,
          clusters_found: 1,
          principles_extracted: 1,
          created_at: '2026-04-30T00:00:00.000Z',
        }],
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

  it('memory_validate accepts the closed-loop outcome enum', () => {
    const schema = z.object(memoryValidateToolSchema);
    expect(schema.safeParse({ id: 'mem_1', outcome: 'helpful' }).success).toBe(true);
    expect(schema.safeParse({ id: 'mem_1', outcome: 'used' }).success).toBe(true);
    expect(schema.safeParse({ id: 'mem_1', outcome: 'wrong' }).success).toBe(true);
    expect(schema.safeParse({ id: 'mem_1', outcome: 'maybe' }).success).toBe(false);
    expect(schema.safeParse({ outcome: 'helpful' }).success).toBe(false);  // id required
  });
});

describe('MCP host resources and prompts', () => {
  it('registers host-readable status, recent, and principles resources', async () => {
    const resources = [];
    const server = {
      registerResource: vi.fn((name, uri, metadata, callback) => {
        resources.push({ name, uri, metadata, callback });
      }),
    };
    const audrey = {
      memoryStatus: vi.fn(() => ({ healthy: true })),
      introspect: vi.fn(() => ({ episodes: 2 })),
      greeting: vi.fn(async ({ recentLimit, principleLimit, identityLimit, scope }) => ({
        recent: recentLimit ? [{ id: 'ep-1', content: 'recent memory' }] : [],
        principles: principleLimit ? [{ id: 'sem-1', content: 'ship with proof' }] : [],
        identity: identityLimit ? [{ id: 'id-1', content: 'agent identity' }] : [],
        unresolved: [],
        mood: { valence: 0, arousal: 0, samples: 0 },
        scope,
      })),
    };

    registerHostResources(server, audrey);

    expect(resources.map(resource => resource.uri)).toEqual([
      'audrey://status',
      'audrey://recent',
      'audrey://principles',
    ]);
    const status = await resources[0].callback(new URL('audrey://status'));
    expect(JSON.parse(status.contents[0].text).status.healthy).toBe(true);
    const recent = await resources[1].callback(new URL('audrey://recent'));
    expect(JSON.parse(recent.contents[0].text).recent[0].content).toBe('recent memory');
    expect(audrey.greeting).toHaveBeenCalledWith(expect.objectContaining({ scope: 'agent' }));
  });

  it('registers reusable prompt templates for briefing, recall, and reflection', () => {
    const prompts = [];
    const server = {
      registerPrompt: vi.fn((name, config, callback) => {
        prompts.push({ name, config, callback });
      }),
    };

    registerHostPrompts(server);

    expect(prompts.map(prompt => prompt.name)).toEqual([
      'audrey-session-briefing',
      'audrey-memory-recall',
      'audrey-memory-reflection',
    ]);
    const briefing = prompts[0].callback({ context: 'release pass', scope: 'agent' });
    expect(briefing.messages[0].content.text).toContain('memory_greeting');
    expect(briefing.messages[0].content.text).toContain('scope=agent');
    const recall = prompts[1].callback({ query: 'spawn EPERM', scope: 'agent' });
    expect(recall.messages[0].content.text).toContain('memory_recall');
    expect(recall.messages[0].content.text).toContain('spawn EPERM');
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

  it('drains Audrey post-encode queue before closing on shutdown', async () => {
    const fakeProcess = new EventEmitter();
    fakeProcess.exit = vi.fn();
    const audrey = {
      drainPostEncodeQueue: vi.fn().mockResolvedValue({ drained: true, pendingIds: [] }),
      close: vi.fn(),
    };

    registerShutdownHandlers(fakeProcess, audrey, vi.fn());
    fakeProcess.emit('SIGTERM');
    await Promise.resolve();

    expect(audrey.drainPostEncodeQueue).toHaveBeenCalledWith(5000);
    expect(audrey.close).toHaveBeenCalledOnce();
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
  });

  it('logs pending row ids when post-encode queue does not drain before shutdown timeout', async () => {
    const fakeProcess = new EventEmitter();
    fakeProcess.exit = vi.fn();
    const audrey = {
      drainPostEncodeQueue: vi.fn().mockResolvedValue({ drained: false, pendingIds: ['ep-a', 'ep-b'] }),
      close: vi.fn(),
    };
    const logger = vi.fn();

    registerShutdownHandlers(fakeProcess, audrey, logger);
    fakeProcess.emit('SIGTERM');
    await Promise.resolve();

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('ep-a, ep-b'));
    expect(audrey.close).toHaveBeenCalledOnce();
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
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

describe('MCP doctor automation', () => {
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('builds a ready report for first-run installs without an existing store', () => {
    const report = buildDoctorReport({
      dataDir: './missing-audrey-dir',
      claudeJsonPath: './missing-claude-config.json',
      env: {},
      nodeVersion: '20.0.0',
    });

    expect(report.version).toBe(VERSION);
    expect(report.entrypoint).toBe(MCP_ENTRYPOINT);
    expect(report.ok).toBe(true);
    expect(report.status.exists).toBe(false);
    expect(report.checks.some(check => check.name === 'host-config-generation' && check.ok)).toBe(true);
  });

  it('formats doctor output with a clear verdict and next steps', () => {
    const report = buildDoctorReport({
      dataDir: './missing-audrey-dir',
      claudeJsonPath: './missing-claude-config.json',
      env: {},
      nodeVersion: '20.0.0',
    });
    const text = formatDoctorReport(report);

    expect(text).toContain('Audrey Doctor');
    expect(text).toContain('Store health: not initialized');
    expect(text).toContain('Verdict: ready');
    expect(text).toContain('npx audrey install --host codex --dry-run');
  });

  it('emits JSON and exits non-zero when the store needs repair', async () => {
    const audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'doctor-json-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });

    await audrey.encode({ content: 'doctor health drift episode', source: 'direct-observation' });
    audrey.db.exec('DELETE FROM vec_episodes');
    audrey.db.prepare(
      "UPDATE audrey_config SET value = ? WHERE key = 'dimensions'"
    ).run('16');
    audrey.close();

    const lines = [];
    const { report, exitCode } = runDoctorCommand({
      argv: ['node', 'mcp-server/index.js', 'doctor', '--json'],
      dataDir: TEST_DIR,
      claudeJsonPath: './missing-claude-config.json',
      env: {},
      out: line => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(report.ok).toBe(false);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.some(check => check.name === 'memory-store' && !check.ok)).toBe(true);
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
    expect(status.schema_version).toBe(11);
    expect(status.healthy).toBe(true);
    expect(status.pending_consolidation_count).toBeGreaterThanOrEqual(0);
    expect(status.embedding_warm).toBe(false);
    expect(status.warmup_duration_ms).toBeNull();
    expect(status.default_retrieval_mode).toBe('hybrid');
  });

  it('reports unhealthy when vec counts diverge', () => {
    audrey.db.exec('DELETE FROM vec_episodes');
    const status = audrey.memoryStatus();
    expect(status.episodes).toBe(1);
    expect(status.vec_episodes).toBe(0);
    expect(status.healthy).toBe(false);
  });
});
