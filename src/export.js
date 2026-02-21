import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { safeJsonParse } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

export function exportMemories(db) {
  const episodes = db.prepare(
    'SELECT id, content, source, source_reliability, salience, tags, causal_trigger, causal_consequence, created_at, supersedes, superseded_by, consolidated FROM episodes'
  ).all().map(ep => ({
    ...ep,
    tags: safeJsonParse(ep.tags, null),
  }));

  const semantics = db.prepare(
    'SELECT id, content, state, conditions, evidence_episode_ids, evidence_count, supporting_count, contradicting_count, source_type_diversity, consolidation_checkpoint, created_at, last_reinforced_at, retrieval_count, challenge_count FROM semantics'
  ).all().map(sem => ({
    ...sem,
    evidence_episode_ids: safeJsonParse(sem.evidence_episode_ids, []),
  }));

  const procedures = db.prepare(
    'SELECT id, content, state, trigger_conditions, evidence_episode_ids, success_count, failure_count, created_at, last_reinforced_at, retrieval_count FROM procedures'
  ).all().map(proc => ({
    ...proc,
    evidence_episode_ids: safeJsonParse(proc.evidence_episode_ids, []),
  }));

  const causalLinks = db.prepare('SELECT * FROM causal_links').all();

  const contradictions = db.prepare(
    'SELECT id, claim_a_id, claim_a_type, claim_b_id, claim_b_type, state, resolution, resolved_at, reopened_at, reopen_evidence_id, created_at FROM contradictions'
  ).all();

  const consolidationRuns = db.prepare(
    'SELECT id, input_episode_ids, output_memory_ids, started_at, completed_at, status FROM consolidation_runs'
  ).all().map(run => ({
    ...run,
    input_episode_ids: safeJsonParse(run.input_episode_ids, []),
    output_memory_ids: safeJsonParse(run.output_memory_ids, []),
  }));

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
    config,
  };
}
