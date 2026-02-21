import { computeConfidence, DEFAULT_HALF_LIVES, salienceModifier } from './confidence.js';
import { interferenceModifier } from './interference.js';
import { daysBetween } from './utils.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ dormantThreshold?: number }} [options]
 * @returns {{ totalEvaluated: number, transitionedToDormant: number, timestamp: string }}
 */
export function applyDecay(db, { dormantThreshold = 0.1, halfLives } = {}) {
  const now = new Date();
  let totalEvaluated = 0;
  let transitionedToDormant = 0;

  const semantics = db.prepare(`
    SELECT id, supporting_count, contradicting_count, created_at,
           last_reinforced_at, retrieval_count, interference_count, salience
    FROM semantics WHERE state = 'active'
  `).all();

  const markDormantSem = db.prepare('UPDATE semantics SET state = ? WHERE id = ?');

  for (const sem of semantics) {
    totalEvaluated++;
    const ageDays = daysBetween(sem.created_at, now);
    const daysSinceRetrieval = sem.last_reinforced_at
      ? daysBetween(sem.last_reinforced_at, now)
      : ageDays;

    let confidence = computeConfidence({
      sourceType: 'tool-result',
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      ageDays,
      halfLifeDays: halfLives?.semantic ?? DEFAULT_HALF_LIVES.semantic,
      retrievalCount: sem.retrieval_count || 0,
      daysSinceRetrieval,
    });
    confidence *= interferenceModifier(sem.interference_count || 0);
    confidence *= salienceModifier(sem.salience ?? 0.5);
    confidence = Math.max(0, Math.min(1, confidence));

    if (confidence < dormantThreshold) {
      markDormantSem.run('dormant', sem.id);
      transitionedToDormant++;
    }
  }

  const procedures = db.prepare(`
    SELECT id, success_count, failure_count, created_at,
           last_reinforced_at, retrieval_count, interference_count, salience
    FROM procedures WHERE state = 'active'
  `).all();

  const markDormantProc = db.prepare('UPDATE procedures SET state = ? WHERE id = ?');

  for (const proc of procedures) {
    totalEvaluated++;
    const ageDays = daysBetween(proc.created_at, now);
    const daysSinceRetrieval = proc.last_reinforced_at
      ? daysBetween(proc.last_reinforced_at, now)
      : ageDays;

    let confidence = computeConfidence({
      sourceType: 'tool-result',
      supportingCount: proc.success_count || 0,
      contradictingCount: proc.failure_count || 0,
      ageDays,
      halfLifeDays: halfLives?.procedural ?? DEFAULT_HALF_LIVES.procedural,
      retrievalCount: proc.retrieval_count || 0,
      daysSinceRetrieval,
    });
    confidence *= interferenceModifier(proc.interference_count || 0);
    confidence *= salienceModifier(proc.salience ?? 0.5);
    confidence = Math.max(0, Math.min(1, confidence));

    if (confidence < dormantThreshold) {
      markDormantProc.run('dormant', proc.id);
      transitionedToDormant++;
    }
  }

  return { totalEvaluated, transitionedToDormant, timestamp: now.toISOString() };
}
