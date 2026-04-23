# v0.18 TypeScript Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Audrey from JavaScript to TypeScript — strict types, published declarations, zero breaking API changes.

**Architecture:** Rename all 24 `src/*.js` + 2 `mcp-server/*.js` files to `.ts`. Add `tsconfig.json` with strict mode. Build to `dist/` via `tsc`. Update `package.json` exports to point at compiled output. All 30 existing test files stay as `.js` importing from the compiled package — this validates that the published package works correctly for JS consumers.

**Tech Stack:** TypeScript 5.x, vitest (unchanged), better-sqlite3 types, @types/node

**Source files (26 total):**
- `src/`: adaptive.ts, affect.ts, audrey.ts, causal.ts, confidence.ts, consolidate.ts, context.ts, db.ts, decay.ts, embedding.ts, encode.ts, export.ts, forget.ts, import.ts, index.ts, interference.ts, introspect.ts, llm.ts, migrate.ts, prompts.ts, recall.ts, rollback.ts, ulid.ts, utils.ts, validate.ts (note: validate.ts is the 25th src file — there's no separate `validate.ts` and `validate.js` confusion)
- `mcp-server/`: config.ts, index.ts

**Test files (30 total, stay as .js):**
- All files in `tests/*.test.js` — imports change from `../src/foo.js` to `../dist/foo.js` (or the package entry)

---

### Task 1: Set up TypeScript toolchain

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json`
- Create: `src/types.ts` (shared type definitions)

- [ ] **Step 1: Install TypeScript and type dependencies**

```bash
npm install --save-dev typescript @types/better-sqlite3 @types/node
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src/**/*.ts", "mcp-server/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests", "benchmarks", "examples"]
}
```

- [ ] **Step 3: Create src/types.ts with all shared types**

This file centralizes every type that was previously scattered across JSDoc `@typedef` comments. All other modules import from here instead of re-declaring types.

```typescript
// src/types.ts
import type Database from 'better-sqlite3';

// === Source & Memory Types ===

export type SourceType = 'direct-observation' | 'told-by-user' | 'tool-result' | 'inference' | 'model-generated';
export type MemoryType = 'episodic' | 'semantic' | 'procedural';
export type MemoryState = 'active' | 'disputed' | 'superseded' | 'context_dependent' | 'dormant' | 'rolled_back';
export type ContradictionState = 'open' | 'resolved' | 'context_dependent' | 'reopened';
export type ConsolidationStatus = 'running' | 'completed' | 'failed' | 'rolled_back';
export type CausalLinkType = 'causal' | 'correlational' | 'temporal';

// === Encode ===

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
  private?: boolean;
}

// === Recall ===

