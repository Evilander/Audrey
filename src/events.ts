/**
 * memory_events CRUD. Thin wrapper — business logic (hashing, redaction,
 * summarization) lives in tool-trace.ts.
 */

import Database from 'better-sqlite3';
import { generateId } from './ulid.js';

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

export type EventOutcome = 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'unknown';
export type RedactionState = 'unreviewed' | 'redacted' | 'clean' | 'quarantined';

export interface MemoryEvent {
  id: string;
  session_id: string | null;
  event_type: EventType | string;
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
  metadata: string | null;
  created_at: string;
}

export interface EventInsert {
  id?: string;
  sessionId?: string | null;
  eventType: EventType | string;
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
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface EventQuery {
  sessionId?: string;
  toolName?: string;
  eventType?: string;
  outcome?: EventOutcome;
  since?: string;
  limit?: number;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

export function insertEvent(db: Database.Database, input: EventInsert): MemoryEvent {
  const id = input.id ?? generateId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const redactionState = input.redactionState ?? 'unreviewed';
  const fileFingerprints = input.fileFingerprints && input.fileFingerprints.length > 0
    ? JSON.stringify(input.fileFingerprints)
    : null;
  const metadata = toJson(input.metadata ?? null);

  db.prepare(`
    INSERT INTO memory_events (
      id, session_id, event_type, source, actor_agent, tool_name,
      input_hash, output_hash, outcome, error_summary, cwd,
      file_fingerprints, redaction_state, metadata, created_at
    ) VALUES (
      @id, @sessionId, @eventType, @source, @actorAgent, @toolName,
      @inputHash, @outputHash, @outcome, @errorSummary, @cwd,
      @fileFingerprints, @redactionState, @metadata, @createdAt
    )
  `).run({
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
    metadata,
    created_at: createdAt,
  };
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
  if (query.since) {
    conditions.push('created_at >= @since');
    params.since = query.since;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));

  return db.prepare(
    `SELECT * FROM memory_events ${where} ORDER BY created_at DESC LIMIT ${limit}`
  ).all(params) as MemoryEvent[];
}

export function countEvents(db: Database.Database, query: EventQuery = {}): number {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.sessionId) { conditions.push('session_id = @sessionId'); params.sessionId = query.sessionId; }
  if (query.toolName) { conditions.push('tool_name = @toolName'); params.toolName = query.toolName; }
  if (query.eventType) { conditions.push('event_type = @eventType'); params.eventType = query.eventType; }
  if (query.outcome) { conditions.push('outcome = @outcome'); params.outcome = query.outcome; }
  if (query.since) { conditions.push('created_at >= @since'); params.since = query.since; }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = db.prepare(`SELECT COUNT(*) AS c FROM memory_events ${where}`).get(params) as { c: number };
  return row.c;
}

export interface FailurePattern {
  tool_name: string;
  failure_count: number;
  last_error_summary: string | null;
  last_failed_at: string;
}

/**
 * Tools that have failed recently, most recent first. Feeds PreToolUse
 * preflight warnings: "this command failed last time — here's what fixed it."
 */
export function recentFailures(
  db: Database.Database,
  options: { since?: string; limit?: number } = {},
): FailurePattern[] {
  const since = options.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.max(1, Math.min(options.limit ?? 20, 200));

  return db.prepare(`
    SELECT tool_name,
           COUNT(*) AS failure_count,
           MAX(created_at) AS last_failed_at,
           (
             SELECT error_summary FROM memory_events e2
             WHERE e2.tool_name = e1.tool_name
               AND e2.outcome = 'failed'
               AND e2.created_at >= @since
             ORDER BY e2.created_at DESC LIMIT 1
           ) AS last_error_summary
    FROM memory_events e1
    WHERE outcome = 'failed'
      AND tool_name IS NOT NULL
      AND created_at >= @since
    GROUP BY tool_name
    ORDER BY last_failed_at DESC
    LIMIT ${limit}
  `).all({ since }) as FailurePattern[];
}

export function deleteEventsBefore(db: Database.Database, cutoffIso: string): number {
  const result = db.prepare('DELETE FROM memory_events WHERE created_at < ?').run(cutoffIso);
  return Number(result.changes);
}
