import { dropVec0Tables, createVec0Tables } from './db.js';

export async function reembedAll(db, embeddingProvider, { dropAndRecreate = false } = {}) {
  if (dropAndRecreate) {
    dropVec0Tables(db);
    createVec0Tables(db, embeddingProvider.dimensions);
  }

  const episodes = db.prepare('SELECT id, content, source FROM episodes').all();
  const semantics = db.prepare('SELECT id, content, state FROM semantics').all();
  const procedures = db.prepare('SELECT id, content, state FROM procedures').all();

  for (const ep of episodes) {
    const vector = await embeddingProvider.embed(ep.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare('UPDATE episodes SET embedding = ? WHERE id = ?').run(buffer, ep.id);
    const exists = db.prepare('SELECT id FROM vec_episodes WHERE id = ?').get(ep.id);
    if (!exists) {
      db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)').run(ep.id, buffer, ep.source, BigInt(0));
    } else {
      db.prepare('UPDATE vec_episodes SET embedding = ? WHERE id = ?').run(buffer, ep.id);
    }
  }

  for (const sem of semantics) {
    const vector = await embeddingProvider.embed(sem.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare('UPDATE semantics SET embedding = ? WHERE id = ?').run(buffer, sem.id);
    const exists = db.prepare('SELECT id FROM vec_semantics WHERE id = ?').get(sem.id);
    if (!exists) {
      db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)').run(sem.id, buffer, sem.state);
    } else {
      db.prepare('UPDATE vec_semantics SET embedding = ? WHERE id = ?').run(buffer, sem.id);
    }
  }

  for (const proc of procedures) {
    const vector = await embeddingProvider.embed(proc.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare('UPDATE procedures SET embedding = ? WHERE id = ?').run(buffer, proc.id);
    const exists = db.prepare('SELECT id FROM vec_procedures WHERE id = ?').get(proc.id);
    if (!exists) {
      db.prepare('INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)').run(proc.id, buffer, proc.state);
    } else {
      db.prepare('UPDATE vec_procedures SET embedding = ? WHERE id = ?').run(buffer, proc.id);
    }
  }

  return { episodes: episodes.length, semantics: semantics.length, procedures: procedures.length };
}
