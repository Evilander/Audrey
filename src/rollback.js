import { safeJsonParse } from './utils.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ id: string, checkpoint_cursor: string|null, input_episode_ids: string, output_memory_ids: string, started_at: string, completed_at: string|null, status: string }>}
 */
export function getConsolidationHistory(db) {
  return db.prepare(`
    SELECT id, checkpoint_cursor, input_episode_ids, output_memory_ids,
           started_at, completed_at, status
    FROM consolidation_runs ORDER BY started_at DESC
  `).all();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {{ rolledBackMemories: number, restoredEpisodes: number }}
 */
export function rollbackConsolidation(db, runId) {
  const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Consolidation run not found: ${runId}`);
  if (run.status === 'rolled_back') throw new Error(`Run already rolled back: ${runId}`);

  const outputIds = safeJsonParse(run.output_memory_ids, []);
  const inputIds = safeJsonParse(run.input_episode_ids, []);

  const doRollback = db.transaction(() => {
    const markSemantics = db.prepare('UPDATE semantics SET state = ? WHERE id = ?');
    const markProcedures = db.prepare('UPDATE procedures SET state = ? WHERE id = ?');
    for (const id of outputIds) {
      markSemantics.run('rolled_back', id);
      markProcedures.run('rolled_back', id);
    }
    const unmark = db.prepare('UPDATE episodes SET consolidated = 0 WHERE id = ?');
    for (const id of inputIds) { unmark.run(id); }
    db.prepare('UPDATE consolidation_runs SET status = ? WHERE id = ?').run('rolled_back', runId);
  });

  doRollback();
  return { rolledBackMemories: outputIds.length, restoredEpisodes: inputIds.length };
}
