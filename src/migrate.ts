import Database from 'better-sqlite3';
import type { EmbeddingProvider, ReembedCounts } from './types.js';
import { dropVec0Tables, createVec0Tables } from './db.js';

interface EpisodeMigrateRow {
  id: string;
  content: string;
  source: string;
  consolidated: number;
}

interface SemanticMigrateRow {
  id: string;
  content: string;
  state: string;
}

interface ProcedureMigrateRow {
  id: string;
  content: string;
  state: string;
}

export async function reembedAll(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  { dropAndRecreate = false }: { dropAndRecreate?: boolean } = {},
): Promise<ReembedCounts> {
  if (dropAndRecreate) {
    dropVec0Tables(db);
    createVec0Tables(db, embeddingProvider.dimensions);
  }

  const episodes = db.prepare('SELECT id, content, source, consolidated FROM episodes').all() as EpisodeMigrateRow[];
  const semantics = db.prepare('SELECT id, content, state FROM semantics').all() as SemanticMigrateRow[];
  const procedures = db.prepare('SELECT id, content, state FROM procedures').all() as ProcedureMigrateRow[];

  const episodeVectors = episodes.length > 0
    ? await embeddingProvider.embedBatch(episodes.map(ep => ep.content))
    : [];
  const semanticVectors = semantics.length > 0
    ? await embeddingProvider.embedBatch(semantics.map(s => s.content))
    : [];
  const procedureVectors = procedures.length > 0
    ? await embeddingProvider.embedBatch(procedures.map(p => p.content))
    : [];

  const updateEpLegacy = db.prepare('UPDATE episodes SET embedding = ? WHERE id = ?');
  const deleteVecEp = db.prepare('DELETE FROM vec_episodes WHERE id = ?');
  const insertVecEp = db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)');

  const updateSemLegacy = db.prepare('UPDATE semantics SET embedding = ? WHERE id = ?');
  const deleteVecSem = db.prepare('DELETE FROM vec_semantics WHERE id = ?');
  const insertVecSem = db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)');

  const updateProcLegacy = db.prepare('UPDATE procedures SET embedding = ? WHERE id = ?');
  const deleteVecProc = db.prepare('DELETE FROM vec_procedures WHERE id = ?');
  const insertVecProc = db.prepare('INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)');

  const writeTx = db.transaction(() => {
    for (let i = 0; i < episodes.length; i++) {
      const buf = embeddingProvider.vectorToBuffer(episodeVectors[i]!);
      updateEpLegacy.run(buf, episodes[i]!.id);
      deleteVecEp.run(episodes[i]!.id);
      insertVecEp.run(episodes[i]!.id, buf, episodes[i]!.source, BigInt(episodes[i]!.consolidated ?? 0));
    }
    for (let i = 0; i < semantics.length; i++) {
      const buf = embeddingProvider.vectorToBuffer(semanticVectors[i]!);
      updateSemLegacy.run(buf, semantics[i]!.id);
      deleteVecSem.run(semantics[i]!.id);
      insertVecSem.run(semantics[i]!.id, buf, semantics[i]!.state);
    }
    for (let i = 0; i < procedures.length; i++) {
      const buf = embeddingProvider.vectorToBuffer(procedureVectors[i]!);
      updateProcLegacy.run(buf, procedures[i]!.id);
      deleteVecProc.run(procedures[i]!.id);
      insertVecProc.run(procedures[i]!.id, buf, procedures[i]!.state);
    }
  });
  writeTx();

  return { episodes: episodes.length, semantics: semantics.length, procedures: procedures.length };
}
