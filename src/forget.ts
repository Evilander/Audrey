import Database from 'better-sqlite3';
import type { EmbeddingProvider, ForgetResult, MemoryType, PurgeResult } from './types.js';

interface IdRow {
  id: string;
}

interface SimilarityRow {
  id: string;
  similarity: number;
  type: MemoryType;
}

export function forgetMemory(
  db: Database.Database,
  id: string,
  { purge = false }: { purge?: boolean } = {},
): ForgetResult {
  const episode = db.prepare('SELECT id FROM episodes WHERE id = ?').get(id) as IdRow | undefined;
  if (episode) {
    if (purge) {
      db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(id);
      db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
    } else {
      db.prepare("UPDATE episodes SET superseded_by = 'forgotten' WHERE id = ?").run(id);
      db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(id);
    }
    return { id, type: 'episodic', purged: purge };
  }

  const semantic = db.prepare('SELECT id FROM semantics WHERE id = ?').get(id) as IdRow | undefined;
  if (semantic) {
    if (purge) {
      db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(id);
      db.prepare('DELETE FROM semantics WHERE id = ?').run(id);
    } else {
      db.prepare("UPDATE semantics SET state = 'superseded' WHERE id = ?").run(id);
      db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(id);
    }
    return { id, type: 'semantic', purged: purge };
  }

  const procedure = db.prepare('SELECT id FROM procedures WHERE id = ?').get(id) as IdRow | undefined;
  if (procedure) {
    if (purge) {
      db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(id);
      db.prepare('DELETE FROM procedures WHERE id = ?').run(id);
    } else {
      db.prepare("UPDATE procedures SET state = 'superseded' WHERE id = ?").run(id);
      db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(id);
    }
    return { id, type: 'procedural', purged: purge };
  }

  throw new Error(`Memory not found: ${id}`);
}

export function purgeMemories(db: Database.Database): PurgeResult {
  const deadEpisodes = db.prepare(
    'SELECT id FROM episodes WHERE superseded_by IS NOT NULL'
  ).all() as IdRow[];
  const deadSemantics = db.prepare(
    "SELECT id FROM semantics WHERE state IN ('superseded', 'dormant', 'rolled_back')"
  ).all() as IdRow[];
  const deadProcedures = db.prepare(
    "SELECT id FROM procedures WHERE state IN ('superseded', 'dormant', 'rolled_back')"
  ).all() as IdRow[];

  const purgeAll = db.transaction(() => {
    for (const row of deadEpisodes) {
      db.prepare('DELETE FROM vec_episodes WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM episodes WHERE id = ?').run(row.id);
    }
    for (const row of deadSemantics) {
      db.prepare('DELETE FROM vec_semantics WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM semantics WHERE id = ?').run(row.id);
    }
    for (const row of deadProcedures) {
      db.prepare('DELETE FROM vec_procedures WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM procedures WHERE id = ?').run(row.id);
    }
  });

  purgeAll();

  return {
    episodes: deadEpisodes.length,
    semantics: deadSemantics.length,
    procedures: deadProcedures.length,
  };
}

export async function forgetByQuery(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  query: string,
  { minSimilarity = 0.9, purge = false }: { minSimilarity?: number; purge?: boolean } = {},
): Promise<ForgetResult | null> {
  const queryVector = await embeddingProvider.embed(query);
  const queryBuffer = embeddingProvider.vectorToBuffer(queryVector);

  const candidates: SimilarityRow[] = [];

  const epMatch = db.prepare(`
    SELECT e.id, (1.0 - v.distance) AS similarity, 'episodic' AS type
    FROM vec_episodes v JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ? AND k = 1 AND e.superseded_by IS NULL
  `).get(queryBuffer) as SimilarityRow | undefined;
  if (epMatch) candidates.push(epMatch);

  const semMatch = db.prepare(`
    SELECT s.id, (1.0 - v.distance) AS similarity, 'semantic' AS type
    FROM vec_semantics v JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ? AND k = 1 AND (v.state = 'active' OR v.state = 'context_dependent')
  `).get(queryBuffer) as SimilarityRow | undefined;
  if (semMatch) candidates.push(semMatch);

  const procMatch = db.prepare(`
    SELECT p.id, (1.0 - v.distance) AS similarity, 'procedural' AS type
    FROM vec_procedures v JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ? AND k = 1 AND (v.state = 'active' OR v.state = 'context_dependent')
  `).get(queryBuffer) as SimilarityRow | undefined;
  if (procMatch) candidates.push(procMatch);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.similarity - a.similarity);
  const best = candidates[0]!;

  if (best.similarity < minSimilarity) return null;

  return forgetMemory(db, best.id, { purge });
}
