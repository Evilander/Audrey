import { computeConfidence, DEFAULT_HALF_LIVES } from './confidence.js';
import { daysBetween } from './utils.js';

export function applyDecay(db, { dormantThreshold = 0.1 } = {}) {
  const now = new Date();
  let totalEvaluated = 0;
  let transitionedToDormant = 0;

  const semantics = db.prepare(`
    SELECT id, supporting_count, contradicting_count, created_at,
           last_reinforced_at, retrieval_count
    FROM semantics WHERE state = 'active'
  `).all();

  const markDormantSem = db.prepare('UPDATE semantics SET state = ? WHERE id = ?');

  for (const sem of semantics) {
    totalEvaluated++;
    const ageDays = daysBetween(sem.created_at, now);
    const daysSinceRetrieval = sem.last_reinforced_at
      ? daysBetween(sem.last_reinforced_at, now)
      : ageDays;

    const confidence = computeConfidence({
      sourceType: 'tool-result',
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      ageDays,
      halfLifeDays: DEFAULT_HALF_LIVES.semantic,
      retrievalCount: sem.retrieval_count || 0,
      daysSinceRetrieval,
    });

    if (confidence < dormantThreshold) {
      markDormantSem.run('dormant', sem.id);
      transitionedToDormant++;
    }
  }

  const procedures = db.prepare(`
    SELECT id, success_count, failure_count, created_at,
           last_reinforced_at, retrieval_count
    FROM procedures WHERE state = 'active'
  `).all();

  const markDormantProc = db.prepare('UPDATE procedures SET state = ? WHERE id = ?');

  for (const proc of procedures) {
    totalEvaluated++;
    const ageDays = daysBetween(proc.created_at, now);
    const daysSinceRetrieval = proc.last_reinforced_at
      ? daysBetween(proc.last_reinforced_at, now)
      : ageDays;

    const confidence = computeConfidence({
      sourceType: 'tool-result',
      supportingCount: proc.success_count || 0,
      contradictingCount: proc.failure_count || 0,
      ageDays,
      halfLifeDays: DEFAULT_HALF_LIVES.procedural,
      retrievalCount: proc.retrieval_count || 0,
      daysSinceRetrieval,
    });

    if (confidence < dormantThreshold) {
      markDormantProc.run('dormant', proc.id);
      transitionedToDormant++;
    }
  }

  return { totalEvaluated, transitionedToDormant, timestamp: now.toISOString() };
}
