import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import type {
  AudreyConfig,
  ConfidenceConfig,
  ConsolidationOptions,
  ConsolidationResult,
  DecayResult,
  DreamResult,
  EmbeddingProvider,
  EncodeParams,
  ForgetResult,
  GreetingOptions,
  GreetingResult,
  HalfLives,
  IntrospectResult,
  LLMProvider,
  MemoryStatusResult,
  PublicRetrievalMode,
  PurgeResult,
  RecallOptions,
  RecallResult,
  ReembedCounts,
  ReflectMemory,
  ReflectResult,
  TruthResolution,
  ConsolidationRunRow,
  Affect,
} from './types.js';
import { createDatabase, closeDatabase } from './db.js';
import { createEmbeddingProvider } from './embedding.js';
import { createLLMProvider } from './llm.js';
import { encodeEpisode } from './encode.js';
import { recall as recallFn, recallStream as recallStreamFn } from './recall.js';
import { validateMemory } from './validate.js';
import { runConsolidation } from './consolidate.js';
import { applyDecay } from './decay.js';
import { rollbackConsolidation, getConsolidationHistory } from './rollback.js';
import { forgetMemory, forgetByQuery as forgetByQueryFn, purgeMemories } from './forget.js';
import { applyFeedback, type MemoryValidateInput, type MemoryValidateResult } from './feedback.js';
import { buildImpactReport, type ImpactReport } from './impact.js';
import { introspect as introspectFn } from './introspect.js';
import { buildContextResolutionPrompt, buildReflectionPrompt } from './prompts.js';
import { exportMemories } from './export.js';
import { importMemories } from './import.js';
import { suggestConsolidationParams as suggestParamsFn } from './adaptive.js';
import { reembedAll } from './migrate.js';
import { applyInterference } from './interference.js';
import { detectResonance } from './affect.js';
import { observeTool, type ObserveToolInput, type ObserveToolResult } from './tool-trace.js';
import {
  listEvents,
  countEvents,
  recentFailures,
  type EventQuery,
  type FailurePattern,
  type MemoryEvent,
} from './events.js';
import { buildCapsule, type CapsuleOptions, type MemoryCapsule } from './capsule.js';
import { buildPreflight, type MemoryPreflight, type PreflightOptions } from './preflight.js';
import { buildReflexReport, type MemoryReflexReport, type ReflexOptions } from './reflexes.js';
import {
  findPromotionCandidates,
  type FindCandidatesOptions,
  type PromotionCandidate,
  type PromotionTarget,
} from './promote.js';
import { renderAllRules, type RuleDoc } from './rules-compiler.js';
import { insertEvent } from './events.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as pathResolve, relative, isAbsolute as pathIsAbsolute } from 'node:path';
import { ProfileRecorder, type ProfileDiagnostics } from './profile.js';
import { performance } from 'node:perf_hooks';

interface ConfigRow {
  value: string;
}

interface CountRow {
  c: number;
}

interface ContentRow {
  content: string;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface StatusRow {
  status: string;
}

interface AffectRow {
  affect: string;
}

interface EncodedEmbedding {
  vector?: number[];
  buffer?: Buffer;
}

const REFLECTION_SOURCES = new Set<EncodeParams['source']>([
  'direct-observation',
  'told-by-user',
  'inference',
]);

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

function normalizeReflectionAffect(raw: unknown): Affect | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const valence = boundedNumber(record.valence, -1, 1);
  const arousal = boundedNumber(record.arousal, 0, 1);
  if (valence === undefined && arousal === undefined) return undefined;
  const affect: Affect = {};
  if (valence !== undefined) affect.valence = valence;
  if (arousal !== undefined) affect.arousal = arousal;
  const label = boundedString(record.label, 64);
  if (label) affect.label = label;
  return affect;
}

function normalizeReflectionMemory(raw: unknown): ReflectMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const content = boundedString(record.content, 5000);
  if (!content) return null;
  const source = record.source;
  if (typeof source !== 'string' || !REFLECTION_SOURCES.has(source as EncodeParams['source'])) {
    return null;
  }

  const memory: ReflectMemory = {
    content,
    source: source as EncodeParams['source'],
  };
  const salience = boundedNumber(record.salience, 0, 1);
  if (salience !== undefined) memory.salience = salience;
  if (Array.isArray(record.tags)) {
    const tags = record.tags
      .map(tag => boundedString(tag, 64))
      .filter((tag): tag is string => Boolean(tag))
      .slice(0, 20);
    if (tags.length > 0) memory.tags = tags;
  }
  if (typeof record.private === 'boolean') memory.private = record.private;
  const affect = normalizeReflectionAffect(record.affect);
  if (affect) memory.affect = affect;
  return memory;
}

function messagesToLegacyPrompt(messages: Array<{ role: string; content: string }>): string {
  return messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
}

export interface PostEncodeQueueDrainResult {
  drained: boolean;
  pendingIds: string[];
}

export interface PostEncodeQueueEvent {
  episodeId: string;
  queued_ms: number;
  processing_ms: number;
  total_ms: number;
  pending_consolidation_count: number;
}

interface GreetingEpisodeRow {
  id: string;
  content: string;
  source: string;
  tags: string | null;
  salience: number;
  created_at: string;
}

