import Database from 'better-sqlite3';
import type { EmbeddingProvider, ForgetResult, MemoryType, PurgeResult } from './types.js';
import { deleteFTSEpisode, deleteFTSSemantic, deleteFTSProcedure } from './fts.js';
import { commandFromFailureRecord, profileShellCommand } from './shell-command.js';

interface IdRow {
  id: string;
}

interface DerivedRow {
  id: string;
  evidence_episode_ids: string | null;
}

interface SimilarityRow {
  id: string;
  similarity: number;
  type: MemoryType;
}

function deleteAnchors(db: Database.Database, memoryId: string): void {
  db.prepare('DELETE FROM memory_anchors WHERE memory_id = ?').run(memoryId);
}

/**
 * Purge every semantic/procedural row derived from the given episode. The
 * derived content was extracted from a cluster that included the purged
 * episode, so it can restate what the episode said — deleting the episode
 * alone would leave that text recallable forever. Surviving evidence
 * episodes are marked consolidated = 0 (and their vec rows refreshed) so
 * the next consolidation pass can re-derive a principle without the purged
 * content.
 */
function purgeDerivedFromEpisode(
  db: Database.Database,
  episodeId: string,
): { semantics: number; procedures: number } {
  const findDerived = (table: 'semantics' | 'procedures'): DerivedRow[] =>
    db
      .prepare(
        `
      SELECT id, evidence_episode_ids FROM ${table}
      WHERE json_valid(evidence_episode_ids)
        AND EXISTS (
          SELECT 1 FROM json_each(${table}.evidence_episode_ids) je WHERE je.value = ?
        )
    `,
      )
      .all(episodeId) as DerivedRow[];

  const survivors = new Set<string>();
  const collectSurvivors = (row: DerivedRow): void => {
    let ids: unknown;
    try {
      ids = row.evidence_episode_ids ? JSON.parse(row.evidence_episode_ids) : [];
    } catch {
      ids = [];
    }
    if (!Array.isArray(ids)) return;
    for (const evidenceId of ids) {
      if (typeof evidenceId === 'string' && evidenceId !== episodeId) {
        survivors.add(evidenceId);
      }
    }
  };

  let semantics = 0;
  for (const row of findDerived('semantics')) {
    collectSurvivors(row);
    db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM semantics WHERE id = ?').run(row.id);
    deleteFTSSemantic(db, row.id);
    deleteAnchors(db, row.id);
    semantics++;
  }

  let procedures = 0;
  for (const row of findDerived('procedures')) {
    collectSurvivors(row);
    db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM procedures WHERE id = ?').run(row.id);
    deleteFTSProcedure(db, row.id);
    deleteAnchors(db, row.id);
    procedures++;
  }

  if (survivors.size > 0) {
    const ids = [...survivors];
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE episodes SET consolidated = 0 WHERE id IN (${placeholders}) AND superseded_by IS NULL`,
    ).run(...ids);
    // clusterViaKNN filters on the vec aux column, so refresh it to match.
    // Forgotten survivors stay out: resurrecting their vec rows would make
    // them recallable again.
    db.prepare(`DELETE FROM vec_episodes WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(
      `
      INSERT INTO vec_episodes(id, agent, embedding, source, consolidated)
      SELECT id, agent, embedding, source, consolidated
      FROM episodes
      WHERE id IN (${placeholders}) AND embedding IS NOT NULL AND superseded_by IS NULL
    `,
    ).run(...ids);
  }

  return { semantics, procedures };
}

