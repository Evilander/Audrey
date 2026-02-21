export function interferenceModifier(interferenceCount, weight = 0.1) {
  return 1 / (1 + weight * interferenceCount);
}

export async function applyInterference(db, embeddingProvider, episodeId, { content }, config = {}) {
  const { enabled = true, k = 5, threshold = 0.6, weight = 0.1 } = config;

  if (!enabled) return [];

  const vector = await embeddingProvider.embed(content);
  const buffer = embeddingProvider.vectorToBuffer(vector);

  const semanticHits = db.prepare(`
    SELECT s.id, s.interference_count, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND (v.state = 'active' OR v.state = 'context_dependent')
  `).all(buffer, k);

  const proceduralHits = db.prepare(`
    SELECT p.id, p.interference_count, (1.0 - v.distance) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND (v.state = 'active' OR v.state = 'context_dependent')
  `).all(buffer, k);

  const affected = [];

  const updateSemantic = db.prepare('UPDATE semantics SET interference_count = ? WHERE id = ?');
  const updateProcedural = db.prepare('UPDATE procedures SET interference_count = ? WHERE id = ?');

  for (const hit of semanticHits) {
    if (hit.similarity < threshold) continue;
    const newCount = hit.interference_count + 1;
    updateSemantic.run(newCount, hit.id);
    affected.push({ id: hit.id, type: 'semantic', newCount, similarity: hit.similarity });
  }

  for (const hit of proceduralHits) {
    if (hit.similarity < threshold) continue;
    const newCount = hit.interference_count + 1;
    updateProcedural.run(newCount, hit.id);
    affected.push({ id: hit.id, type: 'procedural', newCount, similarity: hit.similarity });
  }

  return affected;
}
