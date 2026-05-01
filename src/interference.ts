import Database from 'better-sqlite3';
import type { EmbeddingProvider, InterferenceConfig } from './types.js';

export interface InterferenceHit {
  id: string;
  type: 'semantic' | 'procedural';
  newCount: number;
  similarity: number;
}

export function interferenceModifier(interferenceCount: number, weight: number = 0.1): number {
  return 1 / (1 + weight * interferenceCount);
}

export async function applyInterference(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  _episodeId: string,
  params: { content: string },
  config: InterferenceConfig = {},
  embedding?: { vector?: number[]; buffer?: Buffer },
): Promise<InterferenceHit[]> {
  // weight lives on InterferenceConfig but is consumed by interferenceModifier()
  // at recall/decay time, not here.
  const { enabled = true, k = 5, threshold = 0.6 } = config;

  if (!enabled) return [];

  const buffer = embedding?.buffer ?? embeddingProvider.vectorToBuffer(
    embedding?.vector ?? await embeddingProvider.embed(params.content)
  );

  // vec_semantics/vec_procedures carry a denormalized state column populated at
  // INSERT time only — it stays stale after UPDATE semantics SET state=...,
  // so always filter through the main table's state.
  const semanticHits = db.prepare(`
    SELECT s.id, s.interference_count, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND (s.state = 'active' OR s.state = 'context_dependent')
  `).all(buffer, k) as Array<{ id: string; interference_count: number; similarity: number }>;

  const proceduralHits = db.prepare(`
    SELECT p.id, p.interference_count, (1.0 - v.distance) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND (p.state = 'active' OR p.state = 'context_dependent')
  `).all(buffer, k) as Array<{ id: string; interference_count: number; similarity: number }>;

  const affected: InterferenceHit[] = [];

  const updateSemantic = db.prepare('UPDATE semantics SET interference_count = ? WHERE id = ?');
  const updateProcedural = db.prepare('UPDATE procedures SET interference_count = ? WHERE id = ?');

  const applyUpdates = db.transaction(() => {
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
  });

  applyUpdates();

  return affected;
}
