import Database from './sqlite.js';
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
import { refreshVectorRow } from './db.js';
import type { ProfileRecorder } from './profile.js';
import { requireAgent } from './utils.js';
import { redact, redactJson, type RedactionHit } from './redact.js';

export interface SanitizedEncodeFields {
  content: string;
  context: Record<string, string>;
  affect: Partial<Affect>;
  tags?: string[];
  causal?: CausalParams;
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

/**
 * Shape checks shared by the single and batch encode paths, so a batch is
 * rejected whole before any of its items is written.
 */
export function assertEncodeInput(input: {
  content: unknown;
  salience?: unknown;
  tags?: unknown;
  context?: unknown;
  supersedes?: unknown;
  causal?: unknown;
}): void {
  const { content, salience, tags, context, supersedes, causal } = input;
  if (!content || typeof content !== 'string')
    throw new Error('content must be a non-empty string');
  if (salience !== undefined && (typeof salience !== 'number' || salience < 0 || salience > 1))
    throw new Error('salience must be between 0 and 1');
  if (tags !== undefined && tags !== null && !Array.isArray(tags))
    throw new Error('tags must be an array');
  if (
    context !== undefined &&
    (!context ||
      typeof context !== 'object' ||
      Array.isArray(context) ||
      Object.values(context).some(value => typeof value !== 'string'))
  ) {
    throw new Error('context must be an object containing only string values');
  }
  if (supersedes !== undefined && (typeof supersedes !== 'string' || !supersedes.trim())) {
    throw new Error('supersedes must be a non-empty episode id');
  }
  if (
    causal !== undefined &&
    (!causal ||
      typeof causal !== 'object' ||
      Array.isArray(causal) ||
      [(causal as CausalParams).trigger, (causal as CausalParams).consequence].some(
        value => value !== undefined && typeof value !== 'string',
      ))
  ) {
    throw new Error('causal must contain string trigger and consequence values');
  }
}

export async function encodeEpisode(
  db: Database,
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
  assertEncodeInput({ content, salience, tags, context, supersedes, causal });
  const ownerAgent = requireAgent(agent);

  // Storage boundary: this is the primary ingestion path (memory_encode,
  // POST /v1/encode, Audrey.encode), so content/context/affect are always
  // filtered through redact() before they reach the episodes row, the FTS
  // index, or the embedding model. redact() is a no-op on ordinary prose.
  const contentResult = redact(content);
  const redactedContent = contentResult.text;

  const contextResult = redactJson(context);
  const redactedContext = contextResult.value as Record<string, string>;
  const contextHits = contextResult.redactions;

  let redactedAffect: Partial<Affect> = affect;
  let affectHits: RedactionHit[] = [];
  if (affect.label) {
    const labelResult = redact(affect.label);
    affectHits = labelResult.redactions;
    redactedAffect = { ...affect, label: labelResult.text };
  }

  const tagResults = tags?.map(tag => redact(tag));
  const redactedTags = tagResults?.map(result => result.text);
  const triggerResult = causal?.trigger ? redact(causal.trigger) : undefined;
  const consequenceResult = causal?.consequence ? redact(causal.consequence) : undefined;
  const redactedCausal = causal
    ? {
        trigger: triggerResult?.text,
        consequence: consequenceResult?.text,
      }
    : undefined;
  const mergedHits = mergeRedactionHits(
    contentResult.redactions,
    contextHits,
    affectHits,
    ...(tagResults?.map(result => result.redactions) ?? []),
    triggerResult?.redactions ?? [],
    consequenceResult?.redactions ?? [],
  );
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
    tags: redactedTags,
    causal: redactedCausal,
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
    if (
      supersedes &&
      !db.prepare('SELECT id FROM episodes WHERE id = ? AND agent = ?').get(supersedes, ownerAgent)
    ) {
      throw new Error('supersedes must identify an episode owned by the acting agent');
    }
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
      redactedTags ? JSON.stringify(redactedTags) : null,
      redactedCausal?.trigger || null,
      redactedCausal?.consequence || null,
      now,
      embeddingProvider.modelName,
      embeddingProvider.modelVersion,
      supersedes || null,
      isPrivate ? 1 : 0,
    );
    db.prepare(
      'INSERT INTO vec_episodes(id, agent, embedding, source, consolidated) VALUES (?, ?, ?, ?, ?)',
    ).run(id, ownerAgent, embeddingBuffer, source, BigInt(0));
    insertFTSEpisode(db, id, redactedContent, redactedTags ?? null);
    if (supersedes) {
      db.prepare('UPDATE episodes SET superseded_by = ? WHERE id = ? AND agent = ?').run(
        id,
        supersedes,
        ownerAgent,
      );
      refreshVectorRow(db, 'episodes', supersedes);
    }
  });

  if (profile) {
    profile.measureSync('encode.write_episode', () => insertAndLink.immediate());
  } else {
    insertAndLink.immediate();
  }
  return id;
}