export function forgetMemory(
  db: Database.Database,
  id: string,
  { purge = false }: { purge?: boolean } = {},
): ForgetResult {
  const performForget = db.transaction((): ForgetResult => {
    const episode = db.prepare('SELECT id FROM episodes WHERE id = ?').get(id) as IdRow | undefined;
    if (episode) {
      if (purge) {
        // Cascade before deleting the episode so its id is still resolvable.
        const cascaded = purgeDerivedFromEpisode(db, id);
        db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(id);
        db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
        deleteFTSEpisode(db, id);
        deleteAnchors(db, id);
        return {
          id,
          type: 'episodic',
          purged: true,
          cascadedSemantics: cascaded.semantics,
          cascadedProcedures: cascaded.procedures,
        };
      }
      // Soft forget deliberately does not cascade: the episode row itself
      // survives as superseded, so derived rows hold nothing the database
      // no longer holds. Purge is the erasure path.
      db.prepare("UPDATE episodes SET superseded_by = 'forgotten' WHERE id = ?").run(id);
      db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(id);
      deleteFTSEpisode(db, id);
      return { id, type: 'episodic', purged: false };
    }

    const semantic = db.prepare('SELECT id FROM semantics WHERE id = ?').get(id) as
      IdRow | undefined;
    if (semantic) {
      if (purge) {
        db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(id);
        db.prepare('DELETE FROM semantics WHERE id = ?').run(id);
        deleteAnchors(db, id);
      } else {
        db.prepare("UPDATE semantics SET state = 'superseded' WHERE id = ?").run(id);
        db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(id);
      }
      deleteFTSSemantic(db, id);
      return { id, type: 'semantic', purged: purge };
    }

    const procedure = db.prepare('SELECT id FROM procedures WHERE id = ?').get(id) as
      IdRow | undefined;
    if (procedure) {
      if (purge) {
        db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(id);
        db.prepare('DELETE FROM procedures WHERE id = ?').run(id);
        deleteAnchors(db, id);
      } else {
        db.prepare("UPDATE procedures SET state = 'superseded' WHERE id = ?").run(id);
        db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(id);
      }
      deleteFTSProcedure(db, id);
      return { id, type: 'procedural', purged: purge };
    }

    throw new Error(`Memory not found: ${id}`);
  });

  return performForget();
}

export const READ_ONLY_PROBE_RETIREMENT_KEY = 'read_only_probe_failures_retired_at';
export const READ_ONLY_PROBE_RETIREMENT_MARKER = 'retired:read-only-probe';

/**
 * One-time cleanup for stores written before Autopilot stopped recording
 * read-only probes as failures. Every "Bash failed" episode whose command
 * classifies as read-only is soft-retired the way forgetMemory({purge:
 * false}) would: the row survives as superseded so nothing derived from it
 * dangles, and it leaves the vector index so recall never sees it again.
 * `audrey purge` removes the rows for good later, on the user's say-so.
 *
 * The stored command text had its newlines collapsed, so the classifier
 * runs in flattened mode: a side-effecting verb hiding in an argument
 * position keeps the row. Losing a genuine lesson is worse than keeping
 * a stale probe, so every doubt resolves toward keeping.
 */
