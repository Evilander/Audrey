/**
 * Zod tool-input schemas for the MCP memory tools. These are pure schema
 * declarations consumed by the MCP server registration in index.ts and
 * re-exported from there for tests and embedders.
 */
import { z } from 'zod';
import { importSnapshotSchema } from '../src/import.js';
import {
  MAX_MEMORY_CONTENT_LENGTH,
  VALID_SOURCES,
  VALID_TYPES,
  isNonEmptyText,
} from './tool-validation.js';

export const memoryEncodeToolSchema = {
  content: z
    .string()
    .max(MAX_MEMORY_CONTENT_LENGTH)
    .refine(isNonEmptyText, 'Content must not be empty')
    .describe('The memory content to encode'),
  source: z.enum(VALID_SOURCES).describe('Source type of the memory'),
  tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
  salience: z.number().min(0).max(1).optional().describe('Importance weight 0-1'),
  context: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Situational context as key-value pairs (e.g., {task: "debugging", domain: "payments"})',
    ),
  affect: z
    .object({
      valence: z
        .number()
        .min(-1)
        .max(1)
        .describe('Emotional valence: -1 (very negative) to 1 (very positive)'),
      arousal: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Emotional arousal: 0 (calm) to 1 (highly activated)'),
      label: z
        .string()
        .optional()
        .describe('Human-readable emotion label (e.g., "curiosity", "frustration", "relief")'),
    })
    .optional()
    .describe('Emotional affect - how this memory feels'),
  private: z
    .boolean()
    .optional()
    .describe('If true, memory is only visible to the AI and excluded from public recall results'),
  wait_for_consolidation: z
    .boolean()
    .optional()
    .describe(
      'If true, wait for post-encode validation/interference/resonance work before returning. Defaults to false.',
    ),
};

export const memoryRecallToolSchema = {
  query: z.string().describe('Search query to match against memories'),
  limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
  types: z.array(z.enum(VALID_TYPES)).optional().describe('Memory types to search'),
  min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
  tags: z.array(z.string()).optional().describe('Only return episodic memories with these tags'),
  sources: z
    .array(z.enum(VALID_SOURCES))
    .optional()
    .describe('Only return episodic memories from these sources'),
  after: z.string().optional().describe('Only return memories created after this ISO date'),
  before: z.string().optional().describe('Only return memories created before this ISO date'),
  context: z
    .record(z.string(), z.string())
    .optional()
    .describe('Retrieval context - memories encoded in matching context get boosted'),
  mood: z
    .object({
      valence: z
        .number()
        .min(-1)
        .max(1)
        .describe('Current emotional valence: -1 (negative) to 1 (positive)'),
      arousal: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Current arousal: 0 (calm) to 1 (activated)'),
    })
    .optional()
    .describe('Current mood - boosts recall of memories encoded in similar emotional state'),
  retrieval: z
    .enum(['hybrid', 'vector'])
    .optional()
    .describe(
      'Retrieval strategy. hybrid is the default (vector + FTS/BM25 fusion); vector bypasses FTS for lower latency but loses lexical exact-match signal.',
    ),
  scope: z
    .enum(['agent', 'shared'])
    .optional()
    .describe(
      'agent restricts recall to this MCP server agent identity. shared searches the whole store. Defaults to shared for backward compatibility.',
    ),
};

export const memoryImportToolSchema = {
  snapshot: importSnapshotSchema.describe('A validated snapshot from memory_export'),
};

export const memoryForgetToolSchema = {
  id: z.string().optional().describe('ID of the memory to forget'),
  query: z
    .string()
    .optional()
    .describe('Semantic query to find and forget the closest matching memory'),
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Minimum similarity for query-based forget (default 0.9)'),
  purge: z
    .boolean()
    .optional()
    .describe('Hard-delete the memory permanently (default false, soft-delete)'),
};

export const memoryValidateToolSchema = {
  id: z.string().describe('ID of the memory to validate'),
  outcome: z
    .enum(['used', 'helpful', 'wrong'])
    .describe(
      'How the memory played out: "used" (referenced without obvious value), "helpful" (drove a correct action — reinforces salience and retrieval), "wrong" (memory was misleading — bumps challenge_count and decreases salience).',
    ),
};

