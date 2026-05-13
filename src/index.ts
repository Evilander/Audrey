export { Audrey } from './audrey.js';
export { startServer } from './server.js';
export type { ServerOptions } from './server.js';
export { createApp } from './routes.js';
export type { AppOptions } from './routes.js';
export { computeConfidence, sourceReliability, salienceModifier, DEFAULT_SOURCE_RELIABILITY, DEFAULT_WEIGHTS, DEFAULT_HALF_LIVES } from './confidence.js';
export {
  createEmbeddingProvider,
  MockEmbeddingProvider,
  LocalEmbeddingProvider,
  OpenAIEmbeddingProvider,
  GeminiEmbeddingProvider,
} from './embedding.js';
export { createLLMProvider, MockLLMProvider, AnthropicLLMProvider, OpenAILLMProvider } from './llm.js';
export { createDatabase, closeDatabase, readStoredDimensions } from './db.js';
export { recall, recallStream } from './recall.js';
export { addCausalLink, getCausalChain, articulateCausalLink } from './causal.js';
export {
  buildPrincipleExtractionPrompt,
  buildContradictionDetectionPrompt,
  buildCausalArticulationPrompt,
  buildContextResolutionPrompt,
} from './prompts.js';
export { exportMemories } from './export.js';
export { importMemories } from './import.js';
export { suggestConsolidationParams } from './adaptive.js';
export { reembedAll } from './migrate.js';
export { forgetMemory, forgetByQuery, purgeMemories } from './forget.js';
export { applyInterference, interferenceModifier } from './interference.js';
export { contextMatchRatio, contextModifier } from './context.js';
export { arousalSalienceBoost, affectSimilarity, moodCongruenceModifier, detectResonance } from './affect.js';
export { ProfileRecorder, isAudreyProfileEnabled } from './profile.js';
export type { ProfileDiagnostics, ProfileSpan } from './profile.js';
export { buildPreflight } from './preflight.js';
export type {
  MemoryPreflight,
  PreflightDecision,
  PreflightOptions,
  PreflightSeverity,
  PreflightWarning,
  PreflightWarningType,
} from './preflight.js';
export { buildReflexReport, buildReflexReportFromPreflight } from './reflexes.js';
export type {
  MemoryReflex,
  MemoryReflexReport,
  ReflexOptions,
  ReflexResponseType,
} from './reflexes.js';
export { beforeAction, afterAction, MemoryController } from './controller.js';
export type {
  AgentAction,
  ControllerGuardDecision,
  ControllerGuardResult,
  GuardBeforeOptions,
  GuardDecision,
  GuardAfterInput,
  GuardOutcome,
  GuardValidatedEvidence,
  ToolOutcome,
} from './controller.js';

export type {
  Affect,
  AudreyConfig,
  CausalLinkRow,
  CausalLinkType,
  CausalParams,
  ChatMessage,
  ConfidenceConfig,
  ConfidenceWeights,
  ComputeConfidenceParams,
  ConsolidationMetricRow,
  ConsolidationOptions,
  ConsolidationResult,
  ConsolidationRunRow,
  ConsolidationStatus,
  ContradictionCounts,
  ContradictionRow,
  ContradictionState,
  ContextConfig,
  Database,
  DecayResult,
  DreamResult,
  EmbeddingConfig,
  EmbeddingProvider,
  EncodeParams,
  EpisodeRow,
  EpisodicProvenance,
  ExtractedPrinciple,
  ForgetResult,
  GreetingOptions,
  GreetingResult,
  HalfLives,
  InterferenceConfig,
  IntrospectResult,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMConfig,
  LLMProvider,
  MemoryState,
  MemoryStatusResult,
  MemoryType,
  ProceduralProvenance,
  ProceduralRow,
  PurgeResult,
  RecallOptions,
  RecallResult,
  ReembedCounts,
  ReflectMemory,
  ReflectResult,
  ResonanceConfig,
  SemanticProvenance,
  SemanticRow,
  SourceReliabilityMap,
  SourceType,
  TruthResolution,
  AffectConfig,
} from './types.js';
