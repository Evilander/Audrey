import { createEmbeddingProvider } from '../src/embedding.js';
import { cosineSimilarity } from '../src/utils.js';

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
