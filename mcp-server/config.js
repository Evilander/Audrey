import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

export const VERSION = PACKAGE_JSON.version;
export const SERVER_NAME = 'audrey-memory';
export const DEFAULT_DATA_DIR = join(homedir(), '.audrey', 'data');
export const MCP_ENTRYPOINT = fileURLToPath(new URL('./index.js', import.meta.url));
const VALID_EMBEDDING_PROVIDERS = new Set(['mock', 'local', 'gemini', 'openai']);
const VALID_LLM_PROVIDERS = new Set(['mock', 'anthropic', 'openai']);
const INIT_PRESETS = Object.freeze({
  'local-offline': {
    description: 'Claude Code with local embeddings, no hosted providers required',
    surface: 'claude',
    installHooks: true,
  },
  'hosted-fast': {
    description: 'Claude Code with the fastest hosted providers detected from your environment',
    surface: 'claude',
    installHooks: true,
  },
  'ci-mock': {
    description: 'Mock providers for CI, smoke tests, and deterministic local validation',
    surface: 'automation',
    installHooks: false,
  },
  'sidecar-prod': {
    description: 'REST or Docker sidecar with operator-friendly defaults',
    surface: 'sidecar',
    installHooks: false,
  },
});

function stripProviderKeys(env) {
  const next = { ...env };
  delete next.GOOGLE_API_KEY;
  delete next.GEMINI_API_KEY;
  delete next.OPENAI_API_KEY;
  delete next.ANTHROPIC_API_KEY;
  delete next.AUDREY_LLM_PROVIDER;
  return next;
}

function assertValidProvider(provider, validProviders, envVar) {
  if (!validProviders.has(provider)) {
    throw new Error(`Unsupported ${envVar} value: ${provider}`);
  }
}