export function retireReadOnlyProbeFailures(db: Database.Database): number {
  const done = db
    .prepare('SELECT value FROM audrey_config WHERE key = ?')
    .get(READ_ONLY_PROBE_RETIREMENT_KEY);
  if (done) return 0;
  const rows = db
    .prepare(
      `SELECT id, content FROM episodes
       WHERE source = 'tool-result'
         AND superseded_by IS NULL
         AND tags LIKE '%"tool-failure"%'
         AND content LIKE 'Tool failure: Bash failed while attempting: %'`,
    )
    .all() as Array<{ id: string; content: string }>;
  const retire = db.prepare('UPDATE episodes SET superseded_by = ? WHERE id = ?');
  const dropVector = db.prepare('DELETE FROM vec_episodes WHERE id = ?');
  const markDone = db.prepare(
    `INSERT INTO audrey_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  return db.transaction(() => {
    let retired = 0;
    for (const row of rows) {
      const command = commandFromFailureRecord(row.content);
      if (command === undefined) continue;
      if (!profileShellCommand(command, { flattened: true }).readOnly) continue;
      retire.run(READ_ONLY_PROBE_RETIREMENT_MARKER, row.id);
      dropVector.run(row.id);
      retired++;
    }
    markDone.run(READ_ONLY_PROBE_RETIREMENT_KEY, new Date().toISOString());
    return retired;
  })();
}

export function purgeMemories(db: Database.Database): PurgeResult {
  const selectDeadEpisodes = db.prepare('SELECT id FROM episodes WHERE superseded_by IS NOT NULL');
  const selectDeadSemantics = db.prepare(
    "SELECT id FROM semantics WHERE state IN ('superseded', 'dormant', 'rolled_back')",
  );
  const selectDeadProcedures = db.prepare(
    "SELECT id FROM procedures WHERE state IN ('superseded', 'dormant', 'rolled_back')",
  );

  let episodes = 0;
  let semantics = 0;
  let procedures = 0;

  // Read inside the transaction so we never delete something a concurrent
  // writer just resurrected, and so the returned counts match what we
  // actually purged.
  const purgeAll = db.transaction(() => {
    for (const row of selectDeadEpisodes.all() as IdRow[]) {
      // The soft-forget -> purge flow is the standard erasure path, so the
      // bulk purge must cascade exactly like forgetMemory's purge branch:
      // derived rows restating a dead episode's content go with it.
      const cascaded = purgeDerivedFromEpisode(db, row.id);
      semantics += cascaded.semantics;
      procedures += cascaded.procedures;
      db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM episodes WHERE id = ?').run(row.id);
      deleteFTSEpisode(db, row.id);
      deleteAnchors(db, row.id);
      episodes++;
    }
    for (const row of selectDeadSemantics.all() as IdRow[]) {
      db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM semantics WHERE id = ?').run(row.id);
      deleteFTSSemantic(db, row.id);
      deleteAnchors(db, row.id);
      semantics++;
    }
    for (const row of selectDeadProcedures.all() as IdRow[]) {
      db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM procedures WHERE id = ?').run(row.id);
      deleteFTSProcedure(db, row.id);
      deleteAnchors(db, row.id);
      procedures++;
    }
  });

  purgeAll();

  return { episodes, semantics, procedures };
}

export async function forgetByQuery(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  query: string,
  {
    minSimilarity = 0.9,
    purge = false,
    agent,
  }: { minSimilarity?: number; purge?: boolean; agent?: string } = {},
): Promise<ForgetResult | null> {
  const queryVector = await embeddingProvider.embed(query);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);

  const candidates: SimilarityRow[] = [];
  // Destructive lookups scope to the calling agent when one is given: a
  // query embedded by one agent must not be able to delete another agent's
  // closest memory. Unscoped remains available for explicit admin use.
  const agentParams = agent ? [agent, agent] : [];

  const epMatch = db
    .prepare(
      `
    SELECT e.id, (1.0 - v.distance) AS similarity, 'episodic' AS type
    FROM vec_episodes v JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ? AND k = 1 AND e.superseded_by IS NULL
      ${agent ? 'AND v.agent = ? AND e.agent = ?' : ''}
  `,
    )
    .get(queryBuffer, ...agentParams) as SimilarityRow | undefined;
  if (epMatch) candidates.push(epMatch);

  const semMatch = db
    .prepare(
      `
    SELECT s.id, (1.0 - v.distance) AS similarity, 'semantic' AS type
    FROM vec_semantics v JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ? AND k = 1 AND (s.state = 'active' OR s.state = 'context_dependent')
      ${agent ? 'AND v.agent = ? AND s.agent = ?' : ''}
  `,
    )
    .get(queryBuffer, ...agentParams) as SimilarityRow | undefined;
  if (semMatch) candidates.push(semMatch);

  const procMatch = db
    .prepare(
      `
    SELECT p.id, (1.0 - v.distance) AS similarity, 'procedural' AS type
    FROM vec_procedures v JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ? AND k = 1 AND (p.state = 'active' OR p.state = 'context_dependent')
      ${agent ? 'AND v.agent = ? AND p.agent = ?' : ''}
  `,
    )
    .get(queryBuffer, ...agentParams) as SimilarityRow | undefined;
  if (procMatch) candidates.push(procMatch);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.similarity - a.similarity);
  const best = candidates[0]!;

  if (best.similarity < minSimilarity) return null;

  return forgetMemory(db, best.id, { purge });
}