interface GreetingPrincipleRow {
  id: string;
  content: string;
  salience: number;
  created_at: string;
}

interface GreetingIdentityRow {
  id: string;
  content: string;
  tags: string | null;
  salience: number;
  created_at: string;
}

interface GreetingUnresolvedRow {
  id: string;
  content: string;
  tags: string | null;
  salience: number;
  created_at: string;
}

export class Audrey extends EventEmitter {
  agent: string;
  dataDir: string;
  embeddingProvider: EmbeddingProvider;
  db: Database.Database;
  llmProvider: LLMProvider | null;
  confidenceConfig: ConfidenceConfig;
  consolidationConfig: { minEpisodes: number };
  decayConfig: { dormantThreshold: number };
  interferenceConfig: { enabled: boolean; k: number; threshold: number; weight: number };
  contextConfig: { enabled: boolean; weight: number };
  affectConfig: {
    enabled: boolean;
    weight: number;
    arousalWeight: number;
    resonance: { enabled: boolean; k: number; threshold: number; affectThreshold: number };
  };
  defaultRetrievalMode: PublicRetrievalMode;
  autoReflect: boolean;

  private _migrationPending: boolean;
  private _autoConsolidateTimer: ReturnType<typeof setInterval> | null;
  private _closed: boolean;
  private _postEncodeQueue: Promise<void>;
  private _pendingPostEncodeIds: Set<string>;
  private _embeddingWarm: boolean;
  private _embeddingWarmupPromise: Promise<void> | null;
  private _warmupDurationMs: number | null;

  constructor({
    dataDir = './audrey-data',
    agent = 'default',
    embedding = { provider: 'mock', dimensions: 64 },
    llm,
    confidence = {},
    consolidation = {},
    decay = {},
    interference = {},
    context = {},
    affect = {},
    autoReflect = false,
  }: AudreyConfig = {}) {
    super();

    const dormantThreshold = decay.dormantThreshold ?? 0.1;
    if (dormantThreshold < 0 || dormantThreshold > 1) {
      throw new Error(`dormantThreshold must be between 0 and 1, got: ${dormantThreshold}`);
    }

    const minEpisodes = consolidation.minEpisodes ?? 3;
    if (!Number.isInteger(minEpisodes) || minEpisodes < 1) {
      throw new Error(`minEpisodes must be a positive integer, got: ${minEpisodes}`);
    }

    this.agent = agent;
    this.dataDir = dataDir;
    this.embeddingProvider = createEmbeddingProvider(embedding);
    const { db, migrated } = createDatabase(dataDir, { dimensions: this.embeddingProvider.dimensions });
    this.db = db;
    this._migrationPending = migrated;
    this.llmProvider = llm ? createLLMProvider(llm) : null;
    this.confidenceConfig = {
      weights: confidence.weights,
      halfLives: confidence.halfLives,
      sourceReliability: confidence.sourceReliability,
      interferenceWeight: interference.weight ?? 0.1,
      contextWeight: context.weight ?? 0.3,
      affectWeight: affect.weight ?? 0.2,
    };
    this.consolidationConfig = {
      minEpisodes: consolidation.minEpisodes || 3,
    };
    this.decayConfig = { dormantThreshold };
    this._autoConsolidateTimer = null;
    this._closed = false;
    this.interferenceConfig = {
      enabled: interference.enabled ?? true,
      k: interference.k ?? 5,
      threshold: interference.threshold ?? 0.6,
      weight: interference.weight ?? 0.1,
    };
    this.contextConfig = {
      enabled: context.enabled ?? true,
      weight: context.weight ?? 0.3,
    };
    this.affectConfig = {
      enabled: affect.enabled ?? true,
      weight: affect.weight ?? 0.2,
      arousalWeight: affect.arousalWeight ?? 0.3,
      resonance: {
        enabled: affect.resonance?.enabled ?? true,
        k: affect.resonance?.k ?? 5,
        threshold: affect.resonance?.threshold ?? 0.5,
        affectThreshold: affect.resonance?.affectThreshold ?? 0.6,
      },
    };
    this.defaultRetrievalMode = 'hybrid';
    this.autoReflect = autoReflect;
    this._postEncodeQueue = Promise.resolve();
    this._pendingPostEncodeIds = new Set();
    this._embeddingWarm = false;
    this._embeddingWarmupPromise = null;
    this._warmupDurationMs = null;
  }

  async _ensureMigrated(): Promise<void> {
    if (!this._migrationPending) return;
    const counts = await reembedAll(this.db, this.embeddingProvider);
    this._migrationPending = false;
    this.emit('migration', counts);
  }

  startEmbeddingWarmup(text = 'warmup'): Promise<void> {
    if (this._embeddingWarm) return Promise.resolve();
    if (this._embeddingWarmupPromise) return this._embeddingWarmupPromise;

    const startedAt = performance.now();
    this._embeddingWarmupPromise = (async () => {
      if (typeof this.embeddingProvider.ready === 'function') {
        await this.embeddingProvider.ready();
      }
      await this.embeddingProvider.embed(text);
      this._embeddingWarm = true;
    })()
      .catch(err => {
        this._emitQueueError(err);
        throw err;
      })
      .finally(() => {
        this._warmupDurationMs = roundMs(performance.now() - startedAt);
      });
    return this._embeddingWarmupPromise;
  }

