export async function reembedAll(db, embeddingProvider) {
  const episodes = db.prepare('SELECT id, content, source FROM episodes').all();
  const semantics = db.prepare('SELECT id, content, state FROM semantics').all();
  const procedures = db.prepare('SELECT id, content, state FROM procedures').all();

  for (const ep of episodes) {
    const vector = await embeddingProvider.embed(ep.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare('UPDATE episodes SET embedding = ? WHERE id = ?').run(buffer, ep.id);
    db.prepare('INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)').run(ep.id, buffer, ep.source, BigInt(0));
  }

  for (const sem of semantics) {
    const vector = await embeddingProvider.embed(sem.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare('UPDATE semantics SET embedding = ? WHERE id = ?').run(buffer, sem.id);
    db.prepare('INSERT INTO vec_semantics(id, embedding, state) VALUES (?, ?, ?)').run(sem.id, buffer, sem.state);
  }

  for (const proc of procedures) {
    const vector = await embeddingProvider.embed(proc.content);
    const buffer = embeddingProvider.vectorToBuffer(vector);
    db.prepare('UPDATE procedures SET embedding = ? WHERE id = ?').run(buffer, proc.id);
    db.prepare('INSERT INTO vec_procedures(id, embedding, state) VALUES (?, ?, ?)').run(proc.id, buffer, proc.state);
  }

  return {
    episodes: episodes.length,
    semantics: semantics.length,
    procedures: procedures.length,
  };
}