export interface RecallOptions {
  minConfidence?: number;
  types?: MemoryType[];
  limit?: number;
  includeProvenance?: boolean;
  includeDormant?: boolean;
  tags?: string[];
  sources?: SourceType[];
  after?: string;
  before?: string;
  context?: Record<string, string>;
  mood?: { valence: number; arousal?: number };
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

// === Confidence ===

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

export interface SourceReliabilityMap {
  [source: string]: number;
}

export interface ConfidenceConfig {
  weights?: ConfidenceWeights;
  halfLives?: HalfLives;
  sourceReliability?: SourceReliabilityMap;
  interferenceWeight?: number;
  contextWeight?: number;
  affectWeight?: number;
  retrievalContext?: Record<string, string>;
  retrievalMood?: { valence: number; arousal?: number };
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

// === Consolidation ===

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
  minClusterSize?: number;
  similarityThreshold?: number;
  extractPrinciple?: (episodes: EpisodeRow[]) => Promise<ExtractedPrinciple>;
  llmProvider?: LLMProvider | null;
}

export interface ExtractedPrinciple {
  content: string;
  type: 'semantic' | 'procedural';
  category?: string;
  conditions?: string[] | null;
}

// === Introspect ===

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

// === Truth Resolution ===

export interface TruthResolution {
  resolution: 'a_wins' | 'b_wins' | 'context_dependent';
  conditions?: Record<string, string>;
  explanation: string;
}

// === Dream ===

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

// === Greeting ===

export interface GreetingOptions {
  context?: string;
  recentLimit?: number;
  principleLimit?: number;
  identityLimit?: number;
}

export interface GreetingResult {
  recent: EpisodeRow[];
  principles: SemanticRow[];
  mood: { valence: number; arousal: number; samples: number };
  unresolved: EpisodeRow[];
  identity: EpisodeRow[];
  contextual?: RecallResult[];
}

// === Reflect ===

export interface ReflectResult {
  encoded: number;
  memories: ReflectMemory[];
  skipped?: string;
}

export interface ReflectMemory {
  content: string;
  source: SourceType;
  salience?: number;
  tags?: string[];
  private?: boolean;
  affect?: Affect;
}

// === Config ===

export interface EmbeddingConfig {
  provider: 'mock' | 'openai' | 'local' | 'gemini';
  dimensions?: number;
  apiKey?: string;
  device?: string;
  model?: string;
  batchSize?: number;
  pipelineFactory?: unknown;
  timeout?: number;
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
  consolidation?: { minEpisodes?: number };
  decay?: { dormantThreshold?: number };
  interference?: InterferenceConfig;
  context?: ContextConfig;
  affect?: AffectConfig;
  autoReflect?: boolean;
}

// === Embedding Provider ===

export interface EmbeddingProvider {
  dimensions: number;
  modelName: string;
  modelVersion: string;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  vectorToBuffer(vector: number[]): Buffer;
  bufferToVector(buffer: Buffer): number[];
  ready?(): Promise<void>;
  /** Actual device used after initialization (local provider only) */
  _actualDevice?: string;
  device?: string;
}

// === LLM Provider ===

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
  chat?(prompt: ChatMessage[]): Promise<string>;
}

// === Database Row Types ===

export interface EpisodeRow {
  id: string;
  content: string;
  embedding: Buffer | null;
  source: string;
  source_reliability: number;
  salience: number;
  context: string;
  affect: string;
  tags: string | null;
  causal_trigger: string | null;
  causal_consequence: string | null;
  created_at: string;
  embedding_model: string | null;
  embedding_version: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  consolidated: number;
  private: number;
}

export interface SemanticRow {
  id: string;
  content: string;
  embedding: Buffer | null;
  state: string;
  conditions: string | null;
  evidence_episode_ids: string;
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
  state: string;
  trigger_conditions: string | null;
  evidence_episode_ids: string;
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
  link_type: string;
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
  state: string;
  resolution: string | null;
  resolved_at: string | null;
  reopened_at: string | null;
  reopen_evidence_id: string | null;
  created_at: string;
}

