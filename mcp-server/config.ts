import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudreyConfig, EmbeddingConfig, LLMConfig } from '../src/types.js';

export const VERSION = '1.2.0';
export const SERVER_NAME = 'audrey-memory';
export const DEFAULT_AGENT = 'local-agent';
export const DEFAULT_DATA_DIR = join(homedir(), '.audrey', 'data');
export const MCP_ENTRYPOINT = fileURLToPath(new URL('./index.js', import.meta.url));

export const HOST_AGENT_NAMES = {
  generic: DEFAULT_AGENT,
  codex: 'codex',
  'claude-code': 'claude-code',
  'claude-desktop': 'claude-desktop',
  cursor: 'cursor',
  windsurf: 'windsurf',
  vscode: 'vscode-copilot',
  jetbrains: 'jetbrains',
} as const;

export type AudreyHost = keyof typeof HOST_AGENT_NAMES;

interface McpEnvOptions {
  includeSecrets?: boolean;
  scope?: 'local' | 'project' | 'user';
}

const VALID_EMBEDDING_PROVIDERS = new Set(['mock', 'local', 'gemini', 'openai']);
const VALID_LLM_PROVIDERS = new Set(['mock', 'anthropic', 'openai']);

function assertValidProvider(provider: string, validProviders: Set<string>, envVar: string): void {
  if (!validProviders.has(provider)) {
    throw new Error(`Unsupported ${envVar} value: ${provider}`);
  }
}

function defaultEmbeddingDimensions(provider: string): number {
  switch (provider) {
    case 'mock':
      return 64;
    case 'openai':
      return 1536;
    case 'gemini':
      return 3072;
    case 'local':
    default:
      return 384;
  }
}

export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  return env['AUDREY_DATA_DIR'] || DEFAULT_DATA_DIR;
}

/**
 * Resolves which embedding provider to use.
 * Priority: explicit config -> local.
 * Cloud providers are never auto-selected from ambient API keys; choose them
 * explicitly with AUDREY_EMBEDDING_PROVIDER=gemini|openai.
 */
export function resolveEmbeddingProvider(
  env: Record<string, string | undefined>,
  explicit: string | undefined = env['AUDREY_EMBEDDING_PROVIDER'],
): EmbeddingConfig & { dimensions: number } {
  if (explicit && explicit !== 'auto') {
    assertValidProvider(explicit, VALID_EMBEDDING_PROVIDERS, 'AUDREY_EMBEDDING_PROVIDER');
    const provider = explicit as EmbeddingConfig['provider'];
    const dims = defaultEmbeddingDimensions(explicit);
    const apiKey =
      explicit === 'gemini'
        ? env['GOOGLE_API_KEY'] || env['GEMINI_API_KEY']
        : explicit === 'openai'
          ? env['OPENAI_API_KEY']
          : undefined;
    const result: EmbeddingConfig & { dimensions: number } = { provider, apiKey, dimensions: dims };
    if (explicit === 'local') result.device = env['AUDREY_DEVICE'] || 'gpu';
    return result;
  }
  return { provider: 'local', dimensions: 384, device: env['AUDREY_DEVICE'] || 'gpu' };
}

/**
 * Resolves which LLM provider to use for principle extraction / reflection.
 * Priority: explicit config -> none (local heuristics only).
 * Cloud providers are never auto-selected from ambient API keys: memory
 * content is sent to the provider verbatim (buildPrincipleExtractionPrompt),
 * so leaving AUDREY_LLM_PROVIDER unset (or 'auto') must never cause content
 * to leave the machine just because ANTHROPIC_API_KEY/OPENAI_API_KEY happens
 * to be set for some unrelated tool. Choose a cloud provider explicitly with
 * AUDREY_LLM_PROVIDER=anthropic|openai.
 */
