import type { EmbeddingProvider } from './types.js';

export function cosineSimilarity(bufA: Buffer, bufB: Buffer, provider: EmbeddingProvider): number {
  const a = provider.bufferToVector(bufA);
  const b = provider.bufferToVector(bufB);
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector length mismatch (a=${a.length}, b=${b.length})`);
  }
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

export function daysBetween(dateStr: string, now: Date): number {
  const parsed = new Date(dateStr).getTime();
  if (Number.isNaN(parsed)) {
    throw new TypeError(`daysBetween: invalid date string: ${dateStr}`);
  }
  return Math.max(0, (now.getTime() - parsed) / (1000 * 60 * 60 * 24));
}

export function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

export function requireAgent(agent: unknown, fallback?: string): string {
  const resolved = agent ?? fallback;
  if (typeof resolved !== 'string' || resolved.trim().length === 0) {
    throw new Error('agent must be a non-empty string');
  }
  const normalized = resolved.trim();
  if (normalized.length > 128) {
    throw new Error('agent must be at most 128 characters');
  }
  return normalized;
}

export function resolveMemoryScope(
  scope: unknown,
  fallback: 'agent' | 'shared',
): 'agent' | 'shared' {
  if (scope === undefined) return fallback;
  if (scope === 'agent' || scope === 'shared') return scope;
  throw new Error('scope must be "agent" or "shared"');
}

export function requireApiKey(
  apiKey: string | undefined | null,
  operation: string,
  envVar: string,
): asserts apiKey is string {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error(`${operation} requires ${envVar}`);
  }
}

export async function describeHttpError(response: {
  status: number;
  text: () => Promise<string>;
}): Promise<string> {
  if (typeof response.text !== 'function') {
    return `${response.status}`;
  }
  const body = await response.text().catch(() => '');
  const normalized = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  return normalized ? `${response.status} ${normalized}` : `${response.status}`;
}