export interface ConsolidationRunRow {
  id: string;
  checkpoint_cursor: string | null;
  input_episode_ids: string;
  output_memory_ids: string;
  confidence_deltas: string | null;
  consolidation_model: string | null;
  consolidation_prompt_hash: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
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

// Re-export Database type for convenience
export type { Database };
```

- [ ] **Step 4: Run tsc to verify tsconfig is valid (will fail — no .ts files yet)**

```bash
npx tsc --noEmit 2>&1 | head -5
```

Expected: Error about no input files found (because src/ still has .js files).

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json src/types.ts package.json package-lock.json
git commit -m "build: add TypeScript toolchain and shared type definitions"
```

---

### Task 2: Convert leaf modules (no internal imports)

These files have no imports from other `src/` modules (or only import from `types.ts`). Convert them first since nothing depends on their internal signatures yet.

**Files:**
- Rename: `src/ulid.js` -> `src/ulid.ts`
- Rename: `src/utils.js` -> `src/utils.ts`
- Rename: `src/context.js` -> `src/context.ts`
- Rename: `src/affect.js` -> `src/affect.ts`

- [ ] **Step 1: Convert src/ulid.ts**

```bash
mv src/ulid.js src/ulid.ts
```

Edit `src/ulid.ts`:

```typescript
import { monotonicFactory } from 'ulid';
import { createHash } from 'node:crypto';

const monotonic = monotonicFactory();

export function generateId(): string {
  return monotonic();
}

export function generateDeterministicId(...parts: unknown[]): string {
  const input = JSON.stringify(parts);
  return createHash('sha256').update(input).digest('hex').slice(0, 26);
}
```

- [ ] **Step 2: Convert src/utils.ts**

```bash
mv src/utils.js src/utils.ts
```

Edit `src/utils.ts`:

```typescript
import type { EmbeddingProvider } from './types.js';

export function cosineSimilarity(bufA: Buffer, bufB: Buffer, provider: EmbeddingProvider): number {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

export function daysBetween(dateStr: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str) as T; }
  catch { return fallback; }
}

export function requireApiKey(apiKey: string | undefined | null, operation: string, envVar: string): asserts apiKey is string {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error(`${operation} requires ${envVar}`);
  }
}

export async function describeHttpError(response: { status: number; text: () => Promise<string> }): Promise<string> {
  if (typeof response.text !== 'function') {
    return `${response.status}`;
  }
  const body = await response.text().catch(() => '');
  const normalized = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  return normalized ? `${response.status} ${normalized}` : `${response.status}`;
}
```

- [ ] **Step 3: Convert src/context.ts**

```bash
mv src/context.js src/context.ts
```

Edit `src/context.ts`:

```typescript
export function contextMatchRatio(encodingContext: Record<string, string> | null, retrievalContext: Record<string, string> | null): number {
  if (!encodingContext || !retrievalContext) return 0;
  const retrievalKeys = Object.keys(retrievalContext);
  if (retrievalKeys.length === 0) return 0;
  const sharedKeys = retrievalKeys.filter(k => k in encodingContext);
  if (sharedKeys.length === 0) return 0;
  const matches = sharedKeys.filter(k => encodingContext[k] === retrievalContext[k]).length;
  return matches / retrievalKeys.length;
}

export function contextModifier(encodingContext: Record<string, string> | null, retrievalContext: Record<string, string> | null, weight = 0.3): number {
  if (!encodingContext || !retrievalContext) return 1.0;
  const ratio = contextMatchRatio(encodingContext, retrievalContext);
  return 1.0 + (weight * ratio);
}
```

- [ ] **Step 4: Convert src/affect.ts**

```bash
mv src/affect.js src/affect.ts
```

Edit `src/affect.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, Affect, ResonanceConfig } from './types.js';

export function arousalSalienceBoost(arousal: number | undefined | null): number {
  if (arousal === undefined || arousal === null) return 0;
  return Math.exp(-Math.pow(arousal - 0.7, 2) / (2 * 0.3 * 0.3));
}

export function affectSimilarity(a: Partial<Affect> | null, b: Partial<Affect> | null): number {
  if (!a || !b) return 0;
  if (a.valence === undefined || b.valence === undefined) return 0;
  const valenceDist = Math.abs(a.valence - b.valence);
  const valenceSim = 1.0 - (valenceDist / 2.0);
  if (a.arousal === undefined || b.arousal === undefined) return valenceSim;
  const arousalSim = 1.0 - Math.abs(a.arousal - b.arousal);
  return 0.7 * valenceSim + 0.3 * arousalSim;
}

export function moodCongruenceModifier(encodingAffect: Partial<Affect> | null, retrievalMood: Partial<Affect> | null, weight = 0.2): number {
  if (!encodingAffect || !retrievalMood) return 1.0;
  const similarity = affectSimilarity(encodingAffect, retrievalMood);
  if (similarity === 0) return 1.0;
  return 1.0 + (weight * similarity);
}

export interface ResonanceResult {
  priorEpisodeId: string;
  priorContent: string;
  priorAffect: Partial<Affect>;
  semanticSimilarity: number;
  emotionalSimilarity: number;
  timeDeltaDays: number;
  priorCreatedAt: string;
}

export async function detectResonance(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  episodeId: string,
  params: { content: string; affect?: Affect },
  config: ResonanceConfig = {},
): Promise<ResonanceResult[]> {
  const { enabled = true, k = 5, threshold = 0.5, affectThreshold = 0.6 } = config;
  if (!enabled || !params.affect || params.affect.valence === undefined) return [];

  const vector = await embeddingProvider.embed(params.content);
  const buffer = embeddingProvider.vectorToBuffer(vector);

  const matches = db.prepare(`
    SELECT e.*, (1.0 - v.distance) AS similarity
    FROM vec_episodes v
    JOIN episodes e ON e.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND e.id != ?
      AND e.superseded_by IS NULL
  `).all(buffer, k, episodeId) as Array<{ id: string; content: string; affect: string; similarity: number; created_at: string }>;

  const resonances: ResonanceResult[] = [];
  for (const match of matches) {
    if (match.similarity < threshold) continue;
    let priorAffect: Partial<Affect>;
    try { priorAffect = JSON.parse(match.affect || '{}'); } catch { continue; }
    if (priorAffect.valence === undefined) continue;

    const emotionalSimilarity = affectSimilarity(params.affect, priorAffect);
    if (emotionalSimilarity < affectThreshold) continue;

    resonances.push({
      priorEpisodeId: match.id,
      priorContent: match.content,
      priorAffect,
      semanticSimilarity: match.similarity,
      emotionalSimilarity,
      timeDeltaDays: Math.floor((Date.now() - new Date(match.created_at).getTime()) / 86400000),
      priorCreatedAt: match.created_at,
    });
  }

  return resonances;
}
```

- [ ] **Step 5: Verify these four files compile**

```bash
npx tsc --noEmit
```

Expected: May show errors from files that import the renamed modules (they still have `.js` extensions). That's fine — we'll fix them in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src/ulid.ts src/utils.ts src/context.ts src/affect.ts
git add -u  # stages the deleted .js files
git commit -m "refactor: convert leaf modules to TypeScript (ulid, utils, context, affect)"
```

---

### Task 3: Convert confidence and interference modules

**Files:**
- Rename: `src/confidence.js` -> `src/confidence.ts`
- Rename: `src/interference.js` -> `src/interference.ts`

- [ ] **Step 1: Convert src/confidence.ts**

```bash
mv src/confidence.js src/confidence.ts
```

Edit `src/confidence.ts`:

```typescript
import type { ConfidenceWeights, HalfLives, SourceReliabilityMap, ComputeConfidenceParams } from './types.js';

export const DEFAULT_SOURCE_RELIABILITY: SourceReliabilityMap = {
  'direct-observation': 0.95,
  'told-by-user': 0.90,
  'tool-result': 0.85,
  'inference': 0.60,
  'model-generated': 0.40,
};

export const DEFAULT_WEIGHTS: ConfidenceWeights = {
  source: 0.30,
  evidence: 0.35,
  recency: 0.20,
  retrieval: 0.15,
};

export const DEFAULT_HALF_LIVES: HalfLives = {
  episodic: 7,
  semantic: 30,
  procedural: 90,
};

export const MODEL_GENERATED_CONFIDENCE_CAP = 0.6;

export function sourceReliability(sourceType: string, customReliability?: SourceReliabilityMap): number {
  const table = customReliability ?? DEFAULT_SOURCE_RELIABILITY;
  const value = table[sourceType];
  if (value === undefined) {
    throw new Error(`Unknown source type: ${sourceType}. Valid types: ${Object.keys(table).join(', ')}`);
  }
  return value;
}

export function evidenceAgreement(supportingCount: number, contradictingCount: number): number {
  const total = supportingCount + contradictingCount;
  if (total === 0) return 1.0;
  return supportingCount / total;
}

export function recencyDecay(ageDays: number, halfLifeDays: number): number {
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

export function retrievalReinforcement(retrievalCount: number, daysSinceRetrieval: number): number {
  if (retrievalCount === 0) return 0;
  const lambdaRet = Math.LN2 / 14;
  const baseReinforcement = 0.3 * Math.log(1 + retrievalCount);
  const recencyWeight = Math.exp(-lambdaRet * daysSinceRetrieval);
  const spacedBonus = Math.min(0.15, 0.02 * Math.log(1 + daysSinceRetrieval));
  return Math.min(1.0, baseReinforcement * recencyWeight + spacedBonus);
}

export function salienceModifier(salience?: number | null): number {
  const s = salience ?? 0.5;
  return 0.5 + s;
}

export function computeConfidence(params: ComputeConfidenceParams): number {
  const w = params.weights ?? DEFAULT_WEIGHTS;
  const s = sourceReliability(params.sourceType, params.customSourceReliability);
  const e = evidenceAgreement(params.supportingCount, params.contradictingCount);
  const r = recencyDecay(params.ageDays, params.halfLifeDays);
  const ret = retrievalReinforcement(params.retrievalCount, params.daysSinceRetrieval);

  let confidence = w.source * s + w.evidence * e + w.recency * r + w.retrieval * ret;

  if (params.sourceType === 'model-generated') {
    confidence = Math.min(confidence, MODEL_GENERATED_CONFIDENCE_CAP);
  }

  return Math.max(0, Math.min(1, confidence));
}
```

- [ ] **Step 2: Convert src/interference.ts**

```bash
mv src/interference.js src/interference.ts
```

Edit `src/interference.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, InterferenceConfig } from './types.js';

export function interferenceModifier(interferenceCount: number, weight = 0.1): number {
  return 1 / (1 + weight * interferenceCount);
}

interface InterferenceHit {
  id: string;
  type: 'semantic' | 'procedural';
  newCount: number;
  similarity: number;
}

export async function applyInterference(
  db: Database.Database,
  embeddingProvider: EmbeddingProvider,
  episodeId: string,
  params: { content: string },
  config: InterferenceConfig = {},
): Promise<InterferenceHit[]> {
  const { enabled = true, k = 5, threshold = 0.6 } = config;
  if (!enabled) return [];

  const vector = await embeddingProvider.embed(params.content);
  const buffer = embeddingProvider.vectorToBuffer(vector);

  const semanticHits = db.prepare(`
    SELECT s.id, s.interference_count, (1.0 - v.distance) AS similarity
    FROM vec_semantics v
    JOIN semantics s ON s.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND (v.state = 'active' OR v.state = 'context_dependent')
  `).all(buffer, k) as Array<{ id: string; interference_count: number; similarity: number }>;

  const proceduralHits = db.prepare(`
    SELECT p.id, p.interference_count, (1.0 - v.distance) AS similarity
    FROM vec_procedures v
    JOIN procedures p ON p.id = v.id
    WHERE v.embedding MATCH ?
      AND k = ?
      AND (v.state = 'active' OR v.state = 'context_dependent')
  `).all(buffer, k) as Array<{ id: string; interference_count: number; similarity: number }>;

  const affected: InterferenceHit[] = [];
  const updateSemantic = db.prepare('UPDATE semantics SET interference_count = ? WHERE id = ?');
  const updateProcedural = db.prepare('UPDATE procedures SET interference_count = ? WHERE id = ?');

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

  return affected;
}
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: Errors from unconverted files that import these modules. The converted files themselves should be clean.

- [ ] **Step 4: Commit**

```bash
git add src/confidence.ts src/interference.ts
git add -u
git commit -m "refactor: convert confidence and interference modules to TypeScript"
```

---

### Task 4: Convert remaining src/ modules (batch)

This task converts the remaining 18 source files. Since the patterns are established from Tasks 2-3, these conversions follow the same formula: rename, add type annotations to function signatures and local variables, cast `db.prepare().get/all()` results with `as Type`, import types from `./types.js`.

**Files to convert (in dependency order):**
1. `src/prompts.ts` (imports: utils)
2. `src/encode.ts` (imports: ulid, confidence, affect)
3. `src/db.ts` (imports: nothing from src — uses better-sqlite3 and sqlite-vec)
4. `src/decay.ts` (imports: confidence, interference, utils)
5. `src/rollback.ts` (imports: utils)
6. `src/introspect.ts` (imports: utils)
7. `src/adaptive.ts` (imports: nothing from src)
8. `src/export.ts` (imports: utils)
9. `src/import.ts` (imports: nothing from src besides types)
10. `src/forget.ts` (imports: nothing from src)
11. `src/validate.ts` (imports: ulid, utils, prompts)
12. `src/causal.ts` (imports: ulid, prompts)
13. `src/migrate.ts` (imports: db)
14. `src/embedding.ts` (imports: utils)
15. `src/llm.ts` (imports: utils)
16. `src/consolidate.ts` (imports: ulid, prompts)
17. `src/recall.ts` (imports: confidence, interference, context, affect, utils)
18. `src/audrey.ts` (imports: everything — convert last)

For each file, the conversion pattern is:

1. `mv src/X.js src/X.ts`
2. Add explicit types to all function parameters and return types
3. Cast all `db.prepare().get()` / `.all()` results with `as Type`
4. Replace JSDoc `@typedef` / `@param` / `@returns` with TypeScript types
5. Import types from `./types.js`

- [ ] **Step 1: Convert all 18 files**

Rename all files:

```bash
for f in prompts encode db decay rollback introspect adaptive export import forget validate causal migrate embedding llm consolidate recall audrey; do
  mv "src/$f.js" "src/$f.ts"
done
```

Then apply type annotations to each file. **The conversion pattern is identical to Tasks 2-3 — add explicit types to function signatures, cast `db.prepare()` results, import types from `./types.js`. No logic changes.** Each file's full conversion follows the same formula demonstrated on `utils.ts`, `affect.ts`, `confidence.ts`, and `interference.ts`. The executing agent should convert one file at a time, running `npx tsc --noEmit` after each to catch errors early.

The key type patterns used across files:

- `db: Database.Database` (from `import type Database from 'better-sqlite3'`)
- `embeddingProvider: EmbeddingProvider` (from `./types.js`)
- `db.prepare('...').get(...) as TypeRow | undefined`
- `db.prepare('...').all(...) as TypeRow[]`
- All function parameters get explicit types
- All function return types are declared

Each file's conversion follows the exact same source logic — only type annotations are added. No behavioral changes.

- [ ] **Step 2: Convert src/index.ts**

```bash
mv src/index.js src/index.ts
```

Add re-exports of all types:

```typescript
// At the top of src/index.ts, add:
export type {
  SourceType, MemoryType, MemoryState, Affect, CausalParams, EncodeParams,
  RecallOptions, RecallResult, ConsolidationResult, IntrospectResult,
  TruthResolution, DreamResult, DecayResult, GreetingOptions, GreetingResult,
  ReflectResult, AudreyConfig, EmbeddingConfig, LLMConfig, EmbeddingProvider,
  LLMProvider, ChatMessage, ConfidenceWeights, HalfLives, MemoryStatusResult,
  ForgetResult, PurgeResult, ReembedCounts, InterferenceConfig, ContextConfig,
  AffectConfig, ConfidenceConfig,
} from './types.js';

// Keep all existing re-exports, just change .js -> .js (module resolution handles it)
export { Audrey } from './audrey.js';
// ... rest unchanged
```

- [ ] **Step 3: Verify full compilation**

```bash
npx tsc --noEmit
```

Expected: Clean compilation, zero errors. If errors remain, fix them (most will be missing casts or `undefined` checks due to `noUncheckedIndexedAccess`).

- [ ] **Step 4: Commit**

```bash
git add src/
git add -u
git commit -m "refactor: convert all src/ modules to TypeScript"
```

---

### Task 5: Convert mcp-server/ to TypeScript

**Files:**
- Rename: `mcp-server/config.js` -> `mcp-server/config.ts`
- Rename: `mcp-server/index.js` -> `mcp-server/index.ts`

- [ ] **Step 1: Convert mcp-server/config.ts**

```bash
mv mcp-server/config.js mcp-server/config.ts
```

Add types to all functions. Key changes:
- `resolveDataDir(env: Record<string, string | undefined>): string`
- `resolveEmbeddingProvider(env: Record<string, string | undefined>, explicit?: string): EmbeddingConfig`
- `resolveLLMProvider(env: Record<string, string | undefined>, explicit?: string): LLMConfig | null`
- `buildAudreyConfig(): AudreyConfig`
- `buildInstallArgs(env?: Record<string, string | undefined>): string[]`

- [ ] **Step 2: Convert mcp-server/index.ts**

```bash
mv mcp-server/index.js mcp-server/index.ts
```

Key changes:
- Type the `server.tool()` callbacks
- Type `toolResult` and `toolError` helpers
- Type the CLI functions
- Add `#!/usr/bin/env node` shebang (preserved by tsc if using a build script)

- [ ] **Step 3: Verify full compilation**

```bash
npx tsc --noEmit
```

Expected: Zero errors.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/
git add -u
git commit -m "refactor: convert mcp-server/ to TypeScript"
```

---

### Task 6: Set up build pipeline and update package.json

**Files:**
- Modify: `package.json`
- Create: `.npmignore` (update)
- Modify: `vitest.config.js` -> `vitest.config.ts`

- [ ] **Step 1: Add build script and update package.json exports**

```json
{
  "main": "dist/src/index.js",
  "types": "dist/src/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    },
    "./mcp": {
      "types": "./dist/mcp-server/index.d.ts",
      "default": "./dist/mcp-server/index.js"
    }
  },
  "bin": {
    "audrey": "dist/mcp-server/index.js",
    "audrey-mcp": "dist/mcp-server/index.js"
  },
  "files": [
    "dist/",
    "docs/production-readiness.md",
    "docs/benchmarking.md",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc",
    "prebuild": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "pretest": "npm run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepack": "npm run build",
    "pack:check": "npm pack --dry-run",
    "bench:memory": "node benchmarks/run.js",
    "bench:memory:json": "node benchmarks/run.js --json",
    "bench:memory:check": "node benchmarks/run.js --check",
    "bench:memory:readme-assets": "node benchmarks/run.js --readme-assets-dir docs/assets/benchmarks",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Add dist/ to .gitignore**

Append to `.gitignore`:

```
dist/
```

- [ ] **Step 3: Build the project**

```bash
npm run build
```

Expected: `dist/` directory created with compiled `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` files.

- [ ] **Step 4: Verify the shebang line exists in dist/mcp-server/index.js**

```bash
head -1 dist/mcp-server/index.js
```

Expected: `#!/usr/bin/env node`

If missing, add a postbuild script that prepends it, or use a `tsc` plugin. TypeScript preserves shebangs from source files.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore .npmignore
git commit -m "build: configure TypeScript build pipeline and update package exports"
```

---

### Task 7: Update test imports and verify all tests pass

**Files:**
- Modify: All `tests/*.test.js` files — update import paths

- [ ] **Step 1: Update imports in all test files**

Tests currently import from `../src/foo.js`. After the build, the compiled output lives at `../dist/src/foo.js`. But since `package.json` exports map `audrey` to `dist/src/index.js`, tests can either:

Option A: Import from `../dist/src/foo.js` (explicit)
Option B: Use path aliases via vitest config

**Go with Option A** — explicit is better for debugging. Bulk update:

```bash
cd tests
for f in *.test.js; do
  sed -i "s|from '../src/|from '../dist/src/|g" "$f"
  sed -i "s|from '../mcp-server/|from '../dist/mcp-server/|g" "$f"
done
```

- [ ] **Step 2: Build and run all tests**

```bash
npm run build && npm test
```

Expected: All 468+ tests pass. If any fail, debug — likely a path issue or a TypeScript compilation change that altered runtime behavior (should not happen since we only added types).

- [ ] **Step 3: Run benchmark check**

```bash
npm run bench:memory:check
```

Expected: Passes.

- [ ] **Step 4: Run pack check**

```bash
npm run pack:check
```

Expected: Shows `dist/` files in the tarball, not `src/`.

- [ ] **Step 5: Commit**

```bash
git add tests/ vitest.config.js
git commit -m "test: update imports to use compiled TypeScript output"
```

---

### Task 8: Update benchmarks, examples, and CI

**Files:**
- Modify: `benchmarks/run.js` and other benchmark files — update imports
- Modify: `examples/*.js` — update imports
- Modify: `.github/workflows/ci.yml` — add build step

- [ ] **Step 1: Update benchmark imports**

```bash
cd benchmarks
for f in *.js; do
  sed -i "s|from '../src/|from '../dist/src/|g" "$f"
done
```

- [ ] **Step 2: Update example imports**

```bash
cd examples
for f in *.js; do
  sed -i "s|from '../src/|from '../dist/src/|g" "$f"
  # Also update 'audrey' imports if they use relative paths
done
```

- [ ] **Step 3: Update CI workflow**

Edit `.github/workflows/ci.yml` — add `npm run build` before `npm test`:

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm test
      - run: npm run bench:memory:check
      - run: npm run pack:check
```

Same for the Windows smoke job.

- [ ] **Step 4: Full validation**

```bash
npm run build && npm run typecheck && npm test && npm run bench:memory:check && npm run pack:check
```

Expected: All green.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/ examples/ .github/
git commit -m "build: update benchmarks, examples, and CI for TypeScript build"
```

---

### Task 9: Update VERSION constant and publish prep

**Files:**
- Modify: `mcp-server/config.ts` — version bump
- Modify: `package.json` — version bump to 0.18.0

- [ ] **Step 1: Bump version in package.json**

```bash
npm version minor --no-git-tag-version
```

This sets version to `0.18.0`.

- [ ] **Step 2: Update VERSION constant in mcp-server/config.ts**

Change `export const VERSION = '0.16.1';` to `export const VERSION = '0.18.0';`

- [ ] **Step 3: Final full validation**

```bash
npm run build && npm run typecheck && npm test && npm run bench:memory:check && npm run pack:check
```

Expected: All green.

- [ ] **Step 4: Commit and tag**

```bash
git add package.json package-lock.json mcp-server/config.ts
git commit -m "release: v0.18.0 — TypeScript conversion"
git tag v0.18.0
```

---

## Post-Conversion Checklist

After all tasks complete, verify:

- [ ] `npm install audrey` in a fresh project provides autocomplete for `Audrey`, `EncodeParams`, `RecallResult`, etc.
- [ ] `import { Audrey } from 'audrey'` works in both `.ts` and `.js` consumer files
- [ ] All 468+ tests pass
- [ ] `npm run bench:memory:check` passes
- [ ] `npm run pack:check` shows only `dist/` files (no `src/*.ts` leaked)
- [ ] CI passes on Node 18, 20, 22 (Ubuntu) and Node 20 (Windows)
- [ ] No breaking changes to any public API — same function signatures, same behavior
