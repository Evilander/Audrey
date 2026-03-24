import { computeConfidence, DEFAULT_HALF_LIVES, salienceModifier, sourceReliability } from './confidence.js';
import { interferenceModifier } from './interference.js';
import { contextMatchRatio, contextModifier } from './context.js';
import { moodCongruenceModifier, affectSimilarity } from './affect.js';
import { daysBetween, safeJsonParse } from './utils.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'now', 'of', 'on', 'or', 'our', 's', 'sam', 'she', 'that',
  'the', 'their', 'them', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'with', 'would', 'you', 'your',
]);

const IDENTIFIER_TERMS = new Set(['account', 'api', 'credential', 'id', 'identifier', 'key', 'number', 'password', 'secret', 'ssn', 'token']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function significantTokens(text) {
  return tokenize(text).filter(token => !STOPWORDS.has(token));
}

function lexicalCoverage(query, content) {
  const queryTokens = significantTokens(query);
  if (queryTokens.length === 0) return 1;
  const contentTokens = new Set(significantTokens(content));
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched++;
  }
  return matched / queryTokens.length;
}

function hasIdentifierIntent(query) {
  const normalized = String(query || '').toLowerCase();
  const asksForValue = /\b(find|give|lookup|show|tell|what|which)\b/.test(normalized);
  const mentionsIdentifier = /\b(account number|api key|credential|id|identifier|key|number|passport number|password|secret|ssn|token)\b/.test(normalized);
  return asksForValue && mentionsIdentifier;
}

function hasIdentifierEvidence(content) {
  const tokens = significantTokens(content);
  if (tokens.some(token => IDENTIFIER_TERMS.has(token))) {
    return true;
  }
  return /(?:\b\d{4,}\b|sk-[a-z0-9_-]+)/i.test(content);
}

function adjustedScore(query, entry) {
  const coverage = lexicalCoverage(query, entry.content);
  let score = entry.score;

  if (hasIdentifierIntent(query) && !hasIdentifierEvidence(entry.content)) {
    score *= 0.02;
  }

  return { score, coverage };
}

