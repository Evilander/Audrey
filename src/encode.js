import { generateId } from './ulid.js';
import { sourceReliability } from './confidence.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./embedding.js').EmbeddingProvider} embeddingProvider
 * @param {{ content: string, source: string, salience?: number, causal?: { trigger?: string, consequence?: string }, tags?: string[], supersedes?: string }} params
 * @returns {Promise<string>}
 */
export async function encodeEpisode(db, embeddingProvider, {
  content,
  source,
  salience = 0.5,
  causal,
  tags,
  supersedes,
}) {
  if (!content || typeof content !== 'string') throw new Error('content must be a non-empty string');
  if (salience < 0 || salience > 1) throw new Error('salience must be between 0 and 1');
  if (tags && !Array.isArray(tags)) throw new Error('tags must be an array');

  const reliability = sourceReliability(source);
  const vector = await embeddingProvider.embed(content);
  const embeddingBuffer = embeddingProvider.vectorToBuffer(vector);
  const id = generateId();
  const now = new Date().toISOString();

  const insertAndLink = db.transaction(() => {
    db.prepare(`
      INSERT INTO episodes (
        id, content, embedding, source, source_reliability, salience,
        tags, causal_trigger, causal_consequence, created_at,
        embedding_model, embedding_version, supersedes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, content, embeddingBuffer, source, reliability, salience,
      tags ? JSON.stringify(tags) : null,
      causal?.trigger || null, causal?.consequence || null,
      now, embeddingProvider.modelName, embeddingProvider.modelVersion,
      supersedes || null,
    );
    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run(id, embeddingBuffer, source, BigInt(0));
    if (supersedes) {
      db.prepare('UPDATE episodes SET superseded_by = ? WHERE id = ?').run(id, supersedes);
    }
  });

  insertAndLink();
  return id;
}
