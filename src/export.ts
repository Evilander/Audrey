import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { safeJsonParse } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as { version: string };

interface ExportedEpisode {
  id: string;
  content: string;
  source: string;
  source_reliability: number;
  salience: number;
  context: unknown;
  affect: unknown;
  tags: unknown;
  causal_trigger: string | null;
  causal_consequence: string | null;
  created_at: string;
  embedding_model: string | null;
  embedding_version: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  consolidated: number;
  private: number;
}

interface EpisodeExportRow {
  id: string;
  content: string;
  source: string;
  source_reliability: number;
  salience: number;
  context: string;
  affect: string;
  tags: string | null;
  causal_trigger: string | null;
  causal_consequence: string | null;
  created_at: string;
  embedding_model: string | null;
  embedding_version: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  consolidated: number;
  private: number;
}

interface SemanticExportRow {
  id: string;
  content: string;
  state: string;
  conditions: string | null;
  evidence_episode_ids: string | null;
  evidence_count: number;
  supporting_count: number;
  contradicting_count: number;
  source_type_diversity: number;
  consolidation_checkpoint: string | null;
  embedding_model: string | null;
  embedding_version: string | null;
  consolidation_model: string | null;
  consolidation_prompt_hash: string | null;
  created_at: string;
  last_reinforced_at: string | null;
  retrieval_count: number;
  challenge_count: number;
  interference_count: number;
  salience: number;
}

interface ProcedureExportRow {
  id: string;
  content: string;
  state: string;
  trigger_conditions: string | null;
  evidence_episode_ids: string | null;
  success_count: number;
  failure_count: number;
  embedding_model: string | null;
  embedding_version: string | null;
  created_at: string;
  last_reinforced_at: string | null;
  retrieval_count: number;
  interference_count: number;
  salience: number;
}

interface ConsolidationRunExportRow {
  id: string;
  checkpoint_cursor: string | null;
  input_episode_ids: string | null;
  output_memory_ids: string | null;
  confidence_deltas: string | null;
  consolidation_model: string | null;
  consolidation_prompt_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
  status: string;
}

interface ConfigRow {
  key: string;
  value: string;
}

export function exportMemories(db: Database.Database): object {
  const episodes = (db.prepare(
    'SELECT id, content, source, source_reliability, salience, context, affect, tags, causal_trigger, causal_consequence, created_at, embedding_model, embedding_version, supersedes, superseded_by, consolidated, "private" FROM episodes'
  ).all() as EpisodeExportRow[]).map(ep => ({
    ...ep,
    tags: safeJsonParse(ep.tags, null),
    context: safeJsonParse(ep.context, null),
    affect: safeJsonParse(ep.affect, null),
  }));

  const semantics = (db.prepare(
    'SELECT id, content, state, conditions, evidence_episode_ids, evidence_count, supporting_count, contradicting_count, source_type_diversity, consolidation_checkpoint, embedding_model, embedding_version, consolidation_model, consolidation_prompt_hash, created_at, last_reinforced_at, retrieval_count, challenge_count, interference_count, salience FROM semantics'
  ).all() as SemanticExportRow[]).map(sem => ({
    ...sem,
    evidence_episode_ids: safeJsonParse(sem.evidence_episode_ids, []),
  }));

  const procedures = (db.prepare(
    'SELECT id, content, state, trigger_conditions, evidence_episode_ids, success_count, failure_count, embedding_model, embedding_version, created_at, last_reinforced_at, retrieval_count, interference_count, salience FROM procedures'
  ).all() as ProcedureExportRow[]).map(proc => ({
    ...proc,
    evidence_episode_ids: safeJsonParse(proc.evidence_episode_ids, []),
  }));

  const causalLinks = db.prepare('SELECT * FROM causal_links').all();

  const contradictions = db.prepare(
    'SELECT id, claim_a_id, claim_a_type, claim_b_id, claim_b_type, state, resolution, resolved_at, reopened_at, reopen_evidence_id, created_at FROM contradictions'
  ).all();

  const consolidationRuns = (db.prepare(
    'SELECT id, checkpoint_cursor, input_episode_ids, output_memory_ids, confidence_deltas, consolidation_model, consolidation_prompt_hash, started_at, completed_at, status FROM consolidation_runs'
  ).all() as ConsolidationRunExportRow[]).map(run => ({
    ...run,
    confidence_deltas: safeJsonParse(run.confidence_deltas, null),
    input_episode_ids: safeJsonParse(run.input_episode_ids, []),
    output_memory_ids: safeJsonParse(run.output_memory_ids, []),
  }));

  const consolidationMetrics = db.prepare(
    'SELECT id, run_id, min_cluster_size, similarity_threshold, episodes_evaluated, clusters_found, principles_extracted, created_at FROM consolidation_metrics'
  ).all();

  const configRows = db.prepare('SELECT key, value FROM audrey_config').all() as ConfigRow[];
  const config = Object.fromEntries(configRows.map(r => [r.key, r.value]));

  return {
    version: pkg.version,
    exportedAt: new Date().toISOString(),
    episodes,
    semantics,
    procedures,
    causalLinks,
    contradictions,
    consolidationRuns,
    consolidationMetrics,
    config,
  };
}