function overlapRatio(contentA, contentB) {
  const tokensA = significantTokens(contentA);
  const tokensB = significantTokens(contentB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setB = new Set(tokensB);
  let matched = 0;
  for (const token of tokensA) {
    if (setB.has(token)) matched++;
  }
  return matched / Math.min(tokensA.length, tokensB.length);
}

function reliabilityForRecallSource(source) {
  if (source === 'consolidation') {
    return sourceReliability('tool-result');
  }
  return sourceReliability(source);
}

function shouldSuppressDuplicate(existing, candidate) {
  const overlap = overlapRatio(existing.content, candidate.content);
  if (overlap < 0.5) return false;
  if (existing.type !== candidate.type) return false;
  const existingReliability = reliabilityForRecallSource(existing.source);
  const candidateReliability = reliabilityForRecallSource(candidate.source);
  if (existingReliability < candidateReliability) return false;
  if (existingReliability - candidateReliability < 0.2) return false;
  return existing.score >= candidate.score * 0.95;
}

function applyResultGuards(query, results, limit) {
  const identifierIntent = hasIdentifierIntent(query);
  const rescored = results
    .map(entry => {
      const { score, coverage } = adjustedScore(query, entry);
      return { ...entry, score, lexicalCoverage: coverage };
    })
    .filter(entry => !identifierIntent || entry.score > 0.05)
    .sort((a, b) => b.score - a.score);

  const accepted = [];
  for (const candidate of rescored) {
    if (accepted.some(existing => shouldSuppressDuplicate(existing, candidate))) {
      continue;
    }
    accepted.push(candidate);
    if (accepted.length >= limit) break;
  }

  return accepted;
}

function computeEpisodicConfidence(ep, now, confidenceConfig = {}) {
  const ageDays = daysBetween(ep.created_at, now);
  const halfLives = confidenceConfig.halfLives || DEFAULT_HALF_LIVES;
  let confidence = computeConfidence({
    sourceType: ep.source,
    supportingCount: 1,
    contradictingCount: 0,
    ageDays,
    halfLifeDays: halfLives.episodic ?? DEFAULT_HALF_LIVES.episodic,
    retrievalCount: 0,
    daysSinceRetrieval: ageDays,
    weights: confidenceConfig.weights,
    customSourceReliability: confidenceConfig.sourceReliability,
  });
  confidence *= salienceModifier(ep.salience);
  return Math.max(0, Math.min(1, confidence));
}

function computeSemanticConfidence(sem, now, confidenceConfig = {}) {
  const ageDays = daysBetween(sem.created_at, now);
  const daysSinceRetrieval = sem.last_reinforced_at
    ? daysBetween(sem.last_reinforced_at, now)
    : ageDays;
  const halfLives = confidenceConfig.halfLives || DEFAULT_HALF_LIVES;
  let confidence = computeConfidence({
    sourceType: 'tool-result',
    supportingCount: sem.supporting_count || 0,
    contradictingCount: sem.contradicting_count || 0,
    ageDays,
    halfLifeDays: halfLives.semantic ?? DEFAULT_HALF_LIVES.semantic,
    retrievalCount: sem.retrieval_count || 0,
    daysSinceRetrieval,
    weights: confidenceConfig.weights,
    customSourceReliability: confidenceConfig.sourceReliability,
  });
  confidence *= interferenceModifier(sem.interference_count || 0, confidenceConfig.interferenceWeight);
  confidence *= salienceModifier(sem.salience);
  return Math.max(0, Math.min(1, confidence));
}

function computeProceduralConfidence(proc, now, confidenceConfig = {}) {
  const ageDays = daysBetween(proc.created_at, now);
  const daysSinceRetrieval = proc.last_reinforced_at
    ? daysBetween(proc.last_reinforced_at, now)
    : ageDays;
  const halfLives = confidenceConfig.halfLives || DEFAULT_HALF_LIVES;
  let confidence = computeConfidence({
    sourceType: 'tool-result',
    supportingCount: proc.success_count || 0,
    contradictingCount: proc.failure_count || 0,
    ageDays,
    halfLifeDays: halfLives.procedural ?? DEFAULT_HALF_LIVES.procedural,
    retrievalCount: proc.retrieval_count || 0,
    daysSinceRetrieval,
    weights: confidenceConfig.weights,
    customSourceReliability: confidenceConfig.sourceReliability,
  });
  confidence *= interferenceModifier(proc.interference_count || 0, confidenceConfig.interferenceWeight);
  confidence *= salienceModifier(proc.salience);
  return Math.max(0, Math.min(1, confidence));
}

function buildEpisodicEntry(ep, confidence, score, includeProvenance, contextMatch, moodCongruence) {
  const entry = {
    id: ep.id,
    content: ep.content,
    type: 'episodic',
    confidence,
    score,
    source: ep.source,
    createdAt: ep.created_at,
  };
  if (contextMatch !== undefined) {
    entry.contextMatch = contextMatch;
  }
  if (moodCongruence !== undefined) {
    entry.moodCongruence = moodCongruence;
  }
  if (includeProvenance) {
    entry.provenance = {
      source: ep.source,
      sourceReliability: ep.source_reliability,
      createdAt: ep.created_at,
      supersedes: ep.supersedes || null,
    };
  }
  return entry;
}

function buildSemanticEntry(sem, confidence, score, includeProvenance) {
  const entry = {
    id: sem.id,
    content: sem.content,
    type: 'semantic',
    confidence,
    score,
    source: 'consolidation',
    state: sem.state,
    createdAt: sem.created_at,
  };
  if (includeProvenance) {
    entry.provenance = {
      evidenceEpisodeIds: safeJsonParse(sem.evidence_episode_ids, []),
      evidenceCount: sem.evidence_count || 0,
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      consolidationCheckpoint: sem.consolidation_checkpoint || null,
    };
  }
  return entry;
}

function buildProceduralEntry(proc, confidence, score, includeProvenance) {
  const entry = {
    id: proc.id,
    content: proc.content,
    type: 'procedural',
    confidence,
    score,
    source: 'consolidation',
    state: proc.state,
    createdAt: proc.created_at,
  };
  if (includeProvenance) {
    entry.provenance = {
      evidenceEpisodeIds: safeJsonParse(proc.evidence_episode_ids, []),
      successCount: proc.success_count || 0,
      failureCount: proc.failure_count || 0,
      triggerConditions: proc.trigger_conditions || null,
    };
  }
  return entry;
}

function stateClause(includeDormant) {
  return includeDormant
    ? "AND (v.state = 'active' OR v.state = 'context_dependent' OR v.state = 'dormant')"
    : "AND (v.state = 'active' OR v.state = 'context_dependent')";
}

function matchesDateFilters(createdAt, filters) {
  if (filters.after && createdAt <= filters.after) return false;
  if (filters.before && createdAt >= filters.before) return false;
  return true;
}

function safeKForTable(db, table, candidateK) {
  const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  return rowCount > 0 ? Math.min(candidateK, rowCount) : 0;
}

function knnEpisodic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, confidenceConfig, filters = {}, includePrivate = false) {
  const safeK = safeKForTable(db, 'vec_episodes', candidateK);
  if (safeK === 0) return [];
  const privateClause = includePrivate ? '' : 'AND e."private" = 0';
  const rows = db.prepare(`
    SELECT e.*, (1.0 - v.distance) AS similarity
    FROM vec_episodes v
    JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND e.superseded_by IS NULL
      ${privateClause}
  `).all(queryBuffer, safeK);

  const results = [];
  for (const row of rows) {
    if (!matchesDateFilters(row.created_at, filters)) continue;
    if (filters.tags?.length) {
      const rowTags = safeJsonParse(row.tags, []);
      if (!filters.tags.some(t => rowTags.includes(t))) continue;
    }
    if (filters.sources?.length && !filters.sources.includes(row.source)) continue;
    let confidence = computeEpisodicConfidence(row, now, confidenceConfig);

    let ctxMatch;
    if (confidenceConfig?.retrievalContext) {
      const encodingCtx = safeJsonParse(row.context, {});
      ctxMatch = contextMatchRatio(encodingCtx, confidenceConfig.retrievalContext);
      confidence *= contextModifier(encodingCtx, confidenceConfig.retrievalContext, confidenceConfig.contextWeight);
      confidence = Math.max(0, Math.min(1, confidence));
    }

    let moodMatch;
    if (confidenceConfig?.retrievalMood) {
      const encodingAffect = safeJsonParse(row.affect, {});
      moodMatch = affectSimilarity(encodingAffect, confidenceConfig.retrievalMood);
      confidence *= moodCongruenceModifier(encodingAffect, confidenceConfig.retrievalMood, confidenceConfig.affectWeight);
      confidence = Math.max(0, Math.min(1, confidence));
    }

    if (confidence < minConfidence) continue;
    const score = row.similarity * confidence;
    results.push(buildEpisodicEntry(row, confidence, score, includeProvenance, ctxMatch, moodMatch));
  }
  return results;
}

