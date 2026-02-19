import { ulid } from 'ulid';
import { createHash } from 'node:crypto';

export function generateId() {
  return ulid();
}

export function generateDeterministicId(...parts) {
  const input = JSON.stringify(parts);
  return createHash('sha256').update(input).digest('hex').slice(0, 26);
}
