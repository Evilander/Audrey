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