function knnSemantic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant, confidenceConfig, filters = {}) {
  const safeK = safeKForTable(db, 'vec_semantics', candidateK);
  if (safeK === 0) return { results: [], matchedIds: [] };
  const rows = db.prepare(`
    SELECT s.*, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${stateClause(includeDormant)}
  `).all(queryBuffer, safeK);

  const results = [];
  const matchedIds = [];
  for (const row of rows) {
    if (!matchesDateFilters(row.created_at, filters)) continue;
    const confidence = computeSemanticConfidence(row, now, confidenceConfig);
    if (confidence < minConfidence) continue;
    const score = row.similarity * confidence;
    matchedIds.push(row.id);
    results.push(buildSemanticEntry(row, confidence, score, includeProvenance));
  }
  return { results, matchedIds };
}

function knnProcedural(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant, confidenceConfig, filters = {}) {
  const safeK = safeKForTable(db, 'vec_procedures', candidateK);
  if (safeK === 0) return { results: [], matchedIds: [] };
  const rows = db.prepare(`
    SELECT p.*, (1.0 - v.distance) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${stateClause(includeDormant)}
  `).all(queryBuffer, safeK);

  const results = [];
  const matchedIds = [];
  for (const row of rows) {
    if (!matchesDateFilters(row.created_at, filters)) continue;
    const confidence = computeProceduralConfidence(row, now, confidenceConfig);
    if (confidence < minConfidence) continue;
    const score = row.similarity * confidence;
    matchedIds.push(row.id);
    results.push(buildProceduralEntry(row, confidence, score, includeProvenance));
  }
  return { results, matchedIds };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embedding.js').EmbeddingProvider} embeddingProvider
 * @param {string} query
 * @param {{ minConfidence?: number, types?: string[], limit?: number, includeProvenance?: boolean, includeDormant?: boolean, tags?: string[], sources?: string[], after?: string, before?: string }} [options]
 * @returns {AsyncGenerator<{ id: string, content: string, type: string, confidence: number, score: number, source: string, createdAt: string }>}
 */
export async function* recallStream(db, embeddingProvider, query, options = {}) {
  const {
    minConfidence = 0,
    types,
    limit = 10,
    includeProvenance = false,
    includeDormant = false,
    confidenceConfig,
    tags,
    sources,
    after,
    before,
    includePrivate = false,
  } = options;

  const queryVector = await embeddingProvider.embed(query);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);
  const searchTypes = types || ['episodic', 'semantic', 'procedural'];
  const now = new Date();
  const hasFilters = tags?.length || sources?.length || after || before;
  const candidateK = hasFilters ? limit * 5 : limit * 3;
  const filters = { tags, sources, after, before };

  const allResults = [];

  if (searchTypes.includes('episodic')) {
    try {
      const episodic = knnEpisodic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, confidenceConfig, filters, includePrivate);
      allResults.push(...episodic);
    } catch {
      // A broken episodic index should not block semantic/procedural recall.
    }
  }

  if (searchTypes.includes('semantic')) {
    try {
      const { results: semResults, matchedIds: semIds } =
        knnSemantic(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant, confidenceConfig, filters);
      allResults.push(...semResults);

      if (semIds.length > 0) {
        const nowISO = now.toISOString();
        const placeholders = semIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE semantics SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id IN (${placeholders})`
        ).run(nowISO, ...semIds);
      }
    } catch {
      // A broken semantic index should not block other memory types.
    }
  }

  if (searchTypes.includes('procedural')) {
    try {
      const { results: procResults, matchedIds: procIds } =
        knnProcedural(db, queryBuffer, candidateK, now, minConfidence, includeProvenance, includeDormant, confidenceConfig, filters);
      allResults.push(...procResults);

      if (procIds.length > 0) {
        const nowISO = now.toISOString();
        const placeholders = procIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE procedures SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id IN (${placeholders})`
        ).run(nowISO, ...procIds);
      }
    } catch {
      // A broken procedural index should not block other memory types.
    }
  }

  const top = applyResultGuards(query, allResults, limit);
  for (const entry of top) {
    yield entry;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embedding.js').EmbeddingProvider} embeddingProvider
 * @param {string} query
 * @param {{ minConfidence?: number, types?: string[], limit?: number, includeProvenance?: boolean, includeDormant?: boolean, tags?: string[], sources?: string[], after?: string, before?: string }} [options]
 * @returns {Promise<Array<{ id: string, content: string, type: string, confidence: number, score: number, source: string, createdAt: string }>>}
 */
export async function recall(db, embeddingProvider, query, options = {}) {
  const results = [];
  for await (const entry of recallStream(db, embeddingProvider, query, options)) {
    results.push(entry);
  }
  return results;
}
