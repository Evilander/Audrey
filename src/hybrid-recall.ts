/**
 * Hybrid retrieval: vector KNN + FTS5 BM25, fused via Reciprocal Rank Fusion.
 *
 * RRF is the simplest fusion that tends to hold up in practice:
 *     score(d) = sum_i 1 / (k + rank_i(d))
 * where each `i` is a retriever (vector, FTS) and `k` is a smoothing constant
 * (60 is the classic default). Documents that show up in only one retriever
 * still contribute; documents in both get additive boosts without either
 * retriever dominating.
 *
 * This module does NOT re-implement confidence scoring — vector candidates
 * arrive already scored; FTS-only candidates get an enrichment pass that
 * loads the underlying row and computes a reduced "base confidence" from
 * source reliability / support ratio. That's intentionally simpler than the
 * full KNN confidence pipeline for v1; the demo gets what it needs and the
 * capsule's categorization layer does the heavy interpretive lifting.
 */

import Database from 'better-sqlite3';
import type { MemoryType, RecallResult, RetrievalMode } from './types.js';
import {
  searchFTSEpisodes,
  searchFTSSemantics,
  searchFTSProcedures,
  sanitizeFTSQuery,
} from './fts.js';
import { sourceReliability } from './confidence.js';

const RRF_K = 60;
const VECTOR_WEIGHT = 0.3;
const FTS_WEIGHT = 0.7;

interface EpisodeFTSRow {
  id: string;
  content: string;
  source: string;
  source_reliability: number;
  created_at: string;
  superseded_by: string | null;
  state: string | null;
  private: number;
  tags: string | null;
}

interface SemanticFTSRow {
  id: string;
  content: string;
  state: string;
  evidence_count: number;
  supporting_count: number;
  contradicting_count: number;
  created_at: string;
}

interface ProceduralFTSRow {
  id: string;
  content: string;
  state: string;
  success_count: number;
  failure_count: number;
  created_at: string;
}

export function ftsIdsByType(
  db: Database.Database,
  query: string,
  types: MemoryType[],
  limit: number,
): Map<MemoryType, string[]> {
  const sanitized = sanitizeFTSQuery(query);
  const out = new Map<MemoryType, string[]>();
  if (!sanitized) return out;
  try {
    if (types.includes('episodic')) {
      const hits = searchFTSEpisodes(db, sanitized, limit);
      out.set('episodic', hits.map(h => h.id));
    }
    if (types.includes('semantic')) {
      const hits = searchFTSSemantics(db, sanitized, limit);
      out.set('semantic', hits.map(h => h.id));
    }
    if (types.includes('procedural')) {
      const hits = searchFTSProcedures(db, sanitized, limit);
      out.set('procedural', hits.map(h => h.id));
    }
  } catch {
    // FTS tables may not exist on very old DBs. Return whatever we collected so far.
  }
  return out;
}

function loadFtsOnlyEpisode(db: Database.Database, id: string, includePrivate: boolean, filters: FuseFilters | undefined): RecallResult | null {
  const row = db.prepare(`
    SELECT id, content, source, source_reliability, created_at, superseded_by, "private", tags
    FROM episodes WHERE id = ?
  `).get(id) as EpisodeFTSRow | undefined;
  if (!row) return null;
  if (row.superseded_by) return null;
  if (!includePrivate && row.private) return null;
  if (filters && !passesFilters(row, filters)) return null;
  return {
    id: row.id,
    content: row.content,
    type: 'episodic',
    confidence: row.source_reliability ?? sourceReliability(row.source as never),
    score: 0,
    source: row.source,
    createdAt: row.created_at,
  };
}

function loadFtsOnlySemantic(db: Database.Database, id: string, includeDormant: boolean, filters: FuseFilters | undefined): RecallResult | null {
  const row = db.prepare(`
    SELECT id, content, state, evidence_count, supporting_count, contradicting_count, created_at
    FROM semantics WHERE id = ?
  `).get(id) as SemanticFTSRow | undefined;
  if (!row) return null;
  const allowed = includeDormant
    ? ['active', 'context_dependent', 'dormant']
    : ['active', 'context_dependent'];
  if (!allowed.includes(row.state)) return null;
  if (filters && !passesDateFilters(row.created_at, filters)) return null;
  const denom = Math.max(1, row.evidence_count ?? 0);
  const confidence = Math.min(1, (row.supporting_count ?? 0) / denom);
  return {
    id: row.id,
    content: row.content,
    type: 'semantic',
    confidence,
    score: 0,
    source: 'consolidation',
    state: row.state as never,
    createdAt: row.created_at,
  };
}

function loadFtsOnlyProcedural(db: Database.Database, id: string, includeDormant: boolean, filters: FuseFilters | undefined): RecallResult | null {
  const row = db.prepare(`
    SELECT id, content, state, success_count, failure_count, created_at
    FROM procedures WHERE id = ?
  `).get(id) as ProceduralFTSRow | undefined;
  if (!row) return null;
  const allowed = includeDormant
    ? ['active', 'context_dependent', 'dormant']
    : ['active', 'context_dependent'];
  if (!allowed.includes(row.state)) return null;
  if (filters && !passesDateFilters(row.created_at, filters)) return null;
  const denom = Math.max(1, (row.success_count ?? 0) + (row.failure_count ?? 0));
  const confidence = Math.min(1, (row.success_count ?? 0) / denom);
  return {
    id: row.id,
    content: row.content,
    type: 'procedural',
    confidence,
    score: 0,
    source: 'consolidation',
    state: row.state as never,
    createdAt: row.created_at,
  };
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

function passesFilters(row: EpisodeFTSRow, filters: FuseFilters): boolean {
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
    if (!filters.tags.some(t => rowTags.includes(t))) return false;
  }
  return true;
}

export interface FuseInput {
  vectorResults: RecallResult[];
  ftsIds: Map<MemoryType, string[]>;
  mode: RetrievalMode;
  includePrivate?: boolean;
  includeDormant?: boolean;
  minConfidence?: number;
  filters?: FuseFilters;
}

export function fuseResults(db: Database.Database, input: FuseInput): RecallResult[] {
  const { vectorResults, ftsIds, mode } = input;
  const includePrivate = input.includePrivate ?? false;
  const includeDormant = input.includeDormant ?? false;
  const minConfidence = input.minConfidence ?? 0;

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
      if (ranks.type === 'episodic') result = loadFtsOnlyEpisode(db, id, includePrivate, input.filters);
      else if (ranks.type === 'semantic') result = loadFtsOnlySemantic(db, id, includeDormant, input.filters);
      else if (ranks.type === 'procedural') result = loadFtsOnlyProcedural(db, id, includeDormant, input.filters);
      if (!result) continue;
      if (result.confidence < minConfidence) continue;
    }

    const vrank = ranks.vrank;
    const frank = ranks.frank;
    const rrf =
      (vrank !== undefined ? 1 / (RRF_K + vrank) : 0) +
      (frank !== undefined ? 1 / (RRF_K + frank) : 0);

    let fusedScore: number;
    if (mode === 'keyword') {
      fusedScore = frank !== undefined ? 1 / (RRF_K + frank) : 0;
    } else {
      const baseScore = result.score ?? 0;
      fusedScore = baseScore * VECTOR_WEIGHT + rrf * FTS_WEIGHT;
    }

    fused.push({ ...result, score: fusedScore });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused;
}
