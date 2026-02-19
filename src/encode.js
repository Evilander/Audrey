import { generateId } from './ulid.js';
import { sourceReliability } from './confidence.js';

export async function encodeEpisode(db, embeddingProvider, {
  content,
  source,
  salience = 0.5,
  causal,
  tags,
  supersedes,
}) {
  const reliability = sourceReliability(source);
  const vector = await embeddingProvider.embed(content);
  const embeddingBuffer = embeddingProvider.vectorToBuffer(vector);
  const id = generateId();
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO episodes (
      id, content, embedding, source, source_reliability, salience,
      tags, causal_trigger, causal_consequence, created_at,
      embedding_model, embedding_version, supersedes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    id,
    content,
    embeddingBuffer,
    source,
    reliability,
    salience,
    tags ? JSON.stringify(tags) : null,
    causal?.trigger || null,
    causal?.consequence || null,
    now,
    embeddingProvider.modelName,
    embeddingProvider.modelVersion,
    supersedes || null,
  );

  if (supersedes) {
    db.prepare('UPDATE episodes SET superseded_by = ? WHERE id = ?').run(id, supersedes);
  }

  return id;
}