  async _waitForEmbeddingWarmup(profile?: ProfileRecorder, spanName = 'embedding.wait_for_warmup'): Promise<void> {
    if (!this._embeddingWarmupPromise || this._embeddingWarm) return;
    const wait = async (): Promise<void> => {
      try {
        await this._embeddingWarmupPromise;
      } catch {
        // Warmup failure should not poison the foreground call; the foreground
        // embed path will surface provider errors if the provider is truly broken.
      }
    };
    if (profile) await profile.measure(spanName, wait);
    else await wait();
  }

  async _validateEncodedMemory(id: string, params: EncodeParams, embedding?: EncodedEmbedding): Promise<void> {
    const validation = await validateMemory(this.db, this.embeddingProvider, { id, ...params }, {
      llmProvider: this.llmProvider,
      embeddingVector: embedding?.vector,
      embeddingBuffer: embedding?.buffer,
    });
    if (validation.action === 'reinforced') {
      this.emit('reinforcement', {
        episodeId: id,
        targetId: validation.semanticId,
        similarity: validation.similarity,
      });
    } else if (validation.action === 'contradiction') {
      this.emit('contradiction', {
        episodeId: id,
        contradictionId: validation.contradictionId,
        semanticId: validation.semanticId,
        similarity: validation.similarity,
        resolution: validation.resolution,
      });
    }
  }

