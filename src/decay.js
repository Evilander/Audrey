import { computeConfidence, DEFAULT_HALF_LIVES } from './confidence.js';

export function applyDecay(db, { dormantThreshold = 0.1 } = {}) {
  const now = new Date();
  let totalEvaluated = 0;
  let transitionedToDormant = 0;

  // Evaluate active semantic memories
  const semantics = db.prepare(`
    SELECT id, supporting_count, contradicting_count, created_at,
           last_reinforced_at, retrieval_count
    FROM semantics WHERE state = 'active'
  `).all();

  for (const sem of semantics) {
    totalEvaluated++;
    const ageDays = (now - new Date(sem.created_at)) / (1000 * 60 * 60 * 24);
    const daysSinceRetrieval = sem.last_reinforced_at
      ? (now - new Date(sem.last_reinforced_at)) / (1000 * 60 * 60 * 24)
      : ageDays;

    const confidence = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: sem.supporting_count || 0,
      contradictingCount: sem.contradicting_count || 0,
      ageDays,
      halfLifeDays: DEFAULT_HALF_LIVES.semantic,
      retrievalCount: sem.retrieval_count || 0,
      daysSinceRetrieval,
    });

    if (confidence < dormantThreshold) {
      db.prepare('UPDATE semantics SET state = ? WHERE id = ?').run('dormant', sem.id);
      transitionedToDormant++;
    }
  }

  // Evaluate active procedural memories
  const procedures = db.prepare(`
    SELECT id, success_count, failure_count, created_at,
           last_reinforced_at, retrieval_count
    FROM procedures WHERE state = 'active'
  `).all();

  for (const proc of procedures) {
    totalEvaluated++;
    const ageDays = (now - new Date(proc.created_at)) / (1000 * 60 * 60 * 24);
    const daysSinceRetrieval = proc.last_reinforced_at
      ? (now - new Date(proc.last_reinforced_at)) / (1000 * 60 * 60 * 24)
      : ageDays;

    const confidence = computeConfidence({
      sourceType: 'direct-observation',
      supportingCount: proc.success_count || 0,
      contradictingCount: proc.failure_count || 0,
      ageDays,
      halfLifeDays: DEFAULT_HALF_LIVES.procedural,
      retrievalCount: proc.retrieval_count || 0,
      daysSinceRetrieval,
    });

    if (confidence < dormantThreshold) {
      db.prepare('UPDATE procedures SET state = ? WHERE id = ?').run('dormant', proc.id);
      transitionedToDormant++;
    }
  }

  return { totalEvaluated, transitionedToDormant, timestamp: now.toISOString() };
}
