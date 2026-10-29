/**
 * Hybrid retrieval: vector KNN + FTS5 BM25, fused into one score per document.
 *
 * The two retrievers produce genuinely different kinds of signal. Vector
 * search already yields a continuous, confidence-aware score in [0, 1]
 * (similarity * confidence) — that's `baseScore`, used as-is. FTS5's bm25
 * rank has no comparable continuous scale, so it's converted to a
 * reciprocal-rank term and normalized against its own best-possible value
 * (rank 1): normalizedFtsRank = (k + 1) / (k + rank), which is 1.0 for the
 * top FTS hit and shrinks toward 0 for lower ranks. With both signals now on
 * the same [0, 1] scale, VECTOR_WEIGHT and FTS_WEIGHT set an honest tradeoff
 * instead of one term being numerically invisible next to the other:
 *     score(d) = baseScore(d) * VECTOR_WEIGHT + normalizedFtsRank(d) * FTS_WEIGHT
 * A document only vector finds maxes out at VECTOR_WEIGHT; a document only
 * FTS finds at rank 1 reaches FTS_WEIGHT. Since FTS_WEIGHT > VECTOR_WEIGHT,
 * an exact keyword/identifier match beats a merely-similar vector hit even
 * at the vector hit's best possible score — and a document both retrievers
 * surface combines both terms, so it outranks either one alone.
 *
 * Vector and keyword candidates share the same confidence and provenance
 * scoring; only their relevance signals differ.
 */

import Database from './sqlite.js';
import type {
  EpisodeRow,
  SemanticRow,
  ProceduralRow,
  MemoryType,
  RecallResult,
  RetrievalMode,
} from './types.js';
import {
  searchFTSEpisodes,
  searchFTSSemantics,
  searchFTSProcedures,
  sanitizeFTSQuery,
} from './fts.js';
import {
  scoreEpisodicRow,
  scoreSemanticRow,
  scoreProceduralRow,
  type RecallScoringOptions,
} from './recall-scoring.js';

const RRF_K = 60;
const VECTOR_WEIGHT = 0.3;
const FTS_WEIGHT = 0.7;

export function ftsIdsByType(
  db: Database,
  query: string,
  types: MemoryType[],
  limit: number,
  agentFilter: string | undefined = undefined,
  includeDormant: boolean = false,
): Map<MemoryType, string[]> {
  const sanitized = sanitizeFTSQuery(query);
  const out = new Map<MemoryType, string[]>();
  if (!sanitized) return out;
  if (types.includes('episodic')) {
    const hits = searchFTSEpisodes(db, sanitized, limit, agentFilter ?? null);
    out.set(
      'episodic',
      hits.map(h => h.id),
    );
  }
  if (types.includes('semantic')) {
    const hits = searchFTSSemantics(db, sanitized, limit, agentFilter ?? null, includeDormant);
    out.set(
      'semantic',
      hits.map(h => h.id),
    );
  }
  if (types.includes('procedural')) {
    const hits = searchFTSProcedures(db, sanitized, limit, agentFilter ?? null, includeDormant);
    out.set(
      'procedural',
      hits.map(h => h.id),
    );
  }
  return out;
}

function loadFtsOnlyEpisode(
  db: Database,
  id: string,
  includePrivate: boolean,
  filters: FuseFilters | undefined,
  agentFilter?: string,
  scoring: RecallScoringOptions = {},
): RecallResult | null {
  const row = db
    .prepare(
      `
    SELECT *
    FROM episodes WHERE id = ?
  `,
    )
    .get(id) as EpisodeRow | undefined;
  if (!row) return null;
  if (agentFilter && row.agent !== agentFilter) return null;
  if (row.superseded_by) return null;
  if (!includePrivate && row.private) return null;
  if (filters && !passesFilters(row, filters)) return null;
  return scoreEpisodicRow(row, 0, scoring);
}

function loadFtsOnlySemantic(
  db: Database,
  id: string,
  includePrivate: boolean,
  includeDormant: boolean,
  filters: FuseFilters | undefined,
  agentFilter?: string,
  scoring: RecallScoringOptions = {},
): RecallResult | null {
  const row = db
    .prepare(
      `
    SELECT *
    FROM semantics WHERE id = ?
  `,
    )
    .get(id) as SemanticRow | undefined;
  if (!row) return null;
  if (agentFilter && row.agent !== agentFilter) return null;
  if (!includePrivate && row.private) return null;
  const allowed = includeDormant
    ? ['active', 'context_dependent', 'dormant']
    : ['active', 'context_dependent'];
  if (!allowed.includes(row.state)) return null;
  if (filters && !passesDateFilters(row.created_at, filters)) return null;
  return scoreSemanticRow(row, 0, scoring);
}

