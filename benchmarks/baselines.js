import { createEmbeddingProvider } from '../dist/src/embedding.js';
import { cosineSimilarity } from '../dist/src/utils.js';

function normalize(text) {
  return String(text || '').toLowerCase();
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function keywordScore(queryTokens, content) {
  const contentTokens = new Set(tokenize(content));
  if (queryTokens.length === 0) return 0;
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matches++;
  }
  return matches / queryTokens.length;
}

function sortByScore(rows) {
  return rows
    .filter(row => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function flattenMemories(benchmarkCase, ids = []) {
  return benchmarkCase.memory.map((memory, index) => ({
    id: ids[index] || `memory-${index + 1}`,
    content: memory.content,
    source: memory.source,
    createdAt: memory.createdAt || new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    private: Boolean(memory.private),
  }));
}

function buildSyntheticCase(query, memories, options = {}) {
  return {
    query,
    memory: memories.map(memory => ({
      content: memory.content,
      source: memory.source,
      createdAt: memory.createdAt,
      private: memory.private,
    })),
    options,
  };
}

async function runBaselineRetrieval(system, syntheticCase, providerConfig, limit = 5) {
  switch (system) {
    case 'Vector Only':
      return runVectorOnlyBaseline(syntheticCase, providerConfig, limit);
    case 'Keyword + Recency':
      return runKeywordRecencyBaseline(syntheticCase, limit);
    case 'Recent Window':
      return runRecentWindowBaseline(syntheticCase, limit);
    default:
      throw new Error(`Unknown baseline system: ${system}`);
  }
}

function createOperationMemory(state, step) {
  const index = state.counter++;
  return {
    id: `memory-${index + 1}`,
    content: step.memory.content,
    source: step.memory.source,
    createdAt: step.memory.createdAt || new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    private: Boolean(step.memory.private),
  };
}

async function applyBaselineStep(system, state, step, providerConfig) {
  if (step.type === 'encode') {
    const memory = createOperationMemory(state, step);
    state.memories.push(memory);
    if (step.saveAs) {
      state.aliases.set(step.saveAs, memory.id);
    }
    return;
  }

  if (step.type === 'forgetByQuery') {
    const syntheticCase = buildSyntheticCase(step.query, state.memories, step.options);
    const [match] = await runBaselineRetrieval(system, syntheticCase, providerConfig, 1);
    if (match && Number.isFinite(match.score) && match.score > 0) {
      state.memories = state.memories.filter(memory => memory.id !== match.id);
    }
    return;
  }

  if (step.type === 'consolidate') {
    return;
  }

  throw new Error(`Unsupported baseline step: ${step.type}`);
}

export async function runBaselineScenario(system, benchmarkCase, providerConfig, limit = 5) {
  if (benchmarkCase.kind !== 'operations') {
    return runBaselineRetrieval(system, benchmarkCase, providerConfig, limit);
  }

  const state = {
    counter: 0,
    memories: [],
    aliases: new Map(),
  };

  for (const step of benchmarkCase.steps || []) {
    await applyBaselineStep(system, state, step, providerConfig);
  }

  return runBaselineRetrieval(
    system,
    buildSyntheticCase(benchmarkCase.query, state.memories, benchmarkCase.options),
    providerConfig,
    limit,
  );
}

export function runKeywordRecencyBaseline(benchmarkCase, limit = 5) {
  const queryTokens = tokenize(benchmarkCase.query);
  return sortByScore(flattenMemories(benchmarkCase).map(memory => ({
    ...memory,
    type: 'episodic',
    score: keywordScore(queryTokens, memory.content),
  }))).slice(0, limit);
}

export function runRecentWindowBaseline(benchmarkCase, limit = 3) {
  return flattenMemories(benchmarkCase)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((memory, index) => ({
      ...memory,
      type: 'episodic',
      score: 1 - index * 0.1,
    }));
}

export async function runVectorOnlyBaseline(benchmarkCase, providerConfig, limit = 5) {
  const provider = createEmbeddingProvider(providerConfig);
  if (typeof provider.ready === 'function') {
    await provider.ready();
  }

  const queryVector = await provider.embed(benchmarkCase.query);
  const queryBuffer = provider.vectorToBuffer(queryVector);

  const rows = [];
  for (const memory of flattenMemories(benchmarkCase)) {
    const vector = await provider.embed(memory.content);
    const score = cosineSimilarity(queryBuffer, provider.vectorToBuffer(vector), provider);
    rows.push({
      ...memory,
      type: 'episodic',
      score,
    });
  }

  return sortByScore(rows).slice(0, limit);
}
