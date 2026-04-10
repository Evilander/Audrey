/**
 * src/types.ts — Shared type definitions for the Audrey memory system.
 * All types are derived from the actual JS source — no behavioral changes.
 */

export type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Primitive union types
// ---------------------------------------------------------------------------

export type SourceType =
  | 'direct-observation'
  | 'told-by-user'
  | 'tool-result'
  | 'inference'
  | 'model-generated';

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type MemoryState =
  | 'active'
  | 'disputed'
  | 'superseded'
  | 'context_dependent'
  | 'dormant'
  | 'rolled_back';

export type ContradictionState = 'open' | 'resolved' | 'context_dependent' | 'reopened';

export type ConsolidationStatus = 'running' | 'completed' | 'failed' | 'rolled_back';

export type CausalLinkType = 'causal' | 'correlational' | 'temporal';

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export interface Affect {
  valence?: number;
  arousal?: number;
  label?: string;
}

export interface CausalParams {
  trigger?: string;
  consequence?: string;
}

export interface EncodeParams {
  content: string;
  source: SourceType;
  salience?: number;
  causal?: CausalParams;
  tags?: string[];
  supersedes?: string;
  context?: Record<string, string>;
  affect?: Affect;
  arousalWeight?: number;
  private?: boolean;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export interface RecallOptions {
  minConfidence?: number;
  types?: MemoryType[];
  limit?: number;
  includeProvenance?: boolean;
  includeDormant?: boolean;
  tags?: string[];
  sources?: string[];
  after?: string;
  before?: string;
  context?: Record<string, string>;
  mood?: Pick<Affect, 'valence' | 'arousal'>;
  confidenceConfig?: ConfidenceConfig;
  includePrivate?: boolean;
}

export interface EpisodicProvenance {
  source: string;
  sourceReliability: number;
  createdAt: string;
  supersedes: string | null;
}

export interface SemanticProvenance {
  evidenceEpisodeIds: string[];
  evidenceCount: number;
  supportingCount: number;
  contradictingCount: number;
  consolidationCheckpoint: string | null;
}

export interface ProceduralProvenance {
  evidenceEpisodeIds: string[];
  successCount: number;
  failureCount: number;
  triggerConditions: string | null;
}

export interface RecallResult {
  id: string;
  content: string;
  type: MemoryType;
  confidence: number;
  score: number;
  source: string;
  createdAt: string;
  state?: MemoryState;
  contextMatch?: number;
  moodCongruence?: number;
  lexicalCoverage?: number;
  provenance?: EpisodicProvenance | SemanticProvenance | ProceduralProvenance;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export interface ConfidenceWeights {
  source: number;
  evidence: number;
  recency: number;
  retrieval: number;
}

export interface HalfLives {
  episodic: number;
  semantic: number;
  procedural: number;
}

export type SourceReliabilityMap = Record<string, number>;

export interface ConfidenceConfig {
  weights?: ConfidenceWeights;
  halfLives?: HalfLives;
  sourceReliability?: SourceReliabilityMap;
  interferenceWeight?: number;
  contextWeight?: number;
  affectWeight?: number;
  retrievalContext?: Record<string, string>;
  retrievalMood?: Pick<Affect, 'valence' | 'arousal'>;
}

export interface ComputeConfidenceParams {
  sourceType: string;
  supportingCount: number;
  contradictingCount: number;
  ageDays: number;
  halfLifeDays: number;
  retrievalCount: number;
  daysSinceRetrieval: number;
  weights?: ConfidenceWeights;
  customSourceReliability?: SourceReliabilityMap;
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export interface ExtractedPrinciple {
  content: string;
  type: 'semantic' | 'procedural';
  conditions?: Record<string, unknown>;
}

export interface ConsolidationResult {
  runId: string;
  episodesEvaluated: number;
  clustersFound: number;
  principlesExtracted: number;
  semanticsCreated?: number;
  proceduresCreated?: number;
  status?: string;
}

export interface ConsolidationOptions {
  similarityThreshold?: number;
  minClusterSize?: number;
  extractPrinciple?: (episodes: EpisodeRow[]) => Promise<ExtractedPrinciple> | ExtractedPrinciple;
  llmProvider?: LLMProvider;
}

// ---------------------------------------------------------------------------
// Introspect
// ---------------------------------------------------------------------------

export interface ContradictionCounts {
  open: number;
  resolved: number;
  context_dependent: number;
  reopened: number;
}

export interface IntrospectResult {
  episodic: number;
  semantic: number;
  procedural: number;
  causalLinks: number;
  dormant: number;
  contradictions: ContradictionCounts;
  lastConsolidation: string | null;
  totalConsolidationRuns: number;
}

// ---------------------------------------------------------------------------
// Truth / Dream / Decay
// ---------------------------------------------------------------------------

export interface TruthResolution {
  resolution: 'a_wins' | 'b_wins' | 'context_dependent';
  conditions?: Record<string, unknown>;
  explanation: string;
}

export interface DreamResult {
  consolidation: ConsolidationResult;
  decay: DecayResult;
  stats: IntrospectResult;
}

export interface DecayResult {
  totalEvaluated: number;
  transitionedToDormant: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Greeting / Reflect
// ---------------------------------------------------------------------------

export interface GreetingOptions {
  context?: string;
  recentLimit?: number;
  principleLimit?: number;
  identityLimit?: number;
}

export interface GreetingResult {
  recent: Array<{
    id: string;
    content: string;
    source: string;
    tags: string | null;
    salience: number;
    created_at: string;
  }>;
  principles: Array<{
    id: string;
    content: string;
    salience: number;
    created_at: string;
  }>;
  mood: {
    valence: number;
    arousal: number;
    samples: number;
  };
  unresolved: Array<{
    id: string;
    content: string;
    tags: string | null;
    salience: number;
    created_at: string;
  }>;
  identity: Array<{
    id: string;
    content: string;
    tags: string | null;
    salience: number;
    created_at: string;
  }>;
  contextual?: RecallResult[];
}

export interface ReflectMemory {
  content: string;
  source: SourceType;
  salience?: number;
  tags?: string[];
  private?: boolean;
  affect?: Affect;
}

export interface ReflectResult {
  encoded: number;
  memories: ReflectMemory[];
  skipped?: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  provider: 'mock' | 'openai' | 'local' | 'gemini';
  dimensions?: number;
  apiKey?: string;
  model?: string;
  device?: string;
  batchSize?: number;
  timeout?: number;
  pipelineFactory?: ((task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>) | null;
}

export interface LLMConfig {
  provider: 'mock' | 'anthropic' | 'openai';
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeout?: number;
  responses?: Record<string, unknown>;
}

export interface InterferenceConfig {
  enabled?: boolean;
  k?: number;
  threshold?: number;
  weight?: number;
}

export interface ContextConfig {
  enabled?: boolean;
  weight?: number;
}

export interface ResonanceConfig {
  enabled?: boolean;
  k?: number;
  threshold?: number;
  affectThreshold?: number;
}

export interface AffectConfig {
  enabled?: boolean;
  weight?: number;
  arousalWeight?: number;
  resonance?: ResonanceConfig;
}

export interface AudreyConfig {
  dataDir?: string;
  agent?: string;
  embedding?: EmbeddingConfig;
  llm?: LLMConfig;
  confidence?: Partial<ConfidenceConfig>;
  consolidation?: {
    minEpisodes?: number;
    similarityThreshold?: number;
  };
  decay?: {
    dormantThreshold?: number;
    halfLives?: Partial<HalfLives>;
  };
  interference?: InterferenceConfig;
  context?: ContextConfig;
  affect?: AffectConfig;
  autoReflect?: boolean;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  dimensions: number;
  modelName: string;
  modelVersion: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
  bufferToVector(buffer: Buffer): number[];
  ready?(): Promise<void>;
  _actualDevice?: string | null;
  device?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionResult {
  content: string;
}

export interface LLMCompletionOptions {
  maxTokens?: number;
}

export interface LLMProvider {
  modelName: string;
  modelVersion: string;
  complete(messages: ChatMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult>;
  json(messages: ChatMessage[], options?: LLMCompletionOptions): Promise<unknown>;
  chat?(prompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Database Row Types
// ---------------------------------------------------------------------------

export interface EpisodeRow {
  id: string;
  content: string;
  embedding: Buffer | null;
  source: string;
  source_reliability: number;
  salience: number;
  context: string;       // JSON string
  affect: string;        // JSON string
  tags: string | null;   // JSON string or null
  causal_trigger: string | null;
  causal_consequence: string | null;
  created_at: string;
  embedding_model: string | null;
  embedding_version: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  consolidated: number;  // 0 | 1
  private: number;       // 0 | 1
}

export interface SemanticRow {
  id: string;
  content: string;
  embedding: Buffer | null;
  state: MemoryState;
  conditions: string | null;           // JSON string
  evidence_episode_ids: string | null; // JSON string
  evidence_count: number;
  supporting_count: number;
  contradicting_count: number;
  source_type_diversity: number;
  consolidation_checkpoint: string | null;
  embedding_model: string | null;
  embedding_version: string | null;
  consolidation_model: string | null;
  consolidation_prompt_hash: string | null;
  created_at: string;
  last_reinforced_at: string | null;
  retrieval_count: number;
  challenge_count: number;
  interference_count: number;
  salience: number;
}

export interface ProceduralRow {
  id: string;
  content: string;
  embedding: Buffer | null;
  state: MemoryState;
  trigger_conditions: string | null;   // JSON string
  evidence_episode_ids: string | null; // JSON string
  success_count: number;
  failure_count: number;
  embedding_model: string | null;
  embedding_version: string | null;
  created_at: string;
  last_reinforced_at: string | null;
  retrieval_count: number;
  interference_count: number;
  salience: number;
}

export interface CausalLinkRow {
  id: string;
  cause_id: string;
  effect_id: string;
  link_type: CausalLinkType;
  mechanism: string | null;
  confidence: number | null;
  evidence_count: number;
  created_at: string;
}

export interface ContradictionRow {
  id: string;
  claim_a_id: string;
  claim_b_id: string;
  claim_a_type: string;
  claim_b_type: string;
  state: ContradictionState;
  resolution: string | null; // JSON string
  resolved_at: string | null;
  reopened_at: string | null;
  reopen_evidence_id: string | null;
  created_at: string;
}

export interface ConsolidationRunRow {
  id: string;
  checkpoint_cursor: string | null;
  input_episode_ids: string;   // JSON string
  output_memory_ids: string;   // JSON string
  confidence_deltas: string | null; // JSON string
  consolidation_model: string | null;
  consolidation_prompt_hash: string | null;
  started_at: string;
  completed_at: string | null;
  status: ConsolidationStatus;
}

export interface ConsolidationMetricRow {
  id: string;
  run_id: string;
  min_cluster_size: number;
  similarity_threshold: number;
  episodes_evaluated: number;
  clusters_found: number;
  principles_extracted: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

export interface MemoryStatusResult {
  episodes: number;
  vec_episodes: number;
  semantics: number;
  vec_semantics: number;
  procedures: number;
  vec_procedures: number;
  searchable_episodes: number;
  searchable_semantics: number;
  searchable_procedures: number;
  dimensions: number | null;
  schema_version: number;
  device: string | null;
  healthy: boolean;
  reembed_recommended: boolean;
}

export interface ForgetResult {
  id: string;
  type: MemoryType;
  purged: boolean;
}

export interface PurgeResult {
  episodes: number;
  semantics: number;
  procedures: number;
}

export interface ReembedCounts {
  episodes: number;
  semantics: number;
  procedures: number;
}
