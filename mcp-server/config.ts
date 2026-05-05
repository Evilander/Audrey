import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudreyConfig, EmbeddingConfig, LLMConfig } from '../src/types.js';

export const VERSION = '0.23.0';
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
    const apiKey = explicit === 'gemini'
      ? (env['GOOGLE_API_KEY'] || env['GEMINI_API_KEY'])
      : explicit === 'openai'
        ? env['OPENAI_API_KEY']
        : undefined;
    const result: EmbeddingConfig & { dimensions: number } = { provider, apiKey, dimensions: dims };
    if (explicit === 'local') result.device = env['AUDREY_DEVICE'] || 'gpu';
    return result;
  }
  return { provider: 'local', dimensions: 384, device: env['AUDREY_DEVICE'] || 'gpu' };
}

export function resolveLLMProvider(
  env: Record<string, string | undefined>,
  explicit: string | undefined = env['AUDREY_LLM_PROVIDER'],
): (LLMConfig & { apiKey?: string }) | null {
  if (explicit && explicit !== 'auto') {
    assertValidProvider(explicit, VALID_LLM_PROVIDERS, 'AUDREY_LLM_PROVIDER');
    const provider = explicit as LLMConfig['provider'];
    if (provider === 'anthropic') {
      return { provider: 'anthropic', apiKey: env['ANTHROPIC_API_KEY'] };
    }
    if (provider === 'openai') {
      return { provider: 'openai', apiKey: env['OPENAI_API_KEY'] };
    }
    return { provider: 'mock' };
  }

  if (env['ANTHROPIC_API_KEY']) {
    return { provider: 'anthropic', apiKey: env['ANTHROPIC_API_KEY'] };
  }
  if (env['OPENAI_API_KEY']) {
    return { provider: 'openai', apiKey: env['OPENAI_API_KEY'] };
  }
  return null;
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
    config.llm = llm as AudreyConfig['llm'];
  }

  return config;
}

export function resolveHostAgent(host: string | undefined): string {
  if (!host) return HOST_AGENT_NAMES.generic;
  if (host in HOST_AGENT_NAMES) return HOST_AGENT_NAMES[host as AudreyHost];
  throw new Error(`Unsupported MCP host "${host}". Supported hosts: ${Object.keys(HOST_AGENT_NAMES).join(', ')}`);
}

export function buildAudreyMcpEnv(
  env: Record<string, string | undefined> = process.env,
  agent = env['AUDREY_AGENT'] || DEFAULT_AGENT,
  options: McpEnvOptions = {},
): Record<string, string> {
  const includeSecrets = options.includeSecrets ?? true;
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

  const llm = resolveLLMProvider(providerEnv, env['AUDREY_LLM_PROVIDER']);
  if (llm) {
    addEnv('AUDREY_LLM_PROVIDER', llm.provider);
    if (llm.provider === 'anthropic') {
      if (includeSecrets) addEnv('ANTHROPIC_API_KEY', llm.apiKey);
    } else if (llm.provider === 'openai') {
      if (includeSecrets) addEnv('OPENAI_API_KEY', llm.apiKey);
    }
  }

  return Object.fromEntries(envPairs);
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

function jsonHostConfig(host: string | undefined, env: Record<string, string | undefined>): unknown {
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
  const envPairs = buildAudreyMcpEnv(
    env,
    env['AUDREY_AGENT'] || HOST_AGENT_NAMES['claude-code'],
    { includeSecrets: options.includeSecrets ?? false },
  );
  const args = ['mcp', 'add', '-s', 'user', SERVER_NAME];
  for (const [key, value] of Object.entries(envPairs)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push('--', process.execPath, MCP_ENTRYPOINT);

  return args;
}
