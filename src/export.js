import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { safeJsonParse } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

export function exportMemories(db) {
  const episodes = db.prepare(
    'SELECT id, content, source, source_reliability, salience, context, affect, tags, causal_trigger, causal_consequence, created_at, embedding_model, embedding_version, supersedes, superseded_by, consolidated, "private" FROM episodes'
  ).all().map(ep => ({
    ...ep,
    tags: safeJsonParse(ep.tags, null),
    context: safeJsonParse(ep.context, null),
    affect: safeJsonParse(ep.affect, null),
  }));

  const semantics = db.prepare(
    'SELECT id, content, state, conditions, evidence_episode_ids, evidence_count, supporting_count, contradicting_count, source_type_diversity, consolidation_checkpoint, embedding_model, embedding_version, consolidation_model, consolidation_prompt_hash, created_at, last_reinforced_at, retrieval_count, challenge_count, interference_count, salience FROM semantics'
  ).all().map(sem => ({
    ...sem,
    evidence_episode_ids: safeJsonParse(sem.evidence_episode_ids, []),
  }));

  const procedures = db.prepare(
    'SELECT id, content, state, trigger_conditions, evidence_episode_ids, success_count, failure_count, embedding_model, embedding_version, created_at, last_reinforced_at, retrieval_count, interference_count, salience FROM procedures'
  ).all().map(proc => ({
    ...proc,
    evidence_episode_ids: safeJsonParse(proc.evidence_episode_ids, []),
  }));

  const causalLinks = db.prepare('SELECT * FROM causal_links').all();

  const contradictions = db.prepare(
    'SELECT id, claim_a_id, claim_a_type, claim_b_id, claim_b_type, state, resolution, resolved_at, reopened_at, reopen_evidence_id, created_at FROM contradictions'
  ).all();

  const consolidationRuns = db.prepare(
    'SELECT id, checkpoint_cursor, input_episode_ids, output_memory_ids, confidence_deltas, consolidation_model, consolidation_prompt_hash, started_at, completed_at, status FROM consolidation_runs'
  ).all().map(run => ({
    ...run,
    confidence_deltas: safeJsonParse(run.confidence_deltas, null),
    input_episode_ids: safeJsonParse(run.input_episode_ids, []),
    output_memory_ids: safeJsonParse(run.output_memory_ids, []),
  }));

  const consolidationMetrics = db.prepare(
    'SELECT id, run_id, min_cluster_size, similarity_threshold, episodes_evaluated, clusters_found, principles_extracted, created_at FROM consolidation_metrics'
  ).all();

  const configRows = db.prepare('SELECT key, value FROM audrey_config').all();
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
