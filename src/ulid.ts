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
