import { EventEmitter } from 'node:events';
import type { Database } from 'better-sqlite3';

// === Configuration ===

export interface EmbeddingConfig {
  provider: 'mock' | 'local' | 'gemini' | 'openai';
  dimensions?: number;
  apiKey?: string;
  device?: 'gpu' | 'cpu';
  model?: string;
}

export interface LLMConfig {
  provider: 'mock' | 'anthropic' | 'openai';
  apiKey?: string;
  model?: string;
}

export interface ConfidenceWeights {
  source?: number;
  evidence?: number;
  recency?: number;
  retrieval?: number;
}

export interface HalfLives {
  episodic?: number;
  semantic?: number;
  procedural?: number;
}

export interface ConfidenceConfig {
  weights?: ConfidenceWeights;
  halfLives?: HalfLives;
  sourceReliability?: Record<string, number>;
}

export interface ConsolidationConfig {
  minEpisodes?: number;
}

export interface DecayConfig {
  dormantThreshold?: number;
}

export interface ContextConfig {
  enabled?: boolean;
  weight?: number;
}

export interface AffectConfig {
  enabled?: boolean;
  weight?: number;
  arousalWeight?: number;
  resonance?: {
    enabled?: boolean;
    threshold?: number;
    maxResults?: number;
  };
}

export interface InterferenceConfig {
  enabled?: boolean;
  k?: number;
  threshold?: number;
  weight?: number;
}

export interface AudreyConfig {
  dataDir: string;
  agent?: string;
  embedding: EmbeddingConfig;
  llm?: LLMConfig;
  confidence?: ConfidenceConfig;
  consolidation?: ConsolidationConfig;
  decay?: DecayConfig;
  context?: ContextConfig;
  affect?: AffectConfig;
  interference?: InterferenceConfig;
}

// === Encode ===

export type SourceType = 'direct-observation' | 'told-by-user' | 'tool-result' | 'inference' | 'model-generated';

export interface AffectParams {
  valence?: number;
  arousal?: number;
  label?: string;
}

export interface EncodeParams {
  content: string;
  source: SourceType;
  salience?: number;
  tags?: string[];
  context?: Record<string, unknown>;
  affect?: AffectParams;
  causal?: { trigger?: string; consequence?: string };
  supersedes?: string;
  private?: boolean;
  agent?: string;
}

// === Recall ===

export interface RecallOptions {
  limit?: number;
  minConfidence?: number;
  types?: Array<'episodic' | 'semantic' | 'procedural'>;
  includeProvenance?: boolean;
  includeDormant?: boolean;
  includePrivate?: boolean;
  tags?: string[];
  sources?: SourceType[];
  after?: string;
  before?: string;
  context?: Record<string, unknown>;
  affect?: AffectParams;
  scope?: 'shared' | 'agent';
  agent?: string;
  retrieval?: 'hybrid' | 'vector' | 'keyword';
}

export interface RecallResult {
  id: string;
  content: string;
  type: 'episodic' | 'semantic' | 'procedural';
  confidence: number;
  score: number;
  source: string;
  createdAt: string;
  agent: string;
  state?: string;
  contextMatch?: number;
  moodCongruence?: number;
  provenance?: {
    tags?: string[];
    context?: Record<string, unknown>;
    affect?: AffectParams;
    evidenceEpisodeIds?: string[];
  };
  _recallErrors?: Array<{ type: string; message: string }>;
}

export type RecallResults = RecallResult[] & {
  partialFailure?: boolean;
  errors?: Array<{ type: string; message: string }>;
};

// === Consolidation ===

export interface ConsolidateOptions {
  minClusterSize?: number;
  similarityThreshold?: number;
}

export interface ConsolidationResult {
  runId: string;
  episodesEvaluated: number;
  clustersFound: number;
  semanticsCreated: number;
  proceduresCreated: number;
  inputIds: string[];
  outputIds: string[];
}

