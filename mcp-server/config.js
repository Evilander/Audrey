import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.14.0';
export const SERVER_NAME = 'audrey-memory';
export const DEFAULT_DATA_DIR = join(homedir(), '.audrey', 'data');

/**
 * Resolves which embedding provider to use.
 * Priority: explicit config -> gemini (if GOOGLE_API_KEY exists) -> local
 * OpenAI is NEVER auto-selected -- must be set explicitly via AUDREY_EMBEDDING_PROVIDER=openai.
 */
export function resolveEmbeddingProvider(env, explicit) {
  if (explicit && explicit !== 'auto') {
    const dims = explicit === 'openai' ? 1536 : explicit === 'gemini' ? 3072 : 384;
    const apiKey = explicit === 'gemini'
      ? (env.GOOGLE_API_KEY || env.GEMINI_API_KEY)
      : explicit === 'openai'
        ? env.OPENAI_API_KEY
        : undefined;
    const result = { provider: explicit, apiKey, dimensions: dims };
    if (explicit === 'local') result.device = env.AUDREY_DEVICE || 'gpu';
    return result;
  }
  if (env.GOOGLE_API_KEY || env.GEMINI_API_KEY) {
    return { provider: 'gemini', apiKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY, dimensions: 3072 };
  }
  return { provider: 'local', dimensions: 384, device: env.AUDREY_DEVICE || 'gpu' };
}

export function buildAudreyConfig() {
  const dataDir = process.env.AUDREY_DATA_DIR || DEFAULT_DATA_DIR;
  const agent = process.env.AUDREY_AGENT || 'claude-code';
  const explicitProvider = process.env.AUDREY_EMBEDDING_PROVIDER;
  const llmProvider = process.env.AUDREY_LLM_PROVIDER;

  const embedding = resolveEmbeddingProvider(process.env, explicitProvider);

  const config = { dataDir, agent, embedding };

  if (llmProvider === 'anthropic') {
    config.llm = { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY };
  } else if (llmProvider === 'openai') {
    config.llm = { provider: 'openai', apiKey: process.env.OPENAI_API_KEY };
  } else if (llmProvider === 'mock') {
    config.llm = { provider: 'mock' };
  }

  return config;
}

export function buildInstallArgs(env = process.env) {
  const envPairs = [`AUDREY_DATA_DIR=${DEFAULT_DATA_DIR}`];

  const embedding = resolveEmbeddingProvider(env);
  if (embedding.provider === 'gemini') {
    envPairs.push('AUDREY_EMBEDDING_PROVIDER=gemini');
    envPairs.push(`GOOGLE_API_KEY=${embedding.apiKey}`);
  } else if (embedding.provider === 'openai') {
    envPairs.push('AUDREY_EMBEDDING_PROVIDER=openai');
    envPairs.push(`OPENAI_API_KEY=${env.OPENAI_API_KEY}`);
  }

  if (env.ANTHROPIC_API_KEY) {
    envPairs.push('AUDREY_LLM_PROVIDER=anthropic');
    envPairs.push(`ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`);
  }

  const args = ['mcp', 'add', '-s', 'user', SERVER_NAME];
  for (const pair of envPairs) {
    args.push('-e', pair);
  }
  args.push('--', 'npx', 'audrey');

  return args;
}
