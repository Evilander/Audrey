import { dropVec0Tables, createVec0Tables } from './db.js';

export async function reembedAll(db, embeddingProvider, { dropAndRecreate = false } = {}) {
  if (dropAndRecreate) {
    dropVec0Tables(db);
    createVec0Tables(db, embeddingProvider.dimensions);
  }

  const episodes = db.prepare('SELECT id, content, source FROM episodes').all();
  const semantics = db.prepare('SELECT id, content, state FROM semantics').all();
  const procedures = db.prepare('SELECT id, content, state FROM procedures').all();

  const episodeEmbeddings = [];
  for (const ep of episodes) {
    const vector = await embeddingProvider.embed(ep.content);
    episodeEmbeddings.push({ id: ep.id, source: ep.source, buffer: embeddingProvider.vectorToBuffer(vector) });
  }

  const semanticEmbeddings = [];
  for (const sem of semantics) {
    const vector = await embeddingProvider.embed(sem.content);
    semanticEmbeddings.push({ id: sem.id, state: sem.state, buffer: embeddingProvider.vectorToBuffer(vector) });
  }

  const procedureEmbeddings = [];
  for (const proc of procedures) {
    const vector = await embeddingProvider.embed(proc.content);
    procedureEmbeddings.push({ id: proc.id, state: proc.state, buffer: embeddingProvider.vectorToBuffer(vector) });
  }

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
    for (const ep of episodeEmbeddings) {
      updateEpLegacy.run(ep.buffer, ep.id);
      deleteVecEp.run(ep.id);
      insertVecEp.run(ep.id, ep.buffer, ep.source, BigInt(0));
    }
    for (const sem of semanticEmbeddings) {
      updateSemLegacy.run(sem.buffer, sem.id);
      deleteVecSem.run(sem.id);
      insertVecSem.run(sem.id, sem.buffer, sem.state);
    }
    for (const proc of procedureEmbeddings) {
      updateProcLegacy.run(proc.buffer, proc.id);
      deleteVecProc.run(proc.id);
      insertVecProc.run(proc.id, proc.buffer, proc.state);
    }
  });
  writeTx();

  return { episodes: episodes.length, semantics: semantics.length, procedures: procedures.length };
}
