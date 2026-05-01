import Database from 'better-sqlite3';
import type { ConsolidationRunRow } from './types.js';
import { safeJsonParse } from './utils.js';

export function getConsolidationHistory(db: Database.Database): ConsolidationRunRow[] {
  return db.prepare(`
    SELECT id, checkpoint_cursor, input_episode_ids, output_memory_ids,
           started_at, completed_at, status
    FROM consolidation_runs ORDER BY started_at DESC
  `).all() as ConsolidationRunRow[];
}

export function rollbackConsolidation(
  db: Database.Database,
  runId: string,
): { rolledBackMemories: number; restoredEpisodes: number } {
  const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(runId) as ConsolidationRunRow | undefined;
  if (!run) throw new Error(`Consolidation run not found: ${runId}`);
  if (run.status === 'rolled_back') throw new Error(`Run already rolled back: ${runId}`);

  const outputIds = safeJsonParse<string[]>(run.output_memory_ids, []);
  const inputIds = safeJsonParse<string[]>(run.input_episode_ids, []);

  let rolledBackMemories = 0;
  let restoredEpisodes = 0;

  const doRollback = db.transaction(() => {
    const markSemantics = db.prepare('UPDATE semantics SET state = ? WHERE id = ?');
    const markProcedures = db.prepare('UPDATE procedures SET state = ? WHERE id = ?');
    for (const id of outputIds) {
      const semChanges = markSemantics.run('rolled_back', id).changes;
      const procChanges = markProcedures.run('rolled_back', id).changes;
      // An output ID lives in exactly one of the two tables, but we count whatever
      // actually transitioned so callers see a number that reflects the DB.
      rolledBackMemories += semChanges + procChanges;
    }
    const unmark = db.prepare('UPDATE episodes SET consolidated = 0 WHERE id = ?');
    for (const id of inputIds) {
      restoredEpisodes += unmark.run(id).changes;
    }
    db.prepare('UPDATE consolidation_runs SET status = ? WHERE id = ?').run('rolled_back', runId);
  });

  doRollback();
  return { rolledBackMemories, restoredEpisodes };
}