export function resolveLLMProvider(
  env: Record<string, string | undefined>,
  explicit: string | undefined = env['AUDREY_LLM_PROVIDER'],
  options: { requireApiKey?: boolean } = {},
): (LLMConfig & { apiKey?: string }) | null {
  const { requireApiKey = true } = options;
  const model = env['AUDREY_LLM_MODEL']?.trim() || undefined;
  const withModel = model ? { model } : {};

  if (!explicit || explicit === 'auto') {
    return null;
  }

  assertValidProvider(explicit, VALID_LLM_PROVIDERS, 'AUDREY_LLM_PROVIDER');
  const provider = explicit as LLMConfig['provider'];
  if (provider === 'anthropic') {
    const apiKey = env['ANTHROPIC_API_KEY'];
    if (requireApiKey && !apiKey) {
      throw new Error('AUDREY_LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.');
    }
    return { provider: 'anthropic', apiKey, ...withModel };
  }
  if (provider === 'openai') {
    const apiKey = env['OPENAI_API_KEY'];
    if (requireApiKey && !apiKey) {
      throw new Error('AUDREY_LLM_PROVIDER=openai requires OPENAI_API_KEY to be set.');
    }
    return { provider: 'openai', apiKey, ...withModel };
  }
  return { provider: 'mock' };
}

export function buildAudreyConfig(): AudreyConfig {
  const dataDir = resolveDataDir(process.env);
  const agent = process.env['AUDREY_AGENT'] || DEFAULT_AGENT;
  const explicitProvider = process.env['AUDREY_EMBEDDING_PROVIDER'];

  const embedding = resolveEmbeddingProvider(process.env, explicitProvider);
  const llm = resolveLLMProvider(process.env, process.env['AUDREY_LLM_PROVIDER']);

  const config: AudreyConfig = { dataDir, agent, embedding };
  if (llm) {
    // LLMConfig requires provider as literal union; resolveLLMProvider guarantees this
    config.llm = llm;
  }

  return config;
}

export function resolveHostAgent(host: string | undefined): string {
  if (!host) return HOST_AGENT_NAMES.generic;
  if (host in HOST_AGENT_NAMES) return HOST_AGENT_NAMES[host as AudreyHost];
  throw new Error(
    `Unsupported MCP host "${host}". Supported hosts: ${Object.keys(HOST_AGENT_NAMES).join(', ')}`,
  );
}

export function buildAudreyMcpEnv(
  env: Record<string, string | undefined> = process.env,
  agent = env['AUDREY_AGENT'] || DEFAULT_AGENT,
  options: McpEnvOptions = {},
): Record<string, string> {
  const includeSecrets = options.includeSecrets ?? false;
  const providerEnv = includeSecrets
    ? env
    : {
        ...env,
        ANTHROPIC_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      };
  const envPairs = new Map<string, string>();
  const addEnv = (key: string, value: string | undefined | null): void => {
    if (value === undefined || value === null || value === '') return;
    envPairs.set(key, value);
  };

  addEnv('AUDREY_DATA_DIR', resolveDataDir(env));
  addEnv('AUDREY_AGENT', agent);

  const embedding = resolveEmbeddingProvider(providerEnv, env['AUDREY_EMBEDDING_PROVIDER']);
  addEnv('AUDREY_EMBEDDING_PROVIDER', embedding.provider);
  if (embedding.provider === 'local') {
    addEnv('AUDREY_DEVICE', embedding.device || env['AUDREY_DEVICE'] || 'gpu');
  } else if (embedding.provider === 'gemini') {
    if (includeSecrets) addEnv('GOOGLE_API_KEY', embedding.apiKey);
  } else if (embedding.provider === 'openai') {
    if (includeSecrets) addEnv('OPENAI_API_KEY', embedding.apiKey);
  }

  // requireApiKey: false — this only writes a portable env/CLI-args config;
  // the actual key is expected to be present in the environment when the
  // resulting MCP server process is later launched, not baked in here.
  const llm = resolveLLMProvider(providerEnv, env['AUDREY_LLM_PROVIDER'], { requireApiKey: false });
  if (llm) {
    addEnv('AUDREY_LLM_PROVIDER', llm.provider);
    if (llm.model) addEnv('AUDREY_LLM_MODEL', llm.model);
    if (llm.provider === 'anthropic') {
      if (includeSecrets) addEnv('ANTHROPIC_API_KEY', llm.apiKey);
    } else if (llm.provider === 'openai') {
      if (includeSecrets) addEnv('OPENAI_API_KEY', llm.apiKey);
    }
  }

  return Object.fromEntries(envPairs);
}

