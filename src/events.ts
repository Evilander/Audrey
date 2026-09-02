/**
 * memory_events CRUD. Thin wrapper — business logic (hashing, redaction,
 * summarization) lives in tool-trace.ts.
 */

import Database from 'better-sqlite3';
import { namespaceMatcher } from './project.js';
import { generateId } from './ulid.js';
import { requireAgent } from './utils.js';

export type EventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PreCompact'
  | 'PostCompact'
  | 'SessionStart'
  | 'SessionStop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Observation';

export type EventTypeLike = EventType | (string & {});

export type EventOutcome = 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'unknown';
export type RedactionState = 'unreviewed' | 'redacted' | 'clean' | 'quarantined';

export interface MemoryEvent {
  id: string;
  session_id: string | null;
  event_type: EventTypeLike;
  source: string;
  actor_agent: string | null;
  tool_name: string | null;
  input_hash: string | null;
  output_hash: string | null;
  outcome: EventOutcome | null;
  error_summary: string | null;
  cwd: string | null;
  file_fingerprints: string | null;
  redaction_state: RedactionState;
  action_key: string | null;
  hook_host: string | null;
  hook_tool_use_id: string | null;
  receipt_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface EventInsert {
  id?: string;
  sessionId?: string | null;
  eventType: EventTypeLike;
  source: string;
  actorAgent?: string | null;
  toolName?: string | null;
  inputHash?: string | null;
  outputHash?: string | null;
  outcome?: EventOutcome | null;
  errorSummary?: string | null;
  cwd?: string | null;
  fileFingerprints?: string[] | null;
  redactionState?: RedactionState;
  actionKey?: string | null;
  hookHost?: string | null;
  hookToolUseId?: string | null;
  receiptId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface EventQuery {
  sessionId?: string;
  toolName?: string;
  eventType?: string;
  outcome?: EventOutcome;
  actorAgent?: string;
  since?: string;
  limit?: number;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

const ACTION_KEY_PATTERN = /^[a-f0-9]{64}$/;

function indexedText(explicit: string | null | undefined, metadataValue: unknown): string | null {
  const value = explicit !== undefined ? explicit : metadataValue;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function insertEvent(db: Database.Database, input: EventInsert): MemoryEvent {
  const id = input.id ?? generateId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const redactionState = input.redactionState ?? 'unreviewed';
  const fileFingerprints =
    input.fileFingerprints && input.fileFingerprints.length > 0
      ? JSON.stringify(input.fileFingerprints)
      : null;
  const metadata = toJson(input.metadata ?? null);
  const actionKeyCandidate =
    input.actionKey !== undefined ? input.actionKey : input.metadata?.audrey_guard_action_key;
  const actionKey =
    typeof actionKeyCandidate === 'string' && ACTION_KEY_PATTERN.test(actionKeyCandidate)
      ? actionKeyCandidate
      : null;
  const hookHost = indexedText(input.hookHost, input.metadata?.autopilot_host);
  const hookToolUseId = indexedText(input.hookToolUseId, input.metadata?.autopilot_tool_use_id);
  const receiptId = indexedText(input.receiptId, input.metadata?.receipt_id);

  db.prepare(
    `
    INSERT INTO memory_events (
      id, session_id, event_type, source, actor_agent, tool_name,
      input_hash, output_hash, outcome, error_summary, cwd,
      file_fingerprints, redaction_state, action_key, hook_host,
      hook_tool_use_id, receipt_id, metadata, created_at
    ) VALUES (
      @id, @sessionId, @eventType, @source, @actorAgent, @toolName,
      @inputHash, @outputHash, @outcome, @errorSummary, @cwd,
      @fileFingerprints, @redactionState, @actionKey, @hookHost,
      @hookToolUseId, @receiptId, @metadata, @createdAt
    )
  `,
  ).run({
    id,
    sessionId: input.sessionId ?? null,
    eventType: input.eventType,
    source: input.source,
    actorAgent: input.actorAgent ?? null,
    toolName: input.toolName ?? null,
    inputHash: input.inputHash ?? null,
    outputHash: input.outputHash ?? null,
    outcome: input.outcome ?? null,
    errorSummary: input.errorSummary ?? null,
    cwd: input.cwd ?? null,
    fileFingerprints,
    redactionState,
    actionKey,
    hookHost,
    hookToolUseId,
    receiptId,
    metadata,
    createdAt,
  });

  return {
    id,
    session_id: input.sessionId ?? null,
    event_type: input.eventType,
    source: input.source,
    actor_agent: input.actorAgent ?? null,
    tool_name: input.toolName ?? null,
    input_hash: input.inputHash ?? null,
    output_hash: input.outputHash ?? null,
    outcome: input.outcome ?? null,
    error_summary: input.errorSummary ?? null,
    cwd: input.cwd ?? null,
    file_fingerprints: fileFingerprints,
    redaction_state: redactionState,
    action_key: actionKey,
    hook_host: hookHost,
    hook_tool_use_id: hookToolUseId,
    receipt_id: receiptId,
    metadata,
    created_at: createdAt,
  };
}

export interface ExactActionHistoryOptions {
  actionKey: string;
  actorAgent: string;
  since?: string;
}

// A non-zero exit from a read-only probe (grep with no match, ls of a
// missing path) is recorded honestly as a failure, but Autopilot flags it so
// no Guard path treats it as a lesson. The CASE keeps json_extract off rows
// whose metadata is absent or malformed, which would otherwise raise.
const READ_ONLY_FAILURE = `(
  CASE WHEN metadata IS NOT NULL AND json_valid(metadata)
       THEN COALESCE(json_extract(metadata, '$.read_only'), 0) = 1
       ELSE 0 END
)`;

export function exactActionHistory(
  db: Database.Database,
  options: ExactActionHistoryOptions,
): MemoryEvent[] {
  const actorAgent = requireAgent(options.actorAgent);
  return db
    .prepare(
      `
      SELECT * FROM memory_events
      WHERE action_key = @actionKey
        AND (
          (event_type = 'PostToolUse' AND outcome = 'succeeded')
          OR (event_type = 'PostToolUseFailure' AND outcome = 'failed' AND NOT ${READ_ONLY_FAILURE})
        )
        AND (actor_agent IS NULL OR actor_agent = @actorAgent)
        ${options.since ? 'AND created_at >= @since' : ''}
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all({
      actionKey: options.actionKey,
      actorAgent,
      ...(options.since ? { since: options.since } : {}),
    }) as MemoryEvent[];
}

export function listEvents(db: Database.Database, query: EventQuery = {}): MemoryEvent[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.sessionId) {
    conditions.push('session_id = @sessionId');
    params.sessionId = query.sessionId;
  }
  if (query.toolName) {
    conditions.push('tool_name = @toolName');
    params.toolName = query.toolName;
  }
  if (query.eventType) {
    conditions.push('event_type = @eventType');
    params.eventType = query.eventType;
  }
  if (query.outcome) {
    conditions.push('outcome = @outcome');
    params.outcome = query.outcome;
  }
  if (query.actorAgent !== undefined) {
    conditions.push('actor_agent = @actorAgent');
    params.actorAgent = requireAgent(query.actorAgent);
  }
  if (query.since) {
    conditions.push('created_at >= @since');
    params.since = query.since;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));

  return db
    .prepare(`SELECT * FROM memory_events ${where} ORDER BY created_at DESC LIMIT ${limit}`)
    .all(params) as MemoryEvent[];
}

export function countEvents(db: Database.Database, query: EventQuery = {}): number {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.sessionId) {
    conditions.push('session_id = @sessionId');
    params.sessionId = query.sessionId;
  }
  if (query.toolName) {
    conditions.push('tool_name = @toolName');
    params.toolName = query.toolName;
  }
  if (query.eventType) {
    conditions.push('event_type = @eventType');
    params.eventType = query.eventType;
  }
  if (query.outcome) {
    conditions.push('outcome = @outcome');
    params.outcome = query.outcome;
  }
  if (query.actorAgent !== undefined) {
    conditions.push('actor_agent = @actorAgent');
    params.actorAgent = requireAgent(query.actorAgent);
  }
  if (query.since) {
    conditions.push('created_at >= @since');
    params.since = query.since;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = db.prepare(`SELECT COUNT(*) AS c FROM memory_events ${where}`).get(params) as {
    c: number;
  };
  return row.c;
}

export interface FailurePattern {
  tool_name: string;
  failure_count: number;
  last_error_summary: string | null;
  last_failed_at: string;
  last_succeeded_at: string | null;
}

export interface RecentFailureOptions {
  since?: string;
  limit?: number;
  actorAgent?: string;
  /**
   * Scope failure patterns to the project containing this directory. Events
   * recorded without a cwd are still included — they cannot be proven foreign.
   */
  cwd?: string;
  /**
   * By default a failure pattern is extinguished once the same tool succeeds
   * after it (within the same scope): the streak is over, so the warning would
   * be stale noise. Pass true to see resolved patterns too (diagnostics).
   */
  includeResolved?: boolean;
}

function matchingCwds(
  db: Database.Database,
  cwd: string,
  since: string,
  actorAgent: string | undefined,
): string[] {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT cwd FROM memory_events
    WHERE cwd IS NOT NULL
      AND tool_name IS NOT NULL
      AND outcome IN ('failed', 'succeeded')
      AND created_at >= @since
      ${actorAgent ? 'AND actor_agent = @actorAgent' : ''}
  `,
    )
    .all({ since, ...(actorAgent ? { actorAgent } : {}) }) as Array<{ cwd: string }>;
  const matches = namespaceMatcher(cwd);
  return rows.map(row => row.cwd).filter(matches);
}

/**
 * Boolean SQL expression deciding whether a row (already known to be a
 * 'failed' or 'succeeded' event, per `kind`) counts as in-scope for the
 * project at `options.cwd`. Failures without a recorded cwd cannot be
 * proven foreign, so they stay visible (fail toward warning). Successes are
 * held to the opposite standard: only a success provably from this project
 * may extinguish a local streak.
 */
function cwdVisibility(kind: 'failure' | 'success', cwdNames: string[] | undefined): string {
  if (cwdNames === undefined) return '1';
  if (kind === 'failure') {
    return cwdNames.length > 0 ? `(cwd IS NULL OR cwd IN (${cwdNames.join(', ')}))` : 'cwd IS NULL';
  }
  return cwdNames.length > 0 ? `cwd IN (${cwdNames.join(', ')})` : '0';
}

/**
 * Tools with an unresolved failure streak, most recent first. Feeds PreToolUse
 * preflight warnings: "this command failed last time — here's what fixed it."
 *
 * failure_count counts failures since the tool's last success in scope
 * (extinction: disconfirming evidence retires the warning), not raw failures
 * in the window.
 *
 * Implemented as one filtered pass over memory_events plus per-tool window
 * functions, rather than a correlated subquery (error summary, last success)
 * and a NOT EXISTS extinction check evaluated per candidate row — the
 * per-row version turns near-quadratic on a large event table.
 *
 * `scoped` must stay MATERIALIZED: without the hint the planner evaluates it
 * once per referencing CTE as co-routines over the low-selectivity outcome
 * index (~30x slower at 50k rows, measured).
 */
export function recentFailures(
  db: Database.Database,
  options: RecentFailureOptions = {},
): FailurePattern[] {
  const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));
  const actorAgent =
    options.actorAgent === undefined ? undefined : requireAgent(options.actorAgent);

  const params: Record<string, unknown> = { since };
  if (actorAgent) params.actorAgent = actorAgent;

  let cwdNames: string[] | undefined;
  if (options.cwd) {
    cwdNames = matchingCwds(db, options.cwd, since, actorAgent).map((value, index) => {
      params[`cwd${index}`] = value;
      return `@cwd${index}`;
    });
  }

  const failureVisible = cwdVisibility('failure', cwdNames);
  const successVisible = cwdVisibility('success', cwdNames);

  // A failure is active while no success postdates it. Same-millisecond ties
  // order by ULID id, which is monotonic within a process — last_success
  // below breaks its own ties the same way, so a failure and the success
  // that would extinguish it always agree on which one is "later".
  const activeFailures = options.includeResolved
    ? 'SELECT * FROM failures_with_boundary'
    : `SELECT * FROM failures_with_boundary
       WHERE last_succeeded_at IS NULL
          OR created_at > last_succeeded_at
          OR (created_at = last_succeeded_at AND id > last_succeeded_id)`;

  return db
    .prepare(
      `
    WITH scoped AS MATERIALIZED (
      SELECT id, tool_name, outcome, created_at, error_summary
      FROM memory_events
      WHERE tool_name IS NOT NULL
        AND outcome IN ('failed', 'succeeded')
        AND created_at >= @since
        ${actorAgent ? 'AND actor_agent = @actorAgent' : ''}
        AND (
          (outcome = 'failed' AND ${failureVisible} AND NOT ${READ_ONLY_FAILURE})
          OR (outcome = 'succeeded' AND ${successVisible})
        )
    ),
    failures AS (
      SELECT id, tool_name, created_at, error_summary FROM scoped WHERE outcome = 'failed'
    ),
    successes AS (
      SELECT id, tool_name, created_at FROM scoped WHERE outcome = 'succeeded'
    ),
    last_success AS (
      SELECT tool_name, created_at AS last_succeeded_at, id AS last_succeeded_id
      FROM (
        SELECT tool_name, created_at, id,
               ROW_NUMBER() OVER (
                 PARTITION BY tool_name ORDER BY created_at DESC, id DESC
               ) AS rn
        FROM successes
      )
      WHERE rn = 1
    ),
    failures_with_boundary AS (
      SELECT f.id, f.tool_name, f.created_at, f.error_summary,
             ls.last_succeeded_at, ls.last_succeeded_id
      FROM failures f
      LEFT JOIN last_success ls ON ls.tool_name = f.tool_name
    ),
    active_failures AS (${activeFailures}),
    ranked AS (
      SELECT tool_name, created_at, error_summary, last_succeeded_at,
             ROW_NUMBER() OVER (
               PARTITION BY tool_name ORDER BY created_at DESC, id DESC
             ) AS rn,
             COUNT(*) OVER (PARTITION BY tool_name) AS failure_count,
             MAX(created_at) OVER (PARTITION BY tool_name) AS last_failed_at
      FROM active_failures
    )
    SELECT tool_name, failure_count, last_failed_at,
           error_summary AS last_error_summary, last_succeeded_at
    FROM ranked
    WHERE rn = 1
    ORDER BY last_failed_at DESC
    LIMIT ${limit}
  `,
    )
    .all(params) as FailurePattern[];
}

/**
 * Default memory_events retention window. Guarded tool calls write at least
 * two rows apiece (PreToolUse + a PostToolUse/PostToolUseFailure receipt),
 * so an install with no retention keeps growing for its whole lifetime —
 * that unbounded growth is what lets recentFailures() and createDatabase()'s
 * embedding sync get slow. 30 days keeps failure-streak history well beyond
 * recentFailures()'s own 7-day default lookback while bounding table size
 * for long-running installs.
 */
export const DEFAULT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_DELETE_BATCH_SIZE = 1000;
const MAX_DELETE_BATCH_SIZE = 50000;

export interface DeleteEventsBeforeOptions {
  /**
   * Rows deleted per statement. Deleting in bounded batches (rather than one
   * DELETE spanning the whole backlog) keeps any single write short even
   * when a long-neglected store has millions of stale rows to purge.
   * Defaults to 1000, capped at 50000.
   */
  batchSize?: number;
}

/**
 * Deletes memory_events rows older than cutoffIso, batching so a large
 * purge cannot hold one long-running write. Returns the total number of
 * rows deleted across all batches.
 */
export function deleteEventsBefore(
  db: Database.Database,
  cutoffIso: string,
  options: DeleteEventsBeforeOptions = {},
): number {
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? DEFAULT_DELETE_BATCH_SIZE, MAX_DELETE_BATCH_SIZE),
  );
  const deleteBatch = db.prepare(
    `DELETE FROM memory_events
     WHERE id IN (SELECT id FROM memory_events WHERE created_at < ? LIMIT ?)`,
  );

  let totalDeleted = 0;
  for (;;) {
    const result = deleteBatch.run(cutoffIso, batchSize);
    const deleted = Number(result.changes);
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return totalDeleted;
}