  async _runPostEncodeStage(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      this._emitQueueError(Object.assign(err instanceof Error ? err : new Error(String(err)), {
        stage: name,
      }));
    }
  }

  async _runPostEncode(id: string, params: EncodeParams, embedding: EncodedEmbedding): Promise<void> {
    if (this.interferenceConfig.enabled) {
      await this._runPostEncodeStage('interference', async () => {
        const affected = await applyInterference(this.db, this.embeddingProvider, id, params, this.interferenceConfig, embedding);
        if (affected.length > 0) {
          this.emit('interference', { episodeId: id, affected });
        }
      });
    }

    if (this.affectConfig.enabled && this.affectConfig.resonance.enabled && params.affect?.valence !== undefined) {
      await this._runPostEncodeStage('resonance', async () => {
        const echoes = await detectResonance(this.db, this.embeddingProvider, id, params, this.affectConfig.resonance, embedding);
        if (echoes.length > 0) {
          this.emit('resonance', { episodeId: id, affect: params.affect, echoes });
        }
      });
    }

    await this._runPostEncodeStage('validation', async () => {
      await this._validateEncodedMemory(id, params, embedding);
    });
  }

  _enqueuePostEncode(id: string, params: EncodeParams, embedding: EncodedEmbedding): Promise<void> {
    const enqueuedAt = performance.now();
    this._pendingPostEncodeIds.add(id);

    const run = async (): Promise<void> => {
      const startedAt = performance.now();
      try {
        if (!this._closed) {
          await this._runPostEncode(id, params, embedding);
        }
      } finally {
        const finishedAt = performance.now();
        this._pendingPostEncodeIds.delete(id);
        this.emit('post-encode-complete', {
          episodeId: id,
          queued_ms: roundMs(startedAt - enqueuedAt),
          processing_ms: roundMs(finishedAt - startedAt),
          total_ms: roundMs(finishedAt - enqueuedAt),
          pending_consolidation_count: this._pendingPostEncodeIds.size,
        } satisfies PostEncodeQueueEvent);
      }
    };

    const task = this._postEncodeQueue.then(run, run);
    this._postEncodeQueue = task.catch(err => {
      this._emitQueueError(err);
    });
    return task;
  }

  _emitQueueError(err: unknown): void {
    if (this.listenerCount('error') > 0) {
      // Caller has opted into error handling; let them route logging.
      this.emit('error', err);
      return;
    }
    // Standard EventEmitter idiom: log only when nobody is listening, so we
    // surface failures by default but don't double-log for apps with structured
    // error pipelines. The MCP server registers a logger listener at startup.
    const stage = (err as { stage?: string })?.stage;
    const prefix = stage ? `[audrey:post-encode:${stage}]` : '[audrey:post-encode]';
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`${prefix} ${message}`);
  }

  pendingConsolidationIds(): string[] {
    return [...this._pendingPostEncodeIds];
  }

  async drainPostEncodeQueue(timeoutMs = 5000): Promise<PostEncodeQueueDrainResult> {
    if (this._pendingPostEncodeIds.size === 0) {
      return { drained: true, pendingIds: [] };
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timed-out');
    const timeoutPromise = new Promise<typeof timedOut>(resolve => {
      timeout = setTimeout(() => resolve(timedOut), timeoutMs);
    });

    const result = await Promise.race([
      this._postEncodeQueue.then(() => true),
      timeoutPromise,
    ]);
    if (timeout) clearTimeout(timeout);

    const drained = result === true && this._pendingPostEncodeIds.size === 0;
    return {
      drained,
      pendingIds: this.pendingConsolidationIds(),
    };
  }

  async encode(params: EncodeParams): Promise<string> {
    return this._encodeInternal(params);
  }

  async encodeWithDiagnostics(params: EncodeParams): Promise<{ id: string; diagnostics: ProfileDiagnostics }> {
    const profile = new ProfileRecorder('memory_encode');
    const id = await this._encodeInternal(params, profile);
    return { id, diagnostics: profile.finish() };
  }

  async _encodeInternal(params: EncodeParams, profile?: ProfileRecorder): Promise<string> {
    await this._waitForEmbeddingWarmup(profile, 'encode.wait_for_warmup');
    if (profile) await profile.measure('encode.ensure_migrated', () => this._ensureMigrated());
    else await this._ensureMigrated();

    const encodeParams = { ...params, agent: params.agent ?? this.agent, arousalWeight: this.affectConfig.arousalWeight };
    let encodedVector: number[] | undefined;
    let encodedBuffer: Buffer | undefined;
    const id = profile
      ? await profile.measure('encode.episode', () => encodeEpisode(this.db, this.embeddingProvider, encodeParams, {
        profile,
        onVector: (vector, buffer) => {
          encodedVector = vector;
          encodedBuffer = buffer;
        },
      }))
      : await encodeEpisode(this.db, this.embeddingProvider, encodeParams, {
        onVector: (vector, buffer) => {
          encodedVector = vector;
          encodedBuffer = buffer;
        },
      });
    const encodedEmbedding: EncodedEmbedding = { vector: encodedVector, buffer: encodedBuffer };
    this.emit('encode', { id, ...params });
    const postEncodeTask = profile
      ? profile.measureSync('encode.enqueue_background', () => this._enqueuePostEncode(id, params, encodedEmbedding))
      : this._enqueuePostEncode(id, params, encodedEmbedding);
    if (params.waitForConsolidation) {
      if (profile) await profile.measure('encode.wait_for_consolidation', () => postEncodeTask);
      else await postEncodeTask;
    }
    return id;
  }

  async reflect(turns: { role: string; content: string }[]): Promise<ReflectResult> {
    if (!this.llmProvider) return { encoded: 0, memories: [], skipped: 'no llm provider' };

    const prompt = buildReflectionPrompt(turns);
    let raw: string;
    try {
      if (typeof this.llmProvider.complete === 'function') {
        raw = (await this.llmProvider.complete(prompt)).content;
      } else if (typeof this.llmProvider.chat === 'function') {
        raw = await this.llmProvider.chat(messagesToLegacyPrompt(prompt));
      } else {
        return { encoded: 0, memories: [], skipped: 'llm provider missing completion method' };
      }
    } catch (err) {
      this.emit('error', err);
      return { encoded: 0, memories: [], skipped: 'llm error' };
    }

    let parsed: { memories?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { encoded: 0, memories: [], skipped: 'invalid llm response' };
    }

    const memories = Array.isArray(parsed.memories)
      ? parsed.memories.map(normalizeReflectionMemory).filter((mem): mem is ReflectMemory => mem !== null).slice(0, 50)
      : [];
    let encoded = 0;
    for (const mem of memories) {
      try {
        await this.encode({
          content: mem.content,
          source: mem.source,
          salience: mem.salience,
          tags: mem.tags,
          private: mem.private ?? false,
          affect: mem.affect ?? undefined,
        });
        encoded++;
      } catch (err) {
        this.emit('error', err);
      }
    }

    return { encoded, memories };
  }

  async encodeBatch(paramsList: EncodeParams[]): Promise<string[]> {
    await this._waitForEmbeddingWarmup();
    await this._ensureMigrated();
    const ids: string[] = [];
    const tasks: Array<Promise<void>> = [];
    for (const params of paramsList) {
      const encodeParams = { ...params, agent: params.agent ?? this.agent, arousalWeight: this.affectConfig.arousalWeight };
      let encodedVector: number[] | undefined;
      let encodedBuffer: Buffer | undefined;
      const id = await encodeEpisode(this.db, this.embeddingProvider, encodeParams, {
        onVector: (vector, buffer) => {
          encodedVector = vector;
          encodedBuffer = buffer;
        },
      });
      ids.push(id);
      this.emit('encode', { id, ...params });
      const encodedEmbedding: EncodedEmbedding = { vector: encodedVector, buffer: encodedBuffer };
      tasks.push(this._enqueuePostEncode(id, params, encodedEmbedding));
    }

    if (paramsList.some(p => p.waitForConsolidation)) {
      await Promise.all(tasks);
    }

    return ids;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    return this._recallInternal(query, options);
  }

  async recallWithDiagnostics(
    query: string,
    options: RecallOptions = {},
  ): Promise<{ results: RecallResult[]; diagnostics: ProfileDiagnostics }> {
    const profile = new ProfileRecorder('memory_recall');
    const results = await this._recallInternal(query, options, profile);
    return { results, diagnostics: profile.finish() };
  }

  async _recallInternal(
    query: string,
    options: RecallOptions = {},
    profile?: ProfileRecorder,
  ): Promise<RecallResult[]> {
    await this._waitForEmbeddingWarmup(profile, 'recall.wait_for_warmup');
    if (profile) await profile.measure('recall.ensure_migrated', () => this._ensureMigrated());
    else await this._ensureMigrated();

    return recallFn(this.db, this.embeddingProvider, query, {
      ...options,
      agent: options.agent ?? this.agent,
      retrieval: options.retrieval ?? this.defaultRetrievalMode,
      confidenceConfig: this._recallConfig(options),
      profile,
    });
  }

  async *recallStream(query: string, options: RecallOptions = {}): AsyncGenerator<RecallResult> {
    await this._waitForEmbeddingWarmup();
    await this._ensureMigrated();
    yield* recallStreamFn(this.db, this.embeddingProvider, query, {
      ...options,
      agent: options.agent ?? this.agent,
      retrieval: options.retrieval ?? this.defaultRetrievalMode,
      confidenceConfig: this._recallConfig(options),
    });
  }

  _recallConfig(options: RecallOptions): ConfidenceConfig {
    let config: ConfidenceConfig = options.confidenceConfig ?? this.confidenceConfig;
    if (this.contextConfig.enabled && options.context) {
      config = { ...config, retrievalContext: options.context };
    }
    if (this.affectConfig.enabled && options.mood) {
      config = { ...config, retrievalMood: options.mood };
    }
    return config;
  }

  async consolidate(options: Partial<ConsolidationOptions> = {}): Promise<ConsolidationResult & { status: string }> {
    await this._ensureMigrated();
    const result = await runConsolidation(this.db, this.embeddingProvider, {
      minClusterSize: options.minClusterSize || this.consolidationConfig.minEpisodes,
      similarityThreshold: options.similarityThreshold || 0.80,
      agent: options.agent || this.agent,
      extractPrinciple: options.extractPrinciple,
      llmProvider: options.llmProvider || this.llmProvider || undefined,
    });
    const run = db_prepare_get_status(this.db, result.runId);
    const output = { ...result, status: run?.status || 'completed' };
    this.emit('consolidation', output);
    return output;
  }

  decay(options: { dormantThreshold?: number; halfLives?: Partial<HalfLives> } = {}): DecayResult {
    const result = applyDecay(this.db, {
      dormantThreshold: options.dormantThreshold || this.decayConfig.dormantThreshold,
      halfLives: options.halfLives ?? this.confidenceConfig.halfLives,
    });
    this.emit('decay', result);
    return result;
  }

  rollback(runId: string): { rolledBackMemories: number; restoredEpisodes: number } {
    const result = rollbackConsolidation(this.db, runId);
    this.emit('rollback', { runId, ...result });
    return result;
  }

  async resolveTruth(contradictionId: string): Promise<TruthResolution> {
    if (!this.llmProvider) {
      throw new Error('resolveTruth requires an LLM provider');
    }

    const contradiction = this.db.prepare(
      'SELECT * FROM contradictions WHERE id = ?'
    ).get(contradictionId) as { claim_a_id: string; claim_a_type: string; claim_b_id: string; claim_b_type: string } | undefined;
    if (!contradiction) throw new Error(`Contradiction not found: ${contradictionId}`);

    const claimA = this._loadClaimContent(contradiction.claim_a_id, contradiction.claim_a_type);
    const claimB = this._loadClaimContent(contradiction.claim_b_id, contradiction.claim_b_type);

    const messages = buildContextResolutionPrompt(claimA, claimB);
    const result = await this.llmProvider.json(messages) as TruthResolution;

    const now = new Date().toISOString();
    const newState = result.resolution === 'context_dependent' ? 'context_dependent' : 'resolved';
    this.db.prepare(`
      UPDATE contradictions SET state = ?, resolution = ?, resolved_at = ?
      WHERE id = ?
    `).run(newState, JSON.stringify(result), now, contradictionId);

    if (result.resolution === 'a_wins' && contradiction.claim_a_type === 'semantic') {
      this.db.prepare("UPDATE semantics SET state = 'active' WHERE id = ?").run(contradiction.claim_a_id);
    }
    if (result.resolution === 'b_wins' && contradiction.claim_b_type === 'semantic') {
      this.db.prepare("UPDATE semantics SET state = 'active' WHERE id = ?").run(contradiction.claim_b_id);
    }
    if (result.resolution === 'context_dependent') {
      if (contradiction.claim_a_type === 'semantic' && result.conditions) {
        this.db.prepare("UPDATE semantics SET state = 'context_dependent', conditions = ? WHERE id = ?")
          .run(JSON.stringify(result.conditions), contradiction.claim_a_id);
      }
    }

    return result;
  }

  _loadClaimContent(claimId: string, claimType: string): string {
    if (claimType === 'semantic') {
      const row = this.db.prepare('SELECT content FROM semantics WHERE id = ?').get(claimId) as ContentRow | undefined;
      if (!row) throw new Error(`Semantic memory not found: ${claimId}`);
      return row.content;
    } else if (claimType === 'episodic') {
      const row = this.db.prepare('SELECT content FROM episodes WHERE id = ?').get(claimId) as ContentRow | undefined;
      if (!row) throw new Error(`Episode not found: ${claimId}`);
      return row.content;
    }
    throw new Error(`Unknown claim type: ${claimType}`);
  }

  consolidationHistory(): ConsolidationRunRow[] {
    return getConsolidationHistory(this.db);
  }

  introspect(): IntrospectResult {
    return introspectFn(this.db);
  }

  memoryStatus(): MemoryStatusResult {
    const episodes = (this.db.prepare('SELECT COUNT(*) as c FROM episodes').get() as CountRow).c;
    const semantics = (this.db.prepare('SELECT COUNT(*) as c FROM semantics').get() as CountRow).c;
    const procedures = (this.db.prepare('SELECT COUNT(*) as c FROM procedures').get() as CountRow).c;
    const searchableEpisodes = (this.db.prepare('SELECT COUNT(*) as c FROM episodes WHERE embedding IS NOT NULL').get() as CountRow).c;
    const searchableSemantics = (this.db.prepare('SELECT COUNT(*) as c FROM semantics WHERE embedding IS NOT NULL').get() as CountRow).c;
    const searchableProcedures = (this.db.prepare('SELECT COUNT(*) as c FROM procedures WHERE embedding IS NOT NULL').get() as CountRow).c;

    let vecEpisodes = 0, vecSemantics = 0, vecProcedures = 0;
    try {
      vecEpisodes = (this.db.prepare('SELECT COUNT(*) as c FROM vec_episodes').get() as CountRow).c;
      vecSemantics = (this.db.prepare('SELECT COUNT(*) as c FROM vec_semantics').get() as CountRow).c;
      vecProcedures = (this.db.prepare('SELECT COUNT(*) as c FROM vec_procedures').get() as CountRow).c;
    } catch {
      // vec tables may not exist if no dimensions configured
    }

    const dimsRow = this.db.prepare("SELECT value FROM audrey_config WHERE key = 'dimensions'").get() as ConfigRow | undefined;
    const dimensions = dimsRow ? parseInt(dimsRow.value, 10) : null;
    const versionRow = this.db.prepare("SELECT value FROM audrey_config WHERE key = 'schema_version'").get() as ConfigRow | undefined;
    const schemaVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    const device = this.embeddingProvider._actualDevice
      ?? this.embeddingProvider.device
      ?? null;

    const healthy = episodes === vecEpisodes
      && semantics === vecSemantics
      && procedures === vecProcedures;
    const reembedRecommended = searchableEpisodes !== vecEpisodes
      || searchableSemantics !== vecSemantics
      || searchableProcedures !== vecProcedures;

    return {
      episodes,
      vec_episodes: vecEpisodes,
      semantics,
      vec_semantics: vecSemantics,
      procedures,
      vec_procedures: vecProcedures,
      searchable_episodes: searchableEpisodes,
      searchable_semantics: searchableSemantics,
      searchable_procedures: searchableProcedures,
      dimensions,
      schema_version: schemaVersion,
      device: device ?? null,
      healthy,
      reembed_recommended: reembedRecommended,
      pending_consolidation_count: this._pendingPostEncodeIds.size,
      embedding_warm: this._embeddingWarm,
      warmup_duration_ms: this._warmupDurationMs,
      default_retrieval_mode: this.defaultRetrievalMode,
    };
  }

  async greeting({ context, recentLimit = 10, principleLimit = 5, identityLimit = 5, scope = 'agent' }: GreetingOptions = {}): Promise<GreetingResult> {
    const agentClause = scope === 'agent' ? 'AND agent = ?' : '';
    const agentParam = scope === 'agent' ? [this.agent] : [];
    const recent = this.db.prepare(
      `SELECT id, content, source, tags, salience, created_at FROM episodes WHERE "private" = 0 ${agentClause} ORDER BY created_at DESC LIMIT ?`
    ).all(...agentParam, recentLimit) as GreetingEpisodeRow[];

    const principles = this.db.prepare(
      `SELECT id, content, salience, created_at FROM semantics WHERE state = ? ${agentClause} ORDER BY salience DESC LIMIT ?`
    ).all('active', ...agentParam, principleLimit) as GreetingPrincipleRow[];

    const identity = this.db.prepare(
      `SELECT id, content, tags, salience, created_at FROM episodes WHERE "private" = 1 ${agentClause} ORDER BY created_at DESC LIMIT ?`
    ).all(...agentParam, identityLimit) as GreetingIdentityRow[];

    const unresolved = this.db.prepare(
      `SELECT id, content, tags, salience, created_at FROM episodes WHERE tags LIKE '%unresolved%' AND salience > 0.3 ${agentClause} ORDER BY created_at DESC LIMIT 10`
    ).all(...agentParam) as GreetingUnresolvedRow[];

    const rawAffectRows = this.db.prepare(
      `SELECT affect FROM episodes WHERE affect IS NOT NULL AND affect != '{}' ${agentClause} ORDER BY created_at DESC LIMIT 20`
    ).all(...agentParam) as AffectRow[];

    const affectParsed = rawAffectRows
      .map(r => { try { return JSON.parse(r.affect) as Affect; } catch { return null; } })
      .filter((a): a is Affect => a !== null && a.valence !== undefined);

    let mood: { valence: number; arousal: number; samples: number };
    if (affectParsed.length === 0) {
      mood = { valence: 0, arousal: 0, samples: 0 };
    } else {
      const sumV = affectParsed.reduce((s, a) => s + (a.valence ?? 0), 0);
      const sumA = affectParsed.reduce((s, a) => s + (a.arousal ?? 0), 0);
      mood = {
        valence: sumV / affectParsed.length,
        arousal: sumA / affectParsed.length,
        samples: affectParsed.length,
      };
    }

    const result: GreetingResult = { recent, principles, mood, unresolved, identity };

    if (context) {
      result.contextual = await this.recall(context, { limit: 5, includePrivate: true, scope });
    }

    return result;
  }

  async dream(options: {
    minClusterSize?: number;
    similarityThreshold?: number;
    dormantThreshold?: number;
  } = {}): Promise<DreamResult> {
    await this._ensureMigrated();

    const consolidation = await this.consolidate({
      minClusterSize: options.minClusterSize,
      similarityThreshold: options.similarityThreshold,
    });

    const decay = this.decay({
      dormantThreshold: options.dormantThreshold,
    });

    const stats = this.introspect();

    const result: DreamResult = {
      consolidation,
      decay,
      stats,
    };

    this.emit('dream', result);
    return result;
  }

  export(): object {
    return exportMemories(this.db);
  }

  async import(snapshot: unknown): Promise<void> {
    return importMemories(this.db, this.embeddingProvider, snapshot);
  }

  startAutoConsolidate(intervalMs: number, options: Partial<ConsolidationOptions> = {}): void {
    if (intervalMs < 1000) {
      throw new Error('Auto-consolidation interval must be at least 1000ms');
    }
    if (this._autoConsolidateTimer) {
      throw new Error('Auto-consolidation is already running');
    }
    this._autoConsolidateTimer = setInterval(() => {
      this.consolidate(options).catch(err => this.emit('error', err));
    }, intervalMs);
    if (typeof this._autoConsolidateTimer.unref === 'function') {
      this._autoConsolidateTimer.unref();
    }
  }

  stopAutoConsolidate(): void {
    if (this._autoConsolidateTimer) {
      clearInterval(this._autoConsolidateTimer);
      this._autoConsolidateTimer = null;
    }
  }

  suggestConsolidationParams(): { minClusterSize: number; similarityThreshold: number; confidence: string } {
    return suggestParamsFn(this.db);
  }

  validate(input: MemoryValidateInput): MemoryValidateResult | null {
    const result = applyFeedback(this.db, input);
    if (result) {
      // Audit row in memory_events so audrey impact can show
      // helpful-vs-wrong breakdown over a window. Outcome is mapped onto the
      // events-table enum: helpful → succeeded, wrong → failed, used → unknown.
      // The original outcome string is preserved in metadata.
      const eventOutcome = input.outcome === 'helpful' ? 'succeeded'
        : input.outcome === 'wrong' ? 'failed'
        : 'unknown';
      insertEvent(this.db, {
        eventType: 'Validate',
        source: 'memory_validate',
        actorAgent: this.agent,
        outcome: eventOutcome,
        redactionState: 'clean',
        metadata: {
          memory_id: result.id,
          memory_type: result.type,
          outcome: input.outcome,
          salience_after: result.salience,
          usage_count_after: result.usageCount,
        },
      });
      this.emit('validate', result);
    }
    return result;
  }

  impact(options: { windowDays?: number; limit?: number } = {}): ImpactReport {
    return buildImpactReport(this.db, options.windowDays ?? 7, options.limit ?? 5);
  }

  forget(id: string, options: { purge?: boolean } = {}): ForgetResult {
    const result = forgetMemory(this.db, id, options);
    this.emit('forget', result);
    return result;
  }

  async forgetByQuery(query: string, options: { minSimilarity?: number; purge?: boolean } = {}): Promise<ForgetResult | null> {
    await this._ensureMigrated();
    const result = await forgetByQueryFn(this.db, this.embeddingProvider, query, options);
    if (result) this.emit('forget', result);
    return result;
  }

  purge(): PurgeResult {
    const result = purgeMemories(this.db);
    this.emit('purge', result);
    return result;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.stopAutoConsolidate();
    if (this._pendingPostEncodeIds.size > 0) {
      // Sync close() can't await; emit a clear signal so callers can spot data loss.
      // Use closeAsync() (preferred) or call drainPostEncodeQueue() before close() to avoid this.
      console.error(
        `[audrey] close() called with ${this._pendingPostEncodeIds.size} pending post-encode tasks ` +
        `(use closeAsync() or await drainPostEncodeQueue() first to avoid losing consolidation work)`,
      );
    }
    closeDatabase(this.db);
  }

  async closeAsync(timeoutMs = 5000): Promise<PostEncodeQueueDrainResult | undefined> {
    if (this._closed) return undefined;
    let result: PostEncodeQueueDrainResult | undefined;
    if (this._pendingPostEncodeIds.size > 0) {
      result = await this.drainPostEncodeQueue(timeoutMs);
    }
    this._closed = true;
    this.stopAutoConsolidate();
    closeDatabase(this.db);
    return result;
  }

  async waitForIdle(): Promise<void> {
    await this._postEncodeQueue;
  }

  observeTool(input: ObserveToolInput): ObserveToolResult {
    const result = observeTool(this.db, {
      ...input,
      actorAgent: input.actorAgent ?? this.agent,
    });
    this.emit('tool-observed', result.event);
    return result;
  }

  listEvents(query: EventQuery = {}): MemoryEvent[] {
    return listEvents(this.db, query);
  }

  countEvents(query: EventQuery = {}): number {
    return countEvents(this.db, query);
  }

  recentFailures(options: { since?: string; limit?: number } = {}): FailurePattern[] {
    return recentFailures(this.db, options);
  }

  async capsule(query: string, options: CapsuleOptions = {}): Promise<MemoryCapsule> {
    const capsule = await buildCapsule(this, query, options);
    this.emit('capsule', capsule);
    return capsule;
  }

  async preflight(action: string, options: PreflightOptions = {}): Promise<MemoryPreflight> {
    const preflight = await buildPreflight(this, action, options);
    this.emit('preflight', preflight);
    return preflight;
  }

  async reflexes(action: string, options: ReflexOptions = {}): Promise<MemoryReflexReport> {
    const report = await buildReflexReport(this, action, options);
    this.emit('reflexes', report);
    return report;
  }

  findPromotionCandidates(options: FindCandidatesOptions = {}): PromotionCandidate[] {
    return findPromotionCandidates(this.db, options);
  }

  async promote(options: PromoteOptions = {}): Promise<PromoteResult> {
    const target: PromotionTarget = options.target ?? 'claude-rules';
    if (target !== 'claude-rules') {
      throw new Error(`promote target "${target}" is not implemented yet. PR 4 v1 ships claude-rules only.`);
    }

    const candidates = findPromotionCandidates(this.db, {
      minConfidence: options.minConfidence,
      minEvidence: options.minEvidence,
      limit: options.limit,
      target,
    });

    const dryRun = options.dryRun ?? !options.yes;
    const projectDir = pathResolve(options.projectDir ?? process.cwd());
    // Guard against malicious project_dir from MCP/HTTP callers writing
    // .claude/rules/*.md to arbitrary locations — those files are read by
    // Claude Code on the next session, making this a persistent
    // prompt-injection vector. By default the path must be under cwd or one
    // of the explicit AUDREY_PROMOTE_ROOTS entries.
    if (!dryRun) {
      const allowedRoots = [pathResolve(process.cwd())];
      const extra = process.env.AUDREY_PROMOTE_ROOTS;
      if (extra) {
        for (const root of extra.split(/[:;]/).map(s => s.trim()).filter(Boolean)) {
          allowedRoots.push(pathResolve(root));
        }
      }
      const isUnderAllowedRoot = allowedRoots.some(root => {
        const rel = relative(root, projectDir);
        return rel === '' || (!rel.startsWith('..') && !pathIsAbsolute(rel));
      });
      if (!isUnderAllowedRoot) {
        throw new Error(
          `promote: refusing to write to ${projectDir} — path is outside cwd and AUDREY_PROMOTE_ROOTS. ` +
          `Set AUDREY_PROMOTE_ROOTS=<path1>:<path2> to allow additional locations.`,
        );
      }
    }
    const promotedAt = new Date().toISOString();
    const docs = renderAllRules(candidates, promotedAt);

    const applied: PromotionWriteResult[] = [];

    if (!dryRun) {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const doc = docs[i]!;
        const absolutePath = join(projectDir, doc.relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        const overwritten = existsSync(absolutePath);
        writeFileSync(absolutePath, doc.body, 'utf-8');

        insertEvent(this.db, {
          eventType: 'Promotion',
          source: 'promote-command',
          actorAgent: this.agent,
          toolName: target,
          outcome: 'succeeded',
          cwd: projectDir,
          fileFingerprints: [doc.relativePath],
          redactionState: 'clean',
          metadata: {
            memory_ids: [candidate.memory_id],
            memory_type: candidate.memory_type,
            candidate_id: candidate.candidate_id,
            confidence: Number(candidate.confidence.toFixed(3)),
            evidence_count: candidate.evidence_count,
            failure_prevented: candidate.failure_prevented,
            score: Number(candidate.score.toFixed(2)),
            target,
            absolute_path: absolutePath,
            relative_path: doc.relativePath,
            overwritten,
          },
        });

        applied.push({
          candidate_id: candidate.candidate_id,
          memory_id: candidate.memory_id,
          target,
          relative_path: doc.relativePath,
          absolute_path: absolutePath,
          overwritten,
        });
      }
    }

    const result: PromoteResult = {
      target,
      dry_run: dryRun,
      project_dir: projectDir,
      promoted_at: promotedAt,
      candidates: candidates.map((c, i) => ({
        ...c,
        rendered_path: docs[i]!.relativePath,
      })),
      applied,
    };
    this.emit('promote', result);
    return result;
  }
}

export interface PromoteOptions {
  target?: PromotionTarget;
  minConfidence?: number;
  minEvidence?: number;
  limit?: number;
  dryRun?: boolean;
  yes?: boolean;
  projectDir?: string;
}

export interface PromotionCandidateWithPath extends PromotionCandidate {
  rendered_path: string;
}

export interface PromotionWriteResult {
  candidate_id: string;
  memory_id: string;
  target: PromotionTarget;
  relative_path: string;
  absolute_path: string;
  overwritten: boolean;
}

export interface PromoteResult {
  target: PromotionTarget;
  dry_run: boolean;
  project_dir: string;
  promoted_at: string;
  candidates: PromotionCandidateWithPath[];
  applied: PromotionWriteResult[];
}

// Re-exports so the rules-compiler output is easy to consume by callers.
export type { RuleDoc };

function db_prepare_get_status(db: Database.Database, runId: string): StatusRow | undefined {
  return db.prepare('SELECT status FROM consolidation_runs WHERE id = ?').get(runId) as StatusRow | undefined;
}