// === Dream ===

export interface DreamOptions {
  dormantThreshold?: number;
  minClusterSize?: number;
  similarityThreshold?: number;
}

export interface DreamResult {
  consolidation: ConsolidationResult;
  decay: {
    totalEvaluated: number;
    transitionedToDormant: number;
    timestamp: string;
  };
  stats: IntrospectResult;
}

// === Introspect ===

export interface IntrospectResult {
  episodic: number;
  semantic: number;
  procedural: number;
  causalLinks: number;
  dormant: number;
  contradictions: {
    open: number;
    resolved: number;
    context_dependent: number;
    reopened: number;
  };
  lastConsolidation: string | null;
  totalConsolidationRuns: number;
}

// === Export / Import ===

export interface Snapshot {
  version: string;
  exportedAt: string;
  episodes: unknown[];
  semantics: unknown[];
  procedures: unknown[];
  causalLinks: unknown[];
  contradictions: unknown[];
  consolidationRuns: unknown[];
  consolidationMetrics: unknown[];
  config: Record<string, string>;
}

// === Forget ===

export interface ForgetOptions {
  purge?: boolean;
}

export interface ForgetResult {
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  purged: boolean;
}

export interface ForgetByQueryOptions {
  minSimilarity?: number;
  purge?: boolean;
  limit?: number;
}

export interface PurgeResult {
  episodesRemoved: number;
  semanticsRemoved: number;
  proceduresRemoved: number;
}

// === Greeting / Reflect ===

export interface GreetingOptions {
  context?: string;
}

export interface GreetingResult {
  principles: string[];
  recentMemories: RecallResult[];
  mood: { valence: number; arousal: number; label: string } | null;
  stats: IntrospectResult;
}

export interface ReflectResult {
  encoded: number;
  memories: Array<{ id: string; content: string }>;
  skipped?: string;
}

// === Embedding Providers ===

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  readonly modelVersion: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  readonly modelVersion: string;
  constructor(dimensions?: number);
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  readonly modelVersion: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  readonly modelVersion: string;
  constructor(options: { apiKey: string; dimensions?: number; model?: string });
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  readonly modelVersion: string;
  constructor(options: { apiKey: string; dimensions?: number; model?: string });
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider;

// === LLM Providers ===

export interface LLMProvider {
  readonly modelName: string;
  generate(prompt: string): Promise<string>;
}

export class MockLLMProvider implements LLMProvider {
  readonly modelName: string;
  generate(prompt: string): Promise<string>;
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly modelName: string;
  constructor(options: { apiKey: string; model?: string });
  generate(prompt: string): Promise<string>;
}

export class OpenAILLMProvider implements LLMProvider {
  readonly modelName: string;
  constructor(options: { apiKey: string; model?: string });
  generate(prompt: string): Promise<string>;
}

export function createLLMProvider(config: LLMConfig): LLMProvider;

// === Core Class ===

export class Audrey extends EventEmitter {
  readonly agent: string;
  readonly dataDir: string;
  readonly db: Database;
  readonly embeddingProvider: EmbeddingProvider;
  readonly llmProvider: LLMProvider | null;

  constructor(config: AudreyConfig);

  encode(params: EncodeParams): Promise<string>;
  recall(query: string, options?: RecallOptions): Promise<RecallResults>;
  recallStream(query: string, options?: RecallOptions): AsyncGenerator<RecallResult>;
  consolidate(options?: ConsolidateOptions): Promise<ConsolidationResult>;
  dream(options?: DreamOptions): Promise<DreamResult>;
  introspect(): IntrospectResult;
  export(): Snapshot;
  import(snapshot: Snapshot): Promise<void>;
  forget(id: string, options?: ForgetOptions): ForgetResult;
  forgetByQuery(query: string, options?: ForgetByQueryOptions): Promise<ForgetResult | null>;
  purge(): PurgeResult;
  greeting(options?: GreetingOptions): Promise<GreetingResult>;
  reflect(turns: string): Promise<ReflectResult>;
  startAutoConsolidate(intervalMs: number, options?: ConsolidateOptions): void;
  stopAutoConsolidate(): void;
  waitForIdle(): Promise<void>;
  close(): void;
}

