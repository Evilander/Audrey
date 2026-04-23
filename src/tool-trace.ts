/**
 * High-level API for capturing agent tool traces.
 *
 * Contract: raw tool input / output / error text NEVER leaves this module
 * without going through redact(). The default behavior is to keep only
 * metadata (content hash, redacted error summary, file fingerprints) —
 * opting into retainDetails pulls in the actual payload, still redacted.
 */

import { createHash } from 'node:crypto';
import { statSync, readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

import {
  insertEvent,
  type EventOutcome,
  type EventType,
  type MemoryEvent,
  type RedactionState,
} from './events.js';
import { redact, redactJson, summarizeRedactions, type RedactionHit } from './redact.js';

const MAX_ERROR_SUMMARY_CHARS = 2000;

export interface ObserveToolInput {
  event: EventType | string;
  tool: string;
  source?: string;
  sessionId?: string;
  actorAgent?: string;
  input?: unknown;
  output?: unknown;
  outcome?: EventOutcome;
  errorSummary?: string;
  cwd?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
  retainDetails?: boolean;
}

export interface ObserveToolResult {
  event: MemoryEvent;
  redactions: RedactionHit[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashOf(value: unknown): string | null {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  return sha256(text);
}

function fingerprintFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    if (stat.size === 0) return `${path}|0|${stat.mtimeMs.toFixed(0)}|empty`;
    if (stat.size > 16 * 1024 * 1024) {
      // Files over 16 MB get a size/mtime-only fingerprint. Avoids blowing
      // out memory on huge binaries while still giving us a change signal.
      return `${path}|${stat.size}|${stat.mtimeMs.toFixed(0)}|skip`;
    }
    const contentHash = sha256(readFileSync(path).toString('hex'));
    return `${path}|${stat.size}|${stat.mtimeMs.toFixed(0)}|${contentHash.slice(0, 16)}`;
  } catch {
    return null;
  }
}

function safeErrorSummary(input: string | undefined): { text: string | null; hits: RedactionHit[] } {
  if (!input) return { text: null, hits: [] };
  const trimmed = input.length > MAX_ERROR_SUMMARY_CHARS
    ? input.slice(0, MAX_ERROR_SUMMARY_CHARS) + '…[truncated]'
    : input;
  const result = redact(trimmed);
  return { text: result.text, hits: result.redactions };
}

/**
 * Extract a one-line text summary from a tool result. Used when caller
 * provides raw output text; we never store the raw content, only the summary.
 */
export function summarizeOutput(output: unknown, maxChars: number = 240): string | null {
  if (output == null) return null;
  const text = typeof output === 'string' ? output : safeStringify(output);
  if (!text) return null;
  const firstLine = text.split(/\r?\n/).find(line => line.trim().length > 0) ?? text;
  const trimmed = firstLine.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1) + '…';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeHits(...sets: RedactionHit[][]): RedactionHit[] {
  const counts = new Map<string, number>();
  for (const set of sets) {
    for (const hit of set) {
      counts.set(hit.class, (counts.get(hit.class) ?? 0) + hit.count);
    }
  }
  return [...counts.entries()].map(([cls, count]) => ({ class: cls as RedactionHit['class'], count }));
}

export function observeTool(db: Database.Database, input: ObserveToolInput): ObserveToolResult {
  const errorSummary = safeErrorSummary(input.errorSummary);
  const metadataRaw: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };

  if (input.retainDetails) {
    if (input.input !== undefined) metadataRaw.redacted_input = input.input;
    if (input.output !== undefined) metadataRaw.redacted_output = input.output;
  } else {
    const summary = summarizeOutput(input.output);
    if (summary) metadataRaw.output_summary = summary;
  }

  const { value: redactedMetadata, redactions: metadataHits } = redactJson(metadataRaw);
  const fileFingerprints = (input.files ?? [])
    .map(fingerprintFile)
    .filter((fp): fp is string => fp != null);

  const allHits = mergeHits(errorSummary.hits, metadataHits);
  let redactionState: RedactionState;
  if (allHits.length > 0) {
    redactionState = 'redacted';
  } else if (input.retainDetails) {
    redactionState = 'clean';
  } else {
    redactionState = 'unreviewed';
  }

  const finalMetadata = redactedMetadata && Object.keys(redactedMetadata as Record<string, unknown>).length > 0
    ? {
        ...(redactedMetadata as Record<string, unknown>),
        ...(allHits.length > 0 ? { redactions: summarizeRedactions(allHits) } : {}),
      }
    : (allHits.length > 0 ? { redactions: summarizeRedactions(allHits) } : null);

  const event = insertEvent(db, {
    sessionId: input.sessionId ?? null,
    eventType: input.event,
    source: input.source ?? 'tool-trace',
    actorAgent: input.actorAgent ?? null,
    toolName: input.tool,
    inputHash: hashOf(input.input),
    outputHash: hashOf(input.output),
    outcome: input.outcome ?? (input.event === 'PostToolUseFailure' ? 'failed' : null),
    errorSummary: errorSummary.text,
    cwd: input.cwd ?? null,
    fileFingerprints,
    redactionState,
    metadata: finalMetadata,
  });

  return { event, redactions: allHits };
}
