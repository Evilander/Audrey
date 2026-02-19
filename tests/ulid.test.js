import { describe, it, expect } from 'vitest';
import { generateId, generateDeterministicId } from '../src/ulid.js';

describe('ULID generation', () => {
  it('generates a 26-character ULID string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(26);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('generates time-sortable IDs (later ID > earlier ID)', () => {
    const a = generateId();
    const b = generateId();
    expect(b > a).toBe(true);
  });

  it('generates deterministic ID from inputs', () => {
    const id1 = generateDeterministicId('consolidation', 'run-1', ['ep-1', 'ep-2']);
    const id2 = generateDeterministicId('consolidation', 'run-1', ['ep-1', 'ep-2']);
    expect(id1).toBe(id2);
  });

  it('deterministic IDs differ with different inputs', () => {
    const id1 = generateDeterministicId('consolidation', 'run-1', ['ep-1']);
    const id2 = generateDeterministicId('consolidation', 'run-1', ['ep-2']);
    expect(id1).not.toBe(id2);
  });
});