const AUTOPILOT_RUNTIME_FLAGS: Record<string, string> = {
  AUDREY_DATA_DIR: '--data-dir',
  AUDREY_AGENT: '--agent',
  AUDREY_EMBEDDING_PROVIDER: '--embedding-provider',
  AUDREY_DEVICE: '--device',
  AUDREY_LLM_PROVIDER: '--llm-provider',
  AUDREY_LLM_MODEL: '--llm-model',
};

export function buildAutopilotRuntimeArgs(
  env: Record<string, string | undefined> = process.env,
  agent = env['AUDREY_AGENT'] || DEFAULT_AGENT,
): string[] {
  const runtime = buildAudreyMcpEnv(env, agent, { includeSecrets: false });
  return Object.entries(AUTOPILOT_RUNTIME_FLAGS).flatMap(([key, flag]) => {
    const value = runtime[key];
    return value ? [flag, value] : [];
  });
}

export function buildStdioMcpServerConfig(
  env: Record<string, string | undefined> = process.env,
  host: string | undefined = 'generic',
): { command: string; args: string[]; env: Record<string, string> } {
  const agent = env['AUDREY_AGENT'] || resolveHostAgent(host);
  return {
    command: process.execPath,
    args: [MCP_ENTRYPOINT],
    env: buildAudreyMcpEnv(env, agent, { includeSecrets: false }),
  };
}

function jsonHostConfig(
  host: string | undefined,
  env: Record<string, string | undefined>,
): unknown {
  const config = buildStdioMcpServerConfig(env, host);
  if (host === 'vscode') {
    return {
      servers: {
        [SERVER_NAME]: {
          type: 'stdio',
          ...config,
        },
      },
    };
  }

  return {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'stdio',
        ...config,
      },
    },
  };
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function formatMcpHostConfig(
  host: string | undefined = 'generic',
  env: Record<string, string | undefined> = process.env,
): string {
  const normalizedHost = host || 'generic';
  if (normalizedHost === 'codex') {
    const config = buildStdioMcpServerConfig(env, normalizedHost);
    const lines = [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(config.command)}`,
      `args = [${config.args.map(tomlString).join(', ')}]`,
      '',
      `[mcp_servers.${SERVER_NAME}.env]`,
      ...Object.entries(config.env).map(([key, value]) => `${key} = ${tomlString(value)}`),
    ];
    return lines.join('\n');
  }

  return JSON.stringify(jsonHostConfig(normalizedHost, env), null, 2);
}

export function buildInstallArgs(
  env: Record<string, string | undefined> = process.env,
  options: McpEnvOptions = {},
): string[] {
  const envPairs = buildAudreyMcpEnv(env, env['AUDREY_AGENT'] || HOST_AGENT_NAMES['claude-code'], {
    includeSecrets: options.includeSecrets ?? false,
  });
  // Claude's --env option is variadic, so the required server name must come
  // first or it can be consumed as another environment value.
  const args = [
    'mcp',
    'add',
    '--transport',
    'stdio',
    '--scope',
    options.scope ?? 'user',
    SERVER_NAME,
  ];
  for (const [key, value] of Object.entries(envPairs)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--', process.execPath, MCP_ENTRYPOINT);

  return args;
}

export function buildCodexInstallArgs(
  env: Record<string, string | undefined> = process.env,
  options: McpEnvOptions = {},
): string[] {
  const envPairs = buildAudreyMcpEnv(env, env['AUDREY_AGENT'] || HOST_AGENT_NAMES.codex, {
    includeSecrets: options.includeSecrets ?? false,
  });
  const args = ['mcp', 'add', SERVER_NAME];
  for (const [key, value] of Object.entries(envPairs)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--', process.execPath, MCP_ENTRYPOINT);
  return args;
}
