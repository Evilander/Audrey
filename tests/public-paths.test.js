import { describe, expect, it } from 'vitest';
import { containsLocalPath } from '../benchmarks/public-paths.mjs';

describe('public path detection', () => {
  it('detects real Windows paths and file URLs', () => {
    expect(containsLocalPath('source C:\\Users\\alice\\repo')).toBe(true);
    expect(containsLocalPath('source B:/Projects/Audrey')).toBe(true);
    expect(containsLocalPath('source C:\\$Recycle.Bin')).toBe(true);
    expect(containsLocalPath('source C:\\[private]\\repo')).toBe(true);
    expect(containsLocalPath('source C:\\équipe\\repo')).toBe(true);
    expect(containsLocalPath('source C:\\')).toBe(true);
    expect(containsLocalPath('file:///home/alice/repo')).toBe(true);
  });

  it('ignores drive-like byte sequences without an ASCII path segment', () => {
    expect(containsLocalPath(`binary z:/\u00e9\u0005\u0099`)).toBe(false);
  });
});
