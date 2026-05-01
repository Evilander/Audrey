import { monotonicFactory } from 'ulid';
import { createHash } from 'node:crypto';

const monotonic = monotonicFactory();

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateId(): string {
  return monotonic();
}

// Stable JSON serializer: sorts object keys, normalizes Date → ISO string, rejects
// values without a defined deterministic representation. Used so equal logical
// inputs always produce the same hash regardless of object construction order.
function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    throw new TypeError(`generateDeterministicId: unsupported value of type ${typeof value}`);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('generateDeterministicId: circular reference detected');
    }
    seen.add(value);
    return value.map((v) => canonicalize(v, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError('generateDeterministicId: circular reference detected');
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v, seen);
    return out;
  }
  return value;
}

function bytesToCrockford(bytes: Buffer): string {
  // Encode 16 bytes (128 bits) into 26 Crockford Base32 chars (5 bits each).
  // A 26-char output covers 130 bits, so the leading 2 bits are padded to 0.
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  bits <<= 2n;
  const out = new Array<string>(26);
  for (let i = 25; i >= 0; i--) {
    out[i] = CROCKFORD[Number(bits & 31n)]!;
    bits >>= 5n;
  }
  return out.join('');
}

export function generateDeterministicId(...parts: unknown[]): string {
  const input = JSON.stringify(canonicalize(parts));
  const digest = createHash('sha256').update(input).digest();
  return bytesToCrockford(digest.subarray(0, 16));
}