function defaultEmbeddingDimensions(provider) {
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

export function resolveDataDir(env = process.env) {
  return env.AUDREY_DATA_DIR || DEFAULT_DATA_DIR;
}

/**
 * Resolves which embedding provider to use.
 * Priority: explicit config -> gemini (if GOOGLE_API_KEY exists) -> local
 * OpenAI is NEVER auto-selected -- must be set explicitly via AUDREY_EMBEDDING_PROVIDER=openai.
 */
export function resolveEmbeddingProvider(env, explicit = env.AUDREY_EMBEDDING_PROVIDER) {
  if (explicit && explicit !== 'auto') {
    assertValidProvider(explicit, VALID_EMBEDDING_PROVIDERS, 'AUDREY_EMBEDDING_PROVIDER');
    const dims = defaultEmbeddingDimensions(explicit);
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

export function resolveLLMProvider(env, explicit = env.AUDREY_LLM_PROVIDER) {
  if (explicit && explicit !== 'auto') {
    assertValidProvider(explicit, VALID_LLM_PROVIDERS, 'AUDREY_LLM_PROVIDER');
    if (explicit === 'anthropic') {
      return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY };
    }
    if (explicit === 'openai') {
      return { provider: 'openai', apiKey: env.OPENAI_API_KEY };
    }
    return { provider: 'mock' };
  }

  if (env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', apiKey: env.ANTHROPIC_API_KEY };
  }
  if (env.OPENAI_API_KEY) {
    return { provider: 'openai', apiKey: env.OPENAI_API_KEY };
  }
  return null;
}

export function buildAudreyConfig() {
  const dataDir = resolveDataDir(process.env);
  const agent = process.env.AUDREY_AGENT || 'claude-code';
  const explicitProvider = process.env.AUDREY_EMBEDDING_PROVIDER;

  const embedding = resolveEmbeddingProvider(process.env, explicitProvider);
  const llm = resolveLLMProvider(process.env, process.env.AUDREY_LLM_PROVIDER);

  const config = { dataDir, agent, embedding };
  if (llm) {
    config.llm = llm;
  }

  return config;
}

export function buildInstallArgs(env = process.env) {
  const envPairs = new Map();
  const addEnv = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    envPairs.set(key, `${key}=${value}`);
  };

  addEnv('AUDREY_DATA_DIR', resolveDataDir(env));

  const embedding = resolveEmbeddingProvider(env, env.AUDREY_EMBEDDING_PROVIDER);
  addEnv('AUDREY_EMBEDDING_PROVIDER', embedding.provider);
  if (embedding.provider === 'local') {
    addEnv('AUDREY_DEVICE', embedding.device || env.AUDREY_DEVICE || 'gpu');
  } else if (embedding.provider === 'gemini') {
    addEnv('GOOGLE_API_KEY', embedding.apiKey);
  } else if (embedding.provider === 'openai') {
    addEnv('OPENAI_API_KEY', embedding.apiKey);
  }

  const llm = resolveLLMProvider(env, env.AUDREY_LLM_PROVIDER);
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

export function listInitPresets() {
  return Object.entries(INIT_PRESETS).map(([name, preset]) => ({
    name,
    ...preset,
  }));
}

export function buildInitEnv(env = process.env, presetName = 'local-offline') {
  const preset = INIT_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unsupported init preset: ${presetName}`);
  }

  const next = {
    ...env,
    AUDREY_DATA_DIR: resolveDataDir(env),
  };

  switch (presetName) {
    case 'local-offline': {
      const offline = stripProviderKeys(next);
      offline.AUDREY_AGENT = env.AUDREY_AGENT || 'claude-code';
      offline.AUDREY_EMBEDDING_PROVIDER = 'local';
      offline.AUDREY_DEVICE = env.AUDREY_DEVICE || 'gpu';
      return offline;
    }
    case 'hosted-fast': {
      next.AUDREY_AGENT = env.AUDREY_AGENT || 'claude-code';
      if (!env.AUDREY_EMBEDDING_PROVIDER) {
        next.AUDREY_EMBEDDING_PROVIDER = env.GOOGLE_API_KEY || env.GEMINI_API_KEY
          ? 'gemini'
          : env.OPENAI_API_KEY
            ? 'openai'
            : 'local';
      }
      if (next.AUDREY_EMBEDDING_PROVIDER === 'local') {
        next.AUDREY_DEVICE = env.AUDREY_DEVICE || 'gpu';
      }
      if (!env.AUDREY_LLM_PROVIDER) {
        if (env.ANTHROPIC_API_KEY) {
          next.AUDREY_LLM_PROVIDER = 'anthropic';
        } else if (env.OPENAI_API_KEY) {
          next.AUDREY_LLM_PROVIDER = 'openai';
        }
      }
      return next;
    }
    case 'ci-mock': {
      const mock = stripProviderKeys(next);
      mock.AUDREY_AGENT = env.AUDREY_AGENT || 'audrey-ci';
      mock.AUDREY_EMBEDDING_PROVIDER = 'mock';
      mock.AUDREY_LLM_PROVIDER = 'mock';
      delete mock.AUDREY_DEVICE;
      return mock;
    }
    case 'sidecar-prod': {
      next.AUDREY_AGENT = env.AUDREY_AGENT || 'audrey-sidecar';
      next.AUDREY_HOST = env.AUDREY_HOST || '0.0.0.0';
      next.AUDREY_PORT = env.AUDREY_PORT || '3487';
      if (!env.AUDREY_EMBEDDING_PROVIDER) {
        next.AUDREY_EMBEDDING_PROVIDER = env.GOOGLE_API_KEY || env.GEMINI_API_KEY
          ? 'gemini'
          : env.OPENAI_API_KEY
            ? 'openai'
            : 'local';
      }
      if (next.AUDREY_EMBEDDING_PROVIDER === 'local') {
        next.AUDREY_DEVICE = env.AUDREY_DEVICE || 'gpu';
      }
      if (!env.AUDREY_LLM_PROVIDER) {
        if (env.ANTHROPIC_API_KEY) {
          next.AUDREY_LLM_PROVIDER = 'anthropic';
        } else if (env.OPENAI_API_KEY) {
          next.AUDREY_LLM_PROVIDER = 'openai';
        }
      }
      return next;
    }
    default:
      return next;
  }
}
