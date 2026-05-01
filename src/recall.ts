import Database from 'better-sqlite3';
import type {
  ConfidenceConfig,
  EmbeddingProvider,
  EpisodeRow,
  MemoryType,
  ProceduralRow,
  RecallOptions,
  RecallResult,
  SemanticRow,
} from './types.js';
import { computeConfidence, DEFAULT_HALF_LIVES, salienceModifier, sourceReliability } from './confidence.js';
import { interferenceModifier } from './interference.js';
import { contextMatchRatio, contextModifier } from './context.js';
import { moodCongruenceModifier, affectSimilarity } from './affect.js';
import { daysBetween, safeJsonParse } from './utils.js';
import { ftsIdsByType, fuseResults } from './hybrid-recall.js';
import type { ProfileRecorder } from './profile.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'now', 'of', 'on', 'or', 'our', 's', 'sam', 'she', 'that',
  'the', 'their', 'them', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'with', 'would', 'you', 'your',
]);

const IDENTIFIER_TERMS = new Set(['account', 'api', 'credential', 'id', 'identifier', 'key', 'number', 'password', 'secret', 'ssn', 'token']);

interface VectorTableCounts {
  episodic: number;
  semantic: number;
  procedural: number;
}

interface VectorCountsRow {
  episodic: number;
  semantic: number;
  procedural: number;
}

interface CountRow {
  c: number;
}

interface EpisodeWithSimilarity extends EpisodeRow {
  similarity: number;
}

interface SemanticWithSimilarity extends SemanticRow {
  similarity: number;
}

interface ProceduralWithSimilarity extends ProceduralRow {
  similarity: number;
}

interface RecallFilters {
  tags?: string[];
  sources?: string[];
  after?: string;
  before?: string;
  agent?: string;
}

function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function significantTokens(text: string): string[] {
  return tokenize(text).filter(token => !STOPWORDS.has(token));
}

function lexicalCoverage(query: string, content: string): number {
  const queryTokens = significantTokens(query);
  if (queryTokens.length === 0) return 1;
  const contentTokens = new Set(significantTokens(content));
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched++;
  }
  return matched / queryTokens.length;
}

function hasIdentifierIntent(query: string): boolean {
  const normalized = String(query || '').toLowerCase();
  const asksForValue = /\b(find|give|lookup|show|tell|what|which)\b/.test(normalized);
  const mentionsIdentifier = /\b(account number|api key|credential|id|identifier|key|number|passport number|password|secret|ssn|token)\b/.test(normalized);
  return asksForValue && mentionsIdentifier;
}

function hasIdentifierEvidence(content: string): boolean {
  const tokens = significantTokens(content);
  if (tokens.some(token => IDENTIFIER_TERMS.has(token))) {
    return true;
  }
  return /(?:\b\d{4,}\b|sk-[a-z0-9_-]+)/i.test(content);
}

function adjustedScore(query: string, entry: RecallResult): { score: number; coverage: number } {
  const coverage = lexicalCoverage(query, entry.content);
  let score = entry.score;

  if (hasIdentifierIntent(query) && !hasIdentifierEvidence(entry.content)) {
    score *= 0.02;
  }

  return { score, coverage };
}

