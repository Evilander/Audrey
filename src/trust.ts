/**
 * Control-memory trust — who is allowed to plant a durable, high-severity
 * directive in Audrey's memory.
 *
 * A memory's `source` field ('direct-observation', 'told-by-user', ...) is
 * self-reported by whoever calls encode(). Nothing about the field itself
 * proves the claim: an MCP tool call, an HTTP request, or a prompt-injected
 * agent can all set source: 'told-by-user' on content they invented. Capsule
 * categorization used to treat that claim as sufficient to escalate a
 * must-follow-tagged memory into the high-severity must_follow section that
 * feeds Guard — which means the self-report alone could force a strict-mode
 * block.
 *
 * TRUST_CONTEXT_KEY is a second, independent signal: a marker set on the
 * memory's context object by code that actually knows the content came from
 * a trusted source in-process (Autopilot capturing a real user prompt, for
 * example) rather than from an untrusted network boundary. MCP, HTTP, and
 * CLI callers all pass their `context` payload through stripReservedTrustKeys
 * before it reaches encode(), so the marker can never be forged from outside
 * the process. A trusted source without the marker is only trusted if the
 * memory predates LEGACY_TRUST_CUTOFF_ISO — the day this check shipped —
 * so memories written before this existed keep working.
 */

import type { SourceType } from './types.js';

const TRUSTED_SOURCE_LIST: readonly SourceType[] = ['direct-observation', 'told-by-user'];

export const TRUSTED_CONTROL_SOURCES: ReadonlySet<string> = new Set<string>(TRUSTED_SOURCE_LIST);

export const TRUST_CONTEXT_KEY = 'audrey_trust';
export const USER_VERIFIED_TRUST = 'user-verified';

const DEFAULT_LEGACY_TRUST_CUTOFF_ISO = '2026-08-02T00:00:00.000Z';

export const LEGACY_TRUST_CUTOFF_ISO: string =
  process.env['AUDREY_TRUST_LEGACY_CUTOFF'] || DEFAULT_LEGACY_TRUST_CUTOFF_ISO;

export type ControlTrust = 'verified' | 'legacy' | 'untrusted';

function parseContext(raw: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Malformed context degrades to "no marker found", not a thrown error.
  }
  return undefined;
}

function normalizeContext(
  context: Record<string, string> | string | null | undefined,
): Record<string, string> | undefined {
  if (context == null) return undefined;
  if (typeof context === 'string') return parseContext(context);
  if (typeof context === 'object' && !Array.isArray(context)) return context;
  return undefined;
}

function isBeforeLegacyCutoff(createdAt: string | null | undefined): boolean {
  if (typeof createdAt !== 'string') return false;
  const created = Date.parse(createdAt);
  const cutoff = Date.parse(LEGACY_TRUST_CUTOFF_ISO);
  if (Number.isNaN(created) || Number.isNaN(cutoff)) return false;
  return created < cutoff;
}

export function controlTrustFor(input: {
  source?: string | null;
  context?: Record<string, string> | string | null;
  createdAt?: string | null;
}): ControlTrust {
  const source = input.source ?? '';
  if (!TRUSTED_CONTROL_SOURCES.has(source)) return 'untrusted';

  const context = normalizeContext(input.context);
  if (context?.[TRUST_CONTEXT_KEY] === USER_VERIFIED_TRUST) return 'verified';

  return isBeforeLegacyCutoff(input.createdAt) ? 'legacy' : 'untrusted';
}

export function stripReservedTrustKeys<T extends Record<string, string>>(
  context: T | undefined,
): T | undefined {
  if (!context || !Object.prototype.hasOwnProperty.call(context, TRUST_CONTEXT_KEY)) {
    return context;
  }
  const copy = { ...context };
  delete copy[TRUST_CONTEXT_KEY as keyof T];
  return copy;
}
