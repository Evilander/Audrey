import { monotonicFactory } from 'ulid';
import { createHash } from 'node:crypto';

const monotonic = monotonicFactory();

export function generateId() {
  return monotonic();
}

export function generateDeterministicId(...parts) {
  const input = JSON.stringify(parts);
  return createHash('sha256').update(input).digest('hex').slice(0, 26);
}
