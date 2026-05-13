/**
 * High-level API for capturing agent tool traces.
 *
 * Contract: raw tool input / output / error text NEVER leaves this module
 * without going through redact(). The default behavior is to keep only
 * metadata (content hash, redacted error summary, file fingerprints) —
 * opting into retainDetails pulls in the actual payload, still redacted.
 */

import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';

import {
  insertEvent,
  type EventOutcome,
  type EventType,
  type MemoryEvent,
  type RedactionState,
} from './events.js';
import { redact, redactJson, summarizeRedactions, truncateRedactedText, type RedactionHit } from './redact.js';

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

function canonicalPath(path: string): string {
  return realpathSync(path).replace(/^\\\\\?\\/, '');
}

function isInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fingerprintFile(path: string, cwd: string | undefined): string | null {
  try {
    const base = canonicalPath(resolve(cwd || process.cwd()));
    const resolved = resolve(base, path);
    if (!existsSync(resolved)) return null;
    const canonical = canonicalPath(resolved);
    if (!isInside(base, canonical)) return null;
    const stat = statSync(canonical);
    if (!stat.isFile()) return null;
    const rel = relative(base, canonical).replace(/\\/g, '/');
    return `${rel}|${stat.size}|${stat.mtimeMs.toFixed(0)}`;
  } catch {
    return null;
  }
}

function truncateText(text: string, maxChars: number, redactions: RedactionHit[] = []): string {
  return truncateRedactedText(text, maxChars, redactions);
}

function safeErrorSummary(input: string | undefined): { text: string | null; hits: RedactionHit[] } {
  if (!input) return { text: null, hits: [] };
  const result = redact(input);
  return { text: truncateText(result.text, MAX_ERROR_SUMMARY_CHARS, result.redactions), hits: result.redactions };
}

/**
 * Extract a one-line text summary from a tool result. Used when caller
 * provides raw output text; we never store the raw content, only the summary.
 */
export function summarizeOutput(output: unknown, maxChars: number = 240): string | null {
  return summarizeOutputWithRedactions(output, maxChars).text;
}

function summarizeOutputWithRedactions(output: unknown, maxChars: number = 240): { text: string | null; hits: RedactionHit[] } {
  if (output == null) return { text: null, hits: [] };
  const text = typeof output === 'string' ? output : safeStringify(output);
  if (!text) return { text: null, hits: [] };
  const firstLine = text.split(/\r?\n/).find(line => line.trim().length > 0) ?? text;
  const trimmed = firstLine.trim();
  if (!trimmed) return { text: null, hits: [] };
  const result = redact(trimmed);
  return { text: truncateText(result.text, maxChars, result.redactions), hits: result.redactions };
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
  const outputSummary = input.retainDetails
    ? { text: null, hits: [] as RedactionHit[] }
    : summarizeOutputWithRedactions(input.output);
  const metadataRaw: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };

  if (input.retainDetails) {
    if (input.input !== undefined) metadataRaw.redacted_input = input.input;
    if (input.output !== undefined) metadataRaw.redacted_output = input.output;
  } else {
    if (outputSummary.text) metadataRaw.output_summary = outputSummary.text;
  }

  const { value: redactedMetadata, redactions: metadataHits } = redactJson(metadataRaw);
  const fileFingerprints = (input.files ?? [])
    .slice(0, 50)
    .map(file => fingerprintFile(file, input.cwd))
    .filter((fp): fp is string => fp != null);

  const allHits = mergeHits(errorSummary.hits, outputSummary.hits, metadataHits);
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
