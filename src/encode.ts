import Database from 'better-sqlite3';
import type { Affect, CausalParams, EmbeddingProvider, SourceType } from './types.js';
import { generateId } from './ulid.js';
import { sourceReliability } from './confidence.js';
import { arousalSalienceBoost } from './affect.js';
import { insertFTSEpisode } from './fts.js';
import type { ProfileRecorder } from './profile.js';

export interface EncodeEpisodeOptions {
  profile?: ProfileRecorder;
  vector?: number[];
  onVector?: (vector: number[], buffer: Buffer) => void;
}

export async function encodeEpisode(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  {
    content,
    source,
    salience = 0.5,
    causal,
    tags,
    supersedes,
    context = {},
    affect = {},
    arousalWeight = 0.3,
    private: isPrivate = false,
  }: {
    content: string;
    source: SourceType;
    salience?: number;
    causal?: CausalParams;
    tags?: string[];
    supersedes?: string;
    context?: Record<string, string>;
    affect?: Partial<Affect>;
    arousalWeight?: number;
    private?: boolean;
  },
  options: EncodeEpisodeOptions = {},
): Promise<string> {
  if (!content || typeof content !== 'string') throw new Error('content must be a non-empty string');
  if (salience < 0 || salience > 1) throw new Error('salience must be between 0 and 1');
  if (tags && !Array.isArray(tags)) throw new Error('tags must be an array');

  const reliability = sourceReliability(source);
  const profile = options.profile;
  const vector = options.vector ?? (profile
    ? await profile.measure('encode.embedding', () => embeddingProvider.embed(content))
    : await embeddingProvider.embed(content));
  const embeddingBuffer = profile
    ? profile.measureSync('encode.vector_to_buffer', () => embeddingProvider.vectorToBuffer(vector))
    : embeddingProvider.vectorToBuffer(vector);
  options.onVector?.(vector, embeddingBuffer);
  const id = generateId();
  const now = new Date().toISOString();

  const boost = arousalSalienceBoost(affect.arousal);
  const effectiveSalience = Math.min(1.0, salience + (boost * arousalWeight));

  const insertAndLink = db.transaction(() => {
    db.prepare(`
      INSERT INTO episodes (
        id, content, embedding, source, source_reliability, salience, context, affect,
        tags, causal_trigger, causal_consequence, created_at,
        embedding_model, embedding_version, supersedes, "private"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, content, embeddingBuffer, source, reliability, effectiveSalience,
      JSON.stringify(context),
      JSON.stringify(affect),
      tags ? JSON.stringify(tags) : null,
      causal?.trigger || null, causal?.consequence || null,
      now, embeddingProvider.modelName, embeddingProvider.modelVersion,
      supersedes || null,
      isPrivate ? 1 : 0,
    );
    db.prepare(
      'INSERT INTO vec_episodes(id, embedding, source, consolidated) VALUES (?, ?, ?, ?)'
    ).run(id, embeddingBuffer, source, BigInt(0));
    insertFTSEpisode(db, id, content, tags ?? null);
    if (supersedes) {
      db.prepare('UPDATE episodes SET superseded_by = ? WHERE id = ?').run(id, supersedes);
    }
  });

  if (profile) {
    profile.measureSync('encode.write_episode', () => insertAndLink());
  } else {
    insertAndLink();
  }
  return id;
}
