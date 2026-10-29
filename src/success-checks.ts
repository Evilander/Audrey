import { createHash } from 'node:crypto';
import type { EventOutcome } from './events.js';
import { redact } from './redact.js';

export type SuccessValue = string | number | boolean | null;

/** A required comparison against the returned output, declared before acting. */
export interface SuccessCheck {
  id: string;
  /** JSON Pointer into afterAction.output; an empty pointer selects the output. */
  pointer: string;
  equals: SuccessValue;
  /** Parse the selected string as JSON before comparing its scalar value. */
  parseJson?: boolean;
}

interface CompiledCheck {
  id: string;
  pointer: string;
  parseJson: boolean;
  expectedDigest: string;
}

export interface CompiledSuccessChecks {
  version: 1;
  digest: string;
  checks: CompiledCheck[];
}

export interface SuccessCheckResult {
  id: string;
  status: 'passed' | 'failed' | 'unknown';
  reason: 'matched' | 'mismatch' | 'missing_value' | 'invalid_json' | 'unsupported_value';
}

export interface SuccessVerification {
  contract_digest: string;
  status: 'passed' | 'failed' | 'unknown' | 'not_run';
  checks: SuccessCheckResult[];
}

const MAX_CHECKS = 16;
const MAX_POINTER_CHARS = 512;
const MAX_VALUE_CHARS = 4096;
const MAX_JSON_CHARS = 65536;
const MISSING = Symbol('missing');
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function scalar(value: unknown): value is SuccessValue {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function validPointer(pointer: unknown): pointer is string {
  return (
    typeof pointer === 'string' &&
    pointer.length <= MAX_POINTER_CHARS &&
    (pointer === '' || pointer.startsWith('/')) &&
    !/~(?![01])/u.test(pointer) &&
    redact(pointer).text === pointer
  );
}

function validId(id: unknown): id is string {
  return (
    typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id) && redact(id).text === id
  );
}

export function compileSuccessChecks(value: unknown): CompiledSuccessChecks | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS) {
    throw new Error(`successChecks must contain between 1 and ${MAX_CHECKS} checks`);
  }
  const ids = new Set<string>();
  const checks = value.map((raw: unknown): CompiledCheck => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Each success check must be an object');
    }
    const check = raw as Record<string, unknown>;
    if (
      Object.keys(check).some(key => !['id', 'pointer', 'equals', 'parseJson'].includes(key)) ||
      !validId(check.id) ||
      ids.has(check.id) ||
      !validPointer(check.pointer) ||
      !Object.hasOwn(check, 'equals') ||
      !scalar(check.equals) ||
      (typeof check.equals === 'string' && check.equals.length > MAX_VALUE_CHARS) ||
      (check.parseJson !== undefined && typeof check.parseJson !== 'boolean')
    ) {
      throw new Error(
        'Invalid success check: require unique id, JSON Pointer and finite scalar equals',
      );
    }
    ids.add(check.id);
    return {
      id: check.id,
      pointer: check.pointer,
      parseJson: check.parseJson ?? false,
      expectedDigest: digest(check.equals),
    };
  });
  checks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: 1, digest: digest(checks), checks };
}

/** Reject malformed persisted contracts instead of silently skipping checks. */
export function readSuccessChecks(value: unknown): CompiledSuccessChecks | undefined {
  if (value === undefined) return undefined;
  const contract = value as CompiledSuccessChecks | null;
  const ids = new Set<string>();
  if (
    !contract ||
    contract.version !== 1 ||
    !Array.isArray(contract.checks) ||
    contract.checks.length === 0 ||
    contract.checks.length > MAX_CHECKS ||
    contract.checks.some(check => {
      if (
        !check ||
        !validId(check.id) ||
        ids.has(check.id) ||
        !validPointer(check.pointer) ||
        typeof check.parseJson !== 'boolean' ||
        typeof check.expectedDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(check.expectedDigest)
      )
        return true;
      ids.add(check.id);
      return false;
    })
  ) {
    throw new Error('Invalid success checks in Guard receipt');
  }
  // JSON object key order is not part of a contract's meaning. Reconstruct
  // canonical entries so a serializer cannot invalidate an unchanged receipt.
  const checks = contract.checks
    .map(({ id, pointer, parseJson, expectedDigest }) => ({
      id,
      pointer,
      parseJson,
      expectedDigest,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (contract.digest !== digest(checks)) {
    throw new Error('Invalid success checks in Guard receipt');
  }
  return { version: 1, digest: contract.digest, checks };
}

function select(output: unknown, pointer: string): unknown {
  let value = output;
  if (pointer === '') return value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object') return MISSING;
    // Never read inherited properties or invoke a getter on an SDK object.
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return MISSING;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !Object.hasOwn(property, 'value')) return MISSING;
    value = property.value;
  }
  return value;
}

export function verifySuccessChecks(
  contract: CompiledSuccessChecks,
  output: unknown,
  reported: EventOutcome,
): { outcome: EventOutcome; verification: SuccessVerification } {
  if (reported === 'blocked' || reported === 'skipped') {
    return {
      outcome: reported,
      verification: { contract_digest: contract.digest, status: 'not_run', checks: [] },
    };
  }
  const checks = contract.checks.map((check): SuccessCheckResult => {
    let value = select(output, check.pointer);
    if (value === MISSING || value === undefined) {
      return { id: check.id, status: 'unknown', reason: 'missing_value' };
    }
    if (check.parseJson) {
      if (typeof value !== 'string' || value.length > MAX_JSON_CHARS) {
        return { id: check.id, status: 'unknown', reason: 'invalid_json' };
      }
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return { id: check.id, status: 'unknown', reason: 'invalid_json' };
      }
    }
    if (!scalar(value)) return { id: check.id, status: 'unknown', reason: 'unsupported_value' };
    const matched =
      typeof value === 'string' && value.length > MAX_VALUE_CHARS
        ? false
        : digest(value) === check.expectedDigest;
    return {
      id: check.id,
      status: matched ? 'passed' : 'failed',
      reason: matched ? 'matched' : 'mismatch',
    };
  });
  const status = checks.some(check => check.status === 'failed')
    ? 'failed'
    : checks.some(check => check.status === 'unknown')
      ? 'unknown'
      : 'passed';
  // Verification can remove a success claim; it cannot invent execution success
  // from an unknown outcome or erase an explicitly reported execution failure.
  const outcome =
    reported === 'failed' || status === 'failed'
      ? 'failed'
      : reported === 'succeeded' && status === 'unknown'
        ? 'unknown'
        : reported;
  return { outcome, verification: { contract_digest: contract.digest, status, checks } };
}