function overlapRatio(contentA: string, contentB: string): number {
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

function reliabilityForRecallSource(source: string): number {
  if (source === 'consolidation') {
    return sourceReliability('tool-result');
  }
  return sourceReliability(source);
}

function shouldSuppressDuplicate(existing: RecallResult, candidate: RecallResult): boolean {
  const overlap = overlapRatio(existing.content, candidate.content);
  if (overlap < 0.5) return false;
  if (existing.type !== candidate.type) return false;
  const existingReliability = reliabilityForRecallSource(existing.source);
  const candidateReliability = reliabilityForRecallSource(candidate.source);
  if (existingReliability < candidateReliability) return false;
  if (existingReliability - candidateReliability < 0.2) return false;
  return existing.score >= candidate.score * 0.95;
}

function applyResultGuards(query: string, results: RecallResult[], limit: number): RecallResult[] {
  const identifierIntent = hasIdentifierIntent(query);
  const rescored = results
    .map(entry => {
      const { score, coverage } = adjustedScore(query, entry);
      return { ...entry, score, lexicalCoverage: coverage };
    })
    .filter(entry => !identifierIntent || entry.score > 0.05)
    .sort((a, b) => b.score - a.score);

  const accepted: RecallResult[] = [];
  for (const candidate of rescored) {
    if (accepted.some(existing => shouldSuppressDuplicate(existing, candidate))) {
      continue;
    }
    accepted.push(candidate);
    if (accepted.length >= limit) break;
  }

  return accepted;
}

function computeEpisodicConfidence(ep: EpisodeWithSimilarity, now: Date, confidenceConfig: Partial<ConfidenceConfig> = {}): number {
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

function computeSemanticConfidence(sem: SemanticWithSimilarity, now: Date, confidenceConfig: Partial<ConfidenceConfig> = {}): number {
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

function computeProceduralConfidence(proc: ProceduralWithSimilarity, now: Date, confidenceConfig: Partial<ConfidenceConfig> = {}): number {
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

function buildEpisodicEntry(
  ep: EpisodeWithSimilarity,
  confidence: number,
  score: number,
  includeProvenance: boolean,
  contextMatch?: number,
  moodCongruence?: number,
): RecallResult {
  const entry: RecallResult = {
    id: ep.id,
    content: ep.content,
    type: 'episodic',
    confidence,
    score,
    source: ep.source,
    agent: ep.agent ?? 'default',
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

function buildSemanticEntry(
  sem: SemanticWithSimilarity,
  confidence: number,
  score: number,
  includeProvenance: boolean,
): RecallResult {
  const entry: RecallResult = {
    id: sem.id,
    content: sem.content,
    type: 'semantic',
    confidence,
    score,
    source: 'consolidation',
    agent: sem.agent ?? 'default',
    state: sem.state,
    createdAt: sem.created_at,
  };
  if (includeProvenance) {
    entry.provenance = {
      evidenceEpisodeIds: safeJsonParse<string[]>(sem.evidence_episode_ids, []),
      evidenceCount: sem.evidence_count || 0,
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      consolidationCheckpoint: sem.consolidation_checkpoint || null,
    };
  }
  return entry;
}

function buildProceduralEntry(
  proc: ProceduralWithSimilarity,
  confidence: number,
  score: number,
  includeProvenance: boolean,
): RecallResult {
  const entry: RecallResult = {
    id: proc.id,
    content: proc.content,
    type: 'procedural',
    confidence,
    score,
    source: 'consolidation',
    agent: proc.agent ?? 'default',
    state: proc.state,
    createdAt: proc.created_at,
  };
  if (includeProvenance) {
    entry.provenance = {
      evidenceEpisodeIds: safeJsonParse<string[]>(proc.evidence_episode_ids, []),
      successCount: proc.success_count || 0,
      failureCount: proc.failure_count || 0,
      triggerConditions: proc.trigger_conditions || null,
    };
  }
  return entry;
}

function stateClause(includeDormant: boolean): string {
  return includeDormant
    ? "AND (v.state = 'active' OR v.state = 'context_dependent' OR v.state = 'dormant')"
    : "AND (v.state = 'active' OR v.state = 'context_dependent')";
}

function matchesDateFilters(createdAt: string, filters: RecallFilters): boolean {
  if (filters.after && createdAt <= filters.after) return false;
  if (filters.before && createdAt >= filters.before) return false;
  return true;
}

function safeKForCount(rowCount: number, candidateK: number): number {
  return rowCount > 0 ? Math.min(candidateK, rowCount) : 0;
}

function countVectorTable(db: Database.Database, table: 'vec_episodes' | 'vec_semantics' | 'vec_procedures'): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as CountRow).c || 0;
  } catch {
    return 0;
  }
}

function countVectorTables(db: Database.Database, searchTypes: MemoryType[]): VectorTableCounts {
  const selectEpisodic = searchTypes.includes('episodic')
    ? '(SELECT COUNT(*) FROM vec_episodes) AS episodic'
    : '0 AS episodic';
  const selectSemantic = searchTypes.includes('semantic')
    ? '(SELECT COUNT(*) FROM vec_semantics) AS semantic'
    : '0 AS semantic';
  const selectProcedural = searchTypes.includes('procedural')
    ? '(SELECT COUNT(*) FROM vec_procedures) AS procedural'
    : '0 AS procedural';
  try {
    const row = db.prepare(`
      SELECT
        ${selectEpisodic},
        ${selectSemantic},
        ${selectProcedural}
    `).get() as VectorCountsRow;
    return {
      episodic: row.episodic || 0,
      semantic: row.semantic || 0,
      procedural: row.procedural || 0,
    };
  } catch {
    return {
      episodic: searchTypes.includes('episodic') ? countVectorTable(db, 'vec_episodes') : 0,
      semantic: searchTypes.includes('semantic') ? countVectorTable(db, 'vec_semantics') : 0,
      procedural: searchTypes.includes('procedural') ? countVectorTable(db, 'vec_procedures') : 0,
    };
  }
}

function knnEpisodic(
  db: Database.Database,
  queryBuffer: Buffer,
  candidateK: number,
  tableCount: number,
  now: Date,
  minConfidence: number,
  includeProvenance: boolean,
  confidenceConfig: Partial<ConfidenceConfig>,
  filters: RecallFilters = {},
  includePrivate: boolean = false,
): RecallResult[] {
  const safeK = safeKForCount(tableCount, candidateK);
  if (safeK === 0) return [];
  const privateClause = includePrivate ? '' : 'AND e."private" = 0';
  const agentClause = filters.agent ? 'AND e.agent = ?' : '';
  const params = filters.agent ? [queryBuffer, safeK, filters.agent] : [queryBuffer, safeK];
  const rows = db.prepare(`
    SELECT e.*, (1.0 - v.distance) AS similarity
    FROM vec_episodes v
    JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND e.superseded_by IS NULL
      ${privateClause}
      ${agentClause}
  `).all(...params) as EpisodeWithSimilarity[];

  const results: RecallResult[] = [];
  for (const row of rows) {
    if (!matchesDateFilters(row.created_at, filters)) continue;
    if (filters.tags?.length) {
      const rowTags = safeJsonParse<string[]>(row.tags, []);
      if (!filters.tags.some(t => rowTags.includes(t))) continue;
    }
    if (filters.sources?.length && !filters.sources.includes(row.source)) continue;
    let confidence = computeEpisodicConfidence(row, now, confidenceConfig);

    let ctxMatch: number | undefined;
    if (confidenceConfig?.retrievalContext) {
      const encodingCtx = safeJsonParse<Record<string, string>>(row.context, {});
      ctxMatch = contextMatchRatio(encodingCtx, confidenceConfig.retrievalContext);
      confidence *= contextModifier(encodingCtx, confidenceConfig.retrievalContext, confidenceConfig.contextWeight);
      confidence = Math.max(0, Math.min(1, confidence));
    }

    let moodMatch: number | undefined;
    if (confidenceConfig?.retrievalMood) {
      const encodingAffect = safeJsonParse<{ valence?: number; arousal?: number }>(row.affect, {});
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

function knnSemantic(
  db: Database.Database,
  queryBuffer: Buffer,
  candidateK: number,
  tableCount: number,
  now: Date,
  minConfidence: number,
  includeProvenance: boolean,
  includeDormant: boolean,
  confidenceConfig: Partial<ConfidenceConfig>,
  filters: RecallFilters = {},
): { results: RecallResult[]; matchedIds: string[] } {
  const safeK = safeKForCount(tableCount, candidateK);
  if (safeK === 0) return { results: [], matchedIds: [] };
  const agentClause = filters.agent ? 'AND s.agent = ?' : '';
  const params = filters.agent ? [queryBuffer, safeK, filters.agent] : [queryBuffer, safeK];
  const rows = db.prepare(`
    SELECT s.*, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${stateClause(includeDormant)}
      ${agentClause}
  `).all(...params) as SemanticWithSimilarity[];

  const results: RecallResult[] = [];
  const matchedIds: string[] = [];
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

function knnProcedural(
  db: Database.Database,
  queryBuffer: Buffer,
  candidateK: number,
  tableCount: number,
  now: Date,
  minConfidence: number,
  includeProvenance: boolean,
  includeDormant: boolean,
  confidenceConfig: Partial<ConfidenceConfig>,
  filters: RecallFilters = {},
): { results: RecallResult[]; matchedIds: string[] } {
  const safeK = safeKForCount(tableCount, candidateK);
  if (safeK === 0) return { results: [], matchedIds: [] };
  const agentClause = filters.agent ? 'AND p.agent = ?' : '';
  const params = filters.agent ? [queryBuffer, safeK, filters.agent] : [queryBuffer, safeK];
  const rows = db.prepare(`
    SELECT p.*, (1.0 - v.distance) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${stateClause(includeDormant)}
      ${agentClause}
  `).all(...params) as ProceduralWithSimilarity[];

  const results: RecallResult[] = [];
  const matchedIds: string[] = [];
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

export async function* recallStream(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  query: string,
  options: RecallOptions & { confidenceConfig?: ConfidenceConfig; profile?: ProfileRecorder } = {},
): AsyncGenerator<RecallResult> {
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
    retrieval = 'hybrid',
  } = options;
  const profile = options.profile;

  const searchTypes: MemoryType[] = types || ['episodic', 'semantic', 'procedural'];
  const now = new Date();
  const hasFilters = tags?.length || sources?.length || after || before;
  const agentFilter = options.scope === 'agent' ? options.agent : undefined;
  const filters: RecallFilters = { tags, sources, after, before, agent: agentFilter };

  const allResults: RecallResult[] = [];

  // Vector pass — skipped entirely in 'keyword' mode. Still runs in 'hybrid'
  // (default) and 'vector' modes so the underlying similarity + confidence
  // scoring fires as before.
  if (retrieval !== 'keyword') {
    const queryVector = profile
      ? await profile.measure('recall.embedding', () => embeddingProvider.embed(query))
      : await embeddingProvider.embed(query);
    const queryBuffer = profile
      ? profile.measureSync('recall.vector_to_buffer', () => embeddingProvider.vectorToBuffer(queryVector))
      : embeddingProvider.vectorToBuffer(queryVector);
    const vectorCounts = profile
      ? profile.measureSync('recall.vector_counts', () => countVectorTables(db, searchTypes))
      : countVectorTables(db, searchTypes);
    const maxVectorCount = Math.max(vectorCounts.episodic, vectorCounts.semantic, vectorCounts.procedural);
    const candidateK = agentFilter
      ? maxVectorCount
      : hasFilters ? limit * 5 : limit * 3;

    if (searchTypes.includes('episodic')) {
      try {
        const episodic = profile
          ? profile.measureSync('recall.episodic_knn', () => knnEpisodic(
            db,
            queryBuffer,
            candidateK,
            vectorCounts.episodic,
            now,
            minConfidence,
            includeProvenance,
            confidenceConfig || {},
            filters,
            includePrivate,
          ))
          : knnEpisodic(db, queryBuffer, candidateK, vectorCounts.episodic, now, minConfidence, includeProvenance, confidenceConfig || {}, filters, includePrivate);
        allResults.push(...episodic);
      } catch {
        // A broken episodic index should not block semantic/procedural recall.
      }
    }

    if (searchTypes.includes('semantic')) {
      try {
        const { results: semResults, matchedIds: semIds } = profile
          ? profile.measureSync('recall.semantic_knn', () => knnSemantic(
            db,
            queryBuffer,
            candidateK,
            vectorCounts.semantic,
            now,
            minConfidence,
            includeProvenance,
            includeDormant,
            confidenceConfig || {},
            filters,
          ))
          : knnSemantic(db, queryBuffer, candidateK, vectorCounts.semantic, now, minConfidence, includeProvenance, includeDormant, confidenceConfig || {}, filters);
        allResults.push(...semResults);

        if (semIds.length > 0) {
          const nowISO = now.toISOString();
          const placeholders = semIds.map(() => '?').join(',');
          const updateSemantic = (): void => {
            db.prepare(
              `UPDATE semantics SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id IN (${placeholders})`
            ).run(nowISO, ...semIds);
          };
          if (profile) profile.measureSync('recall.semantic_reinforce', updateSemantic);
          else updateSemantic();
        }
      } catch {
        // A broken semantic index should not block other memory types.
      }
    }

    if (searchTypes.includes('procedural')) {
      try {
        const { results: procResults, matchedIds: procIds } = profile
          ? profile.measureSync('recall.procedural_knn', () => knnProcedural(
            db,
            queryBuffer,
            candidateK,
            vectorCounts.procedural,
            now,
            minConfidence,
            includeProvenance,
            includeDormant,
            confidenceConfig || {},
            filters,
          ))
          : knnProcedural(db, queryBuffer, candidateK, vectorCounts.procedural, now, minConfidence, includeProvenance, includeDormant, confidenceConfig || {}, filters);
        allResults.push(...procResults);

        if (procIds.length > 0) {
          const nowISO = now.toISOString();
          const placeholders = procIds.map(() => '?').join(',');
          const updateProcedural = (): void => {
            db.prepare(
              `UPDATE procedures SET retrieval_count = retrieval_count + 1, last_reinforced_at = ? WHERE id IN (${placeholders})`
            ).run(nowISO, ...procIds);
          };
          if (profile) profile.measureSync('recall.procedural_reinforce', updateProcedural);
          else updateProcedural();
        }
      } catch {
        // A broken procedural index should not block other memory types.
      }
    }
  }

  let resultsToGuard = allResults;

  if (retrieval !== 'vector') {
    const candidateK = agentFilter ? 10_000 : hasFilters ? limit * 5 : limit * 3;
    const ftsIds = profile
      ? profile.measureSync('recall.fts_lookup', () => ftsIdsByType(db, query, searchTypes, candidateK, agentFilter))
      : ftsIdsByType(db, query, searchTypes, candidateK, agentFilter);
    const fuse = (): RecallResult[] => fuseResults(db, {
      vectorResults: allResults,
      ftsIds,
      mode: retrieval,
      includePrivate,
      includeDormant,
      minConfidence,
      filters,
      agentFilter,
    });
    const fused = profile ? profile.measureSync('recall.fuse_results', fuse) : fuse();
    resultsToGuard = fused;
  }

  const top = profile
    ? profile.measureSync('recall.result_guards', () => applyResultGuards(query, resultsToGuard, limit))
    : applyResultGuards(query, resultsToGuard, limit);
  for (const entry of top) {
    yield entry;
  }
}

export async function recall(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  query: string,
  options: RecallOptions & { confidenceConfig?: ConfidenceConfig; profile?: ProfileRecorder } = {},
): Promise<RecallResult[]> {
  const results: RecallResult[] = [];
  for await (const entry of recallStream(db, embeddingProvider, query, options)) {
    results.push(entry);
  }
  return results;
}
