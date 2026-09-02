import Database from 'better-sqlite3';
import type {
  Affect,
  CausalParams,
  EmbeddingProvider,
  RedactionSummary,
  SourceType,
} from './types.js';
import { generateId } from './ulid.js';
import { sourceReliability } from './confidence.js';
import { arousalSalienceBoost } from './affect.js';
import { insertFTSEpisode } from './fts.js';
import type { ProfileRecorder } from './profile.js';
import { requireAgent } from './utils.js';
import { redact, type RedactionHit } from './redact.js';

export interface SanitizedEncodeFields {
  content: string;
  context: Record<string, string>;
  affect: Partial<Affect>;
}

export interface EncodeEpisodeOptions {
  profile?: ProfileRecorder;
  vector?: number[];
  onVector?: (vector: number[], buffer: Buffer) => void;
  onRedaction?: (summary: RedactionSummary) => void;
  /**
   * Hands back the post-redaction field values — what actually landed in the
   * row. Anything that continues past encode (grounding, background
   * validation, the contradiction prompt sent to a cloud LLM) must be built
   * from these, never from the caller's raw params.
   */
  onSanitized?: (sanitized: SanitizedEncodeFields) => void;
}

function mergeRedactionHits(...sets: RedactionHit[][]): RedactionHit[] {
  const counts = new Map<RedactionHit['class'], number>();
  for (const set of sets) {
    for (const hit of set) {
      counts.set(hit.class, (counts.get(hit.class) ?? 0) + hit.count);
    }
  }
  return [...counts.entries()].map(([cls, count]) => ({ class: cls, count }));
}

export async function encodeEpisode(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  {
    content,
    source,
    agent = 'default',
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
    agent?: string;
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
  if (!content || typeof content !== 'string')
    throw new Error('content must be a non-empty string');
  if (salience < 0 || salience > 1) throw new Error('salience must be between 0 and 1');
  if (tags && !Array.isArray(tags)) throw new Error('tags must be an array');
  const ownerAgent = requireAgent(agent);

  // Storage boundary: this is the primary ingestion path (memory_encode,
  // POST /v1/encode, Audrey.encode), so content/context/affect are always
  // filtered through redact() before they reach the episodes row, the FTS
  // index, or the embedding model. redact() is a no-op on ordinary prose.
  const contentResult = redact(content);
  const redactedContent = contentResult.text;

  const redactedContext: Record<string, string> = {};
  const contextHits: RedactionHit[] = [];
  for (const [key, value] of Object.entries(context)) {
    const valueResult = redact(value);
    redactedContext[key] = valueResult.text;
    contextHits.push(...valueResult.redactions);
  }

  let redactedAffect: Partial<Affect> = affect;
  let affectHits: RedactionHit[] = [];
  if (affect.label) {
    const labelResult = redact(affect.label);
    affectHits = labelResult.redactions;
    redactedAffect = { ...affect, label: labelResult.text };
  }

  const mergedHits = mergeRedactionHits(contentResult.redactions, contextHits, affectHits);
  const redactionSummary: RedactionSummary = {
    redacted: mergedHits.length > 0,
    classes: mergedHits.map(hit => hit.class),
    count: mergedHits.reduce((sum, hit) => sum + hit.count, 0),
  };
  options.onRedaction?.(redactionSummary);
  options.onSanitized?.({
    content: redactedContent,
    context: redactedContext,
    affect: redactedAffect,
  });

  const reliability = sourceReliability(source);
  const profile = options.profile;
  const vector =
    options.vector ??
    (profile
      ? await profile.measure('encode.embedding', () => embeddingProvider.embed(redactedContent))
      : await embeddingProvider.embed(redactedContent));
  const embeddingBuffer = profile
    ? profile.measureSync('encode.vector_to_buffer', () => embeddingProvider.vectorToBuffer(vector))
    : embeddingProvider.vectorToBuffer(vector);
  options.onVector?.(vector, embeddingBuffer);
  const id = generateId();
  const now = new Date().toISOString();

  const boost = arousalSalienceBoost(affect.arousal);
  // Clamp both ends — a sufficiently negative arousal boost can drive salience
  // below 0, which propagates as a negative confidence multiplier downstream.
  const effectiveSalience = Math.max(0, Math.min(1.0, salience + boost * arousalWeight));

  const insertAndLink = db.transaction(() => {
    db.prepare(
      `
      INSERT INTO episodes (
        id, content, embedding, source, agent, source_reliability, salience, context, affect,
        tags, causal_trigger, causal_consequence, created_at,
        embedding_model, embedding_version, supersedes, "private"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      redactedContent,
      embeddingBuffer,
      source,
      ownerAgent,
      reliability,
      effectiveSalience,
      JSON.stringify(redactedContext),
      JSON.stringify(redactedAffect),
      tags ? JSON.stringify(tags) : null,
      causal?.trigger || null,
      causal?.consequence || null,
      now,
      embeddingProvider.modelName,
      embeddingProvider.modelVersion,
      supersedes || null,
      isPrivate ? 1 : 0,
    );
    db.prepare(
      'INSERT INTO vec_episodes(id, agent, embedding, source, consolidated) VALUES (?, ?, ?, ?, ?)',
    ).run(id, ownerAgent, embeddingBuffer, source, BigInt(0));
    insertFTSEpisode(db, id, redactedContent, tags ?? null);
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
