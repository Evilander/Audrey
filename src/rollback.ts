import Database from './sqlite.js';
import type { ConsolidationRunRow } from './types.js';
import { safeJsonParse } from './utils.js';
import { refreshVectorRow } from './db.js';

export function getConsolidationHistory(db: Database): ConsolidationRunRow[] {
  return db
    .prepare(
      `
    SELECT id, checkpoint_cursor, input_episode_ids, output_memory_ids,
           started_at, completed_at, status
    FROM consolidation_runs ORDER BY started_at DESC
  `,
    )
    .all() as ConsolidationRunRow[];
}

export interface ConsolidationUndo {
  version: 1;
  changes: Array<{
    id: string;
    type: 'semantic' | 'procedural';
    created: boolean;
    addedEvidence: string[];
    previousReinforcedAt?: string | null;
    writtenReinforcedAt?: string | null;
  }>;
}

export function rollbackConsolidation(
  db: Database,
  runId: string,
): { rolledBackMemories: number; restoredEpisodes: number } {
  return db
    .transaction(() => {
      const run = db.prepare('SELECT * FROM consolidation_runs WHERE id = ?').get(runId) as
        ConsolidationRunRow | undefined;
      if (!run) throw new Error(`Consolidation run not found: ${runId}`);
      if (run.status === 'rolled_back') throw new Error(`Run already rolled back: ${runId}`);
      const outputIds = safeJsonParse<string[]>(run.output_memory_ids, []);
      const inputIds = safeJsonParse<string[]>(run.input_episode_ids, []);
      let undo = safeJsonParse<ConsolidationUndo | null>(run.rollback_data, null);
      if (!undo) {
        // Older versions did not save merge deltas. Refuse ambiguous merges;
        // retiring their outputs would destroy knowledge from an earlier run.
        undo = { version: 1, changes: [] };
        for (const id of outputIds) {
          for (const [table, type] of [
            ['semantics', 'semantic'],
            ['procedures', 'procedural'],
          ] as const) {
            const row = db
              .prepare(`SELECT evidence_episode_ids FROM ${table} WHERE id = ?`)
              .get(id) as { evidence_episode_ids: string | null } | undefined;
            if (!row) continue;
            const older = db
              .prepare(
                `SELECT id FROM consolidation_runs WHERE id != ? AND started_at <= ? AND json_valid(output_memory_ids) AND EXISTS (SELECT 1 FROM json_each(output_memory_ids) WHERE value = ?) LIMIT 1`,
              )
              .get(runId, run.started_at, id);
            if (
              older ||
              safeJsonParse<string[]>(row.evidence_episode_ids, []).some(
                evidence => !inputIds.includes(evidence),
              )
            ) {
              throw new Error('Cannot safely roll back a legacy merge without its undo journal');
            }
            undo.changes.push({ id, type, created: true, addedEvidence: [] });
          }
        }
      }
      const changedIds = new Set<string>();
      for (const change of [...undo.changes].reverse()) {
        const table = change.type === 'semantic' ? 'semantics' : 'procedures';
        if (change.created) {
          const dependent = db
            .prepare(
              `SELECT id FROM consolidation_runs WHERE id != ? AND status = 'completed' AND json_valid(output_memory_ids) AND EXISTS (SELECT 1 FROM json_each(output_memory_ids) WHERE value = ?) LIMIT 1`,
            )
            .get(runId, change.id);
          if (dependent)
            throw new Error('Roll back dependent consolidation runs before removing this output');
          if (
            db.prepare(`UPDATE ${table} SET state = 'rolled_back' WHERE id = ?`).run(change.id)
              .changes
          )
            changedIds.add(change.id);
        } else {
          const current = db
            .prepare(`SELECT evidence_episode_ids, last_reinforced_at FROM ${table} WHERE id = ?`)
            .get(change.id) as
            { evidence_episode_ids: string | null; last_reinforced_at: string | null } | undefined;
          if (!current) continue;
          const ids = safeJsonParse<string[]>(current.evidence_episode_ids, []);
          const remove = new Set(change.addedEvidence);
          const remaining = ids.filter(id => !remove.has(id));
          const removed = ids.length - remaining.length;
          const reinforcedAt =
            current.last_reinforced_at === change.writtenReinforcedAt
              ? (change.previousReinforcedAt ?? null)
              : current.last_reinforced_at;
          if (table === 'semantics') {
            const diversity = new Set(
              remaining.flatMap(id => {
                const row = db.prepare('SELECT source FROM episodes WHERE id = ?').get(id) as
                  { source: string } | undefined;
                return row ? [row.source] : [];
              }),
            ).size;
            db.prepare(
              `UPDATE semantics SET evidence_episode_ids = ?, evidence_count = ?, supporting_count = MAX(0, supporting_count - ?), source_type_diversity = ?, last_reinforced_at = ? WHERE id = ?`,
            ).run(
              JSON.stringify(remaining),
              remaining.length,
              removed,
              diversity,
              reinforcedAt,
              change.id,
            );
          } else {
            db.prepare(
              `UPDATE procedures SET evidence_episode_ids = ?, success_count = MAX(0, success_count - ?), last_reinforced_at = ? WHERE id = ?`,
            ).run(JSON.stringify(remaining), removed, reinforcedAt, change.id);
          }
          changedIds.add(change.id);
        }
        refreshVectorRow(db, table, change.id);
      }
      let restoredEpisodes = 0;
      for (const id of new Set(inputIds)) {
        restoredEpisodes += db
          .prepare('UPDATE episodes SET consolidated = 0 WHERE id = ?')
          .run(id).changes;
        refreshVectorRow(db, 'episodes', id);
      }
      db.prepare("UPDATE consolidation_runs SET status = 'rolled_back' WHERE id = ?").run(runId);
      return { rolledBackMemories: changedIds.size, restoredEpisodes };
    })
    .immediate();
}