// === Database ===

export function createDatabase(dataDir: string, options?: { dimensions?: number }): { db: Database; migrated: boolean };
export function closeDatabase(db: Database): void;
export function readStoredDimensions(dataDir: string): number | null;

// === Standalone Functions ===

export function recall(db: Database, embeddingProvider: EmbeddingProvider, query: string, options?: RecallOptions): Promise<RecallResults>;
export function recallStream(db: Database, embeddingProvider: EmbeddingProvider, query: string, options?: RecallOptions): AsyncGenerator<RecallResult>;
export function exportMemories(db: Database): Snapshot;
export function importMemories(db: Database, embeddingProvider: EmbeddingProvider, snapshot: Snapshot): Promise<void>;
export function forgetMemory(db: Database, id: string, options?: ForgetOptions): ForgetResult;
export function forgetByQuery(db: Database, embeddingProvider: EmbeddingProvider, query: string, options?: ForgetByQueryOptions): Promise<ForgetResult | null>;
export function purgeMemories(db: Database): PurgeResult;
export function reembedAll(db: Database, embeddingProvider: EmbeddingProvider): Promise<{ reembedded: number }>;
export function suggestConsolidationParams(db: Database): { minClusterSize: number; similarityThreshold: number } | null;

// === Confidence ===

export function computeConfidence(params: {
  sourceType: SourceType;
  supportingCount?: number;
  contradictingCount?: number;
  ageDays?: number;
  halfLifeDays?: number;
  retrievalCount?: number;
  daysSinceRetrieval?: number;
}): number;
export function sourceReliability(source: SourceType): number;
export function salienceModifier(salience: number): number;
export const DEFAULT_SOURCE_RELIABILITY: Record<SourceType, number>;
export const DEFAULT_WEIGHTS: ConfidenceWeights;
export const DEFAULT_HALF_LIVES: HalfLives;

// === Causal ===

export function addCausalLink(db: Database, params: { causeId: string; effectId: string; strength?: number; description?: string }): string;
export function getCausalChain(db: Database, id: string, options?: { depth?: number; direction?: 'forward' | 'backward' | 'both' }): unknown[];
export function articulateCausalLink(db: Database, llmProvider: LLMProvider, linkId: string): Promise<string>;

// === Prompts ===

export function buildPrincipleExtractionPrompt(episodes: Array<{ content: string }>): string;
export function buildContradictionDetectionPrompt(memory: string, candidate: string): string;
export function buildCausalArticulationPrompt(cause: string, effect: string): string;
export function buildContextResolutionPrompt(contradiction: string, contextA: string, contextB: string): string;

// === Affect ===

export function arousalSalienceBoost(arousal?: number): number;
export function affectSimilarity(a: AffectParams, b: AffectParams): number;
export function moodCongruenceModifier(memoryAffect: AffectParams, queryAffect: AffectParams, weight?: number): number;
export function detectResonance(db: Database, embeddingProvider: EmbeddingProvider, episodeId: string, params: EncodeParams, config: { threshold?: number; maxResults?: number }): Promise<unknown[]>;

// === Interference ===

export function applyInterference(db: Database, embeddingProvider: EmbeddingProvider, episodeId: string, params: EncodeParams, config: InterferenceConfig): Promise<unknown[]>;
export function interferenceModifier(interferenceCount: number): number;

// === Context ===

export function contextMatchRatio(encodingContext: Record<string, unknown>, retrievalContext: Record<string, unknown>): number;
export function contextModifier(encodingContext: Record<string, unknown>, retrievalContext: Record<string, unknown>, weight?: number): number;