export const memoryPreflightToolSchema = {
  action: z
    .string()
    .refine(isNonEmptyText, 'Action must not be empty')
    .describe('Natural-language description of the action the agent is about to take.'),
  tool: z
    .string()
    .optional()
    .describe('Tool or command family about to be used, e.g. Bash, npm test, Edit, deploy.'),
  session_id: z
    .string()
    .optional()
    .describe('Session identifier for grouping the optional preflight event.'),
  cwd: z.string().optional().describe('Working directory for the action.'),
  files: z
    .array(z.string())
    .optional()
    .describe('File paths to fingerprint if record_event is true.'),
  strict: z
    .boolean()
    .optional()
    .describe('If true, high-severity memory warnings produce decision=block instead of caution.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Max recall results to consider before preflight categorization.'),
  budget_chars: z
    .number()
    .int()
    .min(200)
    .max(32000)
    .optional()
    .describe('Capsule budget in characters.'),
  mode: z
    .enum(['balanced', 'conservative', 'aggressive'])
    .optional()
    .describe('Underlying capsule mode. Defaults to conservative.'),
  failure_window_hours: z
    .number()
    .int()
    .min(1)
    .max(8760)
    .optional()
    .describe('How far back to check failed tool events. Defaults to 168 hours.'),
  include_status: z
    .boolean()
    .optional()
    .describe('Include memory health in the response and warning calculation. Defaults to true.'),
  record_event: z
    .boolean()
    .optional()
    .describe('Record a redacted PreToolUse event for this preflight. Defaults to false.'),
  include_capsule: z
    .boolean()
    .optional()
    .describe('If false, omit the embedded Memory Capsule from the response.'),
  scope: z
    .enum(['agent', 'shared'])
    .optional()
    .describe(
      'agent restricts memory recall to this server agent identity. shared searches the whole store. Defaults to agent.',
    ),
};

const { record_event: _preflightRecordEvent, ...memoryGuardBeforeFields } =
  memoryPreflightToolSchema;
export const memoryGuardBeforeToolSchema = {
  ...memoryGuardBeforeFields,
  session_id: z
    .string()
    .optional()
    .describe('Session identifier for grouping the required guard receipt event.'),
  files: z
    .array(z.string())
    .optional()
    .describe('File paths to fingerprint in the required guard receipt.'),
};

export const memoryGuardAfterToolSchema = {
  receipt_id: z
    .string()
    .refine(isNonEmptyText, 'Receipt id must not be empty')
    .describe('Receipt id returned by memory_guard_before.'),
  tool: z
    .string()
    .optional()
    .describe('Tool or command family that completed, e.g. Bash, npm test, Edit, deploy.'),
  session_id: z
    .string()
    .optional()
    .describe('Session identifier for grouping related guard events.'),
  input: z
    .unknown()
    .optional()
    .describe(
      'Tool input. Hashed and never stored raw; redacted metadata is only stored when retain_details is true.',
    ),
  output: z
    .unknown()
    .optional()
    .describe('Tool output. Same redaction and storage policy as input.'),
  outcome: z
    .enum(['succeeded', 'failed', 'blocked', 'skipped', 'unknown'])
    .optional()
    .describe('Outcome classification'),
  error_summary: z
    .string()
    .optional()
    .describe('Short error description if the action failed. Redacted and truncated to 2 KB.'),
  cwd: z.string().optional().describe('Working directory at the time of the action.'),
  files: z
    .array(z.string())
    .optional()
    .describe('File paths to fingerprint (size + mtime + content hash).'),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Arbitrary structured metadata (redacted before storage).'),
  retain_details: z
    .boolean()
    .optional()
    .describe(
      'If true, redacted input and output payloads are stored alongside hashes. Defaults to false.',
    ),
  evidence_feedback: z
    .record(z.string(), z.enum(['used', 'helpful', 'wrong']))
    .optional()
    .describe('Map of evidence ids from the guard receipt to memory validation outcomes.'),
};

export const memoryReflexesToolSchema = {
  ...memoryPreflightToolSchema,
  include_preflight: z
    .boolean()
    .optional()
    .describe('If true, include the full underlying preflight report.'),
};
