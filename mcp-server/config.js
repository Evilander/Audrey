import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.3.2';
export const SERVER_NAME = 'audrey-memory';
export const DEFAULT_DATA_DIR = join(homedir(), '.audrey', 'data');

export function buildAudreyConfig() {
  const dataDir = process.env.AUDREY_DATA_DIR || DEFAULT_DATA_DIR;
  const agent = process.env.AUDREY_AGENT || 'claude-code';
  const embProvider = process.env.AUDREY_EMBEDDING_PROVIDER || 'mock';
  const embDimensions = parseInt(process.env.AUDREY_EMBEDDING_DIMENSIONS || '8', 10);
  const llmProvider = process.env.AUDREY_LLM_PROVIDER;

  const config = {
    dataDir,
    agent,
    embedding: { provider: embProvider, dimensions: embDimensions },
  };

  if (embProvider === 'openai') {
    config.embedding.apiKey = process.env.OPENAI_API_KEY;
  }

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

  if (env.OPENAI_API_KEY) {
    envPairs.push('AUDREY_EMBEDDING_PROVIDER=openai');
    envPairs.push('AUDREY_EMBEDDING_DIMENSIONS=1536');
    envPairs.push(`OPENAI_API_KEY=${env.OPENAI_API_KEY}`);
  } else {
    envPairs.push('AUDREY_EMBEDDING_PROVIDER=mock');
    envPairs.push('AUDREY_EMBEDDING_DIMENSIONS=8');
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
