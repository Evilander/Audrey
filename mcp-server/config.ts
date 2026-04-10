import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudreyConfig, EmbeddingConfig, LLMConfig } from '../src/types.js';

export const VERSION = '0.18.0';
export const SERVER_NAME = 'audrey-memory';
export const DEFAULT_DATA_DIR = join(homedir(), '.audrey', 'data');
export const MCP_ENTRYPOINT = fileURLToPath(new URL('./index.js', import.meta.url));

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
 * Priority: explicit config -> gemini (if GOOGLE_API_KEY exists) -> local
 * OpenAI is NEVER auto-selected -- must be set explicitly via AUDREY_EMBEDDING_PROVIDER=openai.
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
  if (env['GOOGLE_API_KEY'] || env['GEMINI_API_KEY']) {
    return { provider: 'gemini', apiKey: env['GOOGLE_API_KEY'] || env['GEMINI_API_KEY'], dimensions: 3072 };
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
  const agent = process.env['AUDREY_AGENT'] || 'claude-code';
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

export function buildInstallArgs(env: Record<string, string | undefined> = process.env): string[] {
  const envPairs = new Map<string, string>();
  const addEnv = (key: string, value: string | undefined | null): void => {
    if (value === undefined || value === null || value === '') return;
    envPairs.set(key, `${key}=${value}`);
  };

  addEnv('AUDREY_DATA_DIR', resolveDataDir(env));

  const embedding = resolveEmbeddingProvider(env, env['AUDREY_EMBEDDING_PROVIDER']);
  addEnv('AUDREY_EMBEDDING_PROVIDER', embedding.provider);
  if (embedding.provider === 'local') {
    addEnv('AUDREY_DEVICE', embedding.device || env['AUDREY_DEVICE'] || 'gpu');
  } else if (embedding.provider === 'gemini') {
    addEnv('GOOGLE_API_KEY', embedding.apiKey);
  } else if (embedding.provider === 'openai') {
    addEnv('OPENAI_API_KEY', embedding.apiKey);
  }

  const llm = resolveLLMProvider(env, env['AUDREY_LLM_PROVIDER']);
  if (llm) {
    addEnv('AUDREY_LLM_PROVIDER', llm.provider);
    if (llm.provider === 'anthropic') {
      addEnv('ANTHROPIC_API_KEY', llm.apiKey);
    } else if (llm.provider === 'openai') {
      addEnv('OPENAI_API_KEY', llm.apiKey);
    }
  }

  const args = ['mcp', 'add', '-s', 'user', SERVER_NAME];
  for (const pair of envPairs.values()) {
    args.push('-e', pair);
  }
  args.push('--', process.execPath, MCP_ENTRYPOINT);

  return args;
}