function loadFtsOnlyProcedural(
  db: Database,
  id: string,
  includePrivate: boolean,
  includeDormant: boolean,
  filters: FuseFilters | undefined,
  agentFilter?: string,
  scoring: RecallScoringOptions = {},
): RecallResult | null {
  const row = db
    .prepare(
      `
    SELECT *
    FROM procedures WHERE id = ?
  `,
    )
    .get(id) as ProceduralRow | undefined;
  if (!row) return null;
  if (agentFilter && row.agent !== agentFilter) return null;
  if (!includePrivate && row.private) return null;
  const allowed = includeDormant
    ? ['active', 'context_dependent', 'dormant']
    : ['active', 'context_dependent'];
  if (!allowed.includes(row.state)) return null;
  if (filters && !passesDateFilters(row.created_at, filters)) return null;
  return scoreProceduralRow(row, 0, scoring);
}

export interface FuseFilters {
  tags?: string[];
  sources?: string[];
  after?: string;
  before?: string;
}

function passesDateFilters(createdAt: string | null | undefined, filters: FuseFilters): boolean {
  if (!createdAt) return true;
  if (filters.after && createdAt <= filters.after) return false;
  if (filters.before && createdAt >= filters.before) return false;
  return true;
}

function matchesTagFilters(rowTags: string[], requiredTags: string[] | undefined): boolean {
  if (!requiredTags?.length) return true;
  return requiredTags.every(tag => rowTags.includes(tag));
}

function passesFilters(row: EpisodeRow, filters: FuseFilters): boolean {
  if (!passesDateFilters(row.created_at, filters)) return false;
  if (filters.sources?.length && !filters.sources.includes(row.source)) return false;
  if (filters.tags?.length) {
    let rowTags: string[] = [];
    try {
      const parsed: unknown = row.tags ? JSON.parse(row.tags) : [];
      if (Array.isArray(parsed)) rowTags = parsed.map(String);
    } catch {
      rowTags = [];
    }
    if (!matchesTagFilters(rowTags, filters.tags)) return false;
  }
  return true;
}

export interface FuseInput extends RecallScoringOptions {
  vectorResults: RecallResult[];
  ftsIds: Map<MemoryType, string[]>;
  mode: RetrievalMode;
  includePrivate?: boolean;
  includeDormant?: boolean;
  minConfidence?: number;
  filters?: FuseFilters;
  agentFilter?: string;
}

export function fuseResults(db: Database, input: FuseInput): RecallResult[] {
  const { vectorResults, ftsIds, mode } = input;
  const includePrivate = input.includePrivate ?? false;
  const includeDormant = input.includeDormant ?? false;
  const minConfidence = input.minConfidence ?? 0;
  const scoring: RecallScoringOptions = {
    now: input.now ?? new Date(),
    confidenceConfig: input.confidenceConfig,
    includeProvenance: input.includeProvenance,
  };

  if (mode === 'vector') return vectorResults;

  const ranksByTypeId = new Map<string, { vrank?: number; frank?: number; type: MemoryType }>();

  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i]!;
    ranksByTypeId.set(r.id, { vrank: i + 1, type: r.type });
  }

  for (const [type, ids] of ftsIds.entries()) {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const existing = ranksByTypeId.get(id);
      if (existing) {
        existing.frank = i + 1;
      } else {
        ranksByTypeId.set(id, { frank: i + 1, type });
      }
    }
  }

  const vectorById = new Map<string, RecallResult>(vectorResults.map(r => [r.id, r]));
  const fused: RecallResult[] = [];

  for (const [id, ranks] of ranksByTypeId.entries()) {
    const existing = vectorById.get(id);

    if (mode === 'keyword' && ranks.frank === undefined) continue;

    let result: RecallResult | null = existing ?? null;
    if (!result) {
      if (ranks.type === 'episodic')
        result = loadFtsOnlyEpisode(
          db,
          id,
          includePrivate,
          input.filters,
          input.agentFilter,
          scoring,
        );
      else if (ranks.type === 'semantic')
        result = loadFtsOnlySemantic(
          db,
          id,
          includePrivate,
          includeDormant,
          input.filters,
          input.agentFilter,
          scoring,
        );
      else if (ranks.type === 'procedural')
        result = loadFtsOnlyProcedural(
          db,
          id,
          includePrivate,
          includeDormant,
          input.filters,
          input.agentFilter,
          scoring,
        );
      if (!result) continue;
    }
    if (result.confidence < minConfidence) continue;

    const frank = ranks.frank;

    let fusedScore: number;
    if (mode === 'keyword') {
      fusedScore = frank !== undefined ? 1 / (RRF_K + frank) : 0;
    } else {
      const baseScore = result.score ?? 0;
      // Only the FTS rank feeds this term. The vector side already has its
      // own continuous, confidence-aware score (baseScore) — folding vrank
      // into this term too would double-count vector relevance and make it
      // impossible for an FTS-only match to ever outrank a vector-only one.
      const normalizedFtsRank = frank !== undefined ? (RRF_K + 1) / (RRF_K + frank) : 0;
      fusedScore = baseScore * VECTOR_WEIGHT + normalizedFtsRank * FTS_WEIGHT;
    }

    fused.push({ ...result, score: fusedScore });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused;
}
