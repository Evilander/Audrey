import { describe, it, expect } from 'vitest';
import {
  TRUSTED_CONTROL_SOURCES,
  TRUST_CONTEXT_KEY,
  USER_VERIFIED_TRUST,
  LEGACY_TRUST_CUTOFF_ISO,
  controlTrustFor,
  isReservedTrustKey,
  stripReservedTrustKeys,
} from '../dist/src/trust.js';

const BEFORE_CUTOFF = new Date(Date.parse(LEGACY_TRUST_CUTOFF_ISO) - 86400000).toISOString();
const AFTER_CUTOFF = new Date(Date.parse(LEGACY_TRUST_CUTOFF_ISO) + 86400000).toISOString();
const VERIFIED_CONTEXT = { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST };

describe('TRUSTED_CONTROL_SOURCES', () => {
  it('contains exactly direct-observation and told-by-user', () => {
    expect(TRUSTED_CONTROL_SOURCES.has('direct-observation')).toBe(true);
    expect(TRUSTED_CONTROL_SOURCES.has('told-by-user')).toBe(true);
    expect(TRUSTED_CONTROL_SOURCES.size).toBe(2);
  });

  it('excludes every other source type', () => {
    for (const source of ['tool-result', 'inference', 'model-generated']) {
      expect(TRUSTED_CONTROL_SOURCES.has(source)).toBe(false);
    }
  });
});

describe('controlTrustFor — full matrix', () => {
  for (const source of ['direct-observation', 'told-by-user']) {
    describe(`source: ${source}`, () => {
      it('verified — marker present', () => {
        expect(
          controlTrustFor({ source, context: VERIFIED_CONTEXT, createdAt: AFTER_CUTOFF }),
        ).toBe('verified');
      });

      it('verified regardless of createdAt when the marker is present', () => {
        expect(
          controlTrustFor({ source, context: VERIFIED_CONTEXT, createdAt: BEFORE_CUTOFF }),
        ).toBe('verified');
      });

      it('legacy — no marker, created strictly before the cutoff', () => {
        expect(controlTrustFor({ source, context: undefined, createdAt: BEFORE_CUTOFF })).toBe(
          'legacy',
        );
      });

      it('untrusted — no marker, created at/after the cutoff', () => {
        expect(controlTrustFor({ source, context: undefined, createdAt: AFTER_CUTOFF })).toBe(
          'untrusted',
        );
      });

      it('untrusted — no marker and no createdAt at all', () => {
        expect(controlTrustFor({ source, context: undefined, createdAt: undefined })).toBe(
          'untrusted',
        );
        expect(controlTrustFor({ source, context: undefined, createdAt: null })).toBe('untrusted');
      });

      it('untrusted — context present but marker value is wrong', () => {
        expect(
          controlTrustFor({
            source,
            context: { [TRUST_CONTEXT_KEY]: 'not-actually-verified' },
            createdAt: AFTER_CUTOFF,
          }),
        ).toBe('untrusted');
      });

      it('accepts the marker as a JSON string (a raw DB row context column)', () => {
        expect(
          controlTrustFor({
            source,
            context: JSON.stringify(VERIFIED_CONTEXT),
            createdAt: AFTER_CUTOFF,
          }),
        ).toBe('verified');
      });

      it('malformed JSON context degrades to no-marker instead of throwing', () => {
        expect(() =>
          controlTrustFor({ source, context: '{not valid json', createdAt: AFTER_CUTOFF }),
        ).not.toThrow();
        expect(
          controlTrustFor({ source, context: '{not valid json', createdAt: AFTER_CUTOFF }),
        ).toBe('untrusted');
        expect(
          controlTrustFor({ source, context: '{not valid json', createdAt: BEFORE_CUTOFF }),
        ).toBe('legacy');
      });
    });
  }

  for (const source of ['tool-result', 'inference', 'model-generated', '', 'made-up-source']) {
    it(`untrusted for every non-control source (${JSON.stringify(source)}), even with a forged marker`, () => {
      expect(controlTrustFor({ source, context: VERIFIED_CONTEXT, createdAt: BEFORE_CUTOFF })).toBe(
        'untrusted',
      );
      expect(controlTrustFor({ source, context: VERIFIED_CONTEXT, createdAt: AFTER_CUTOFF })).toBe(
        'untrusted',
      );
    });
  }

  it('untrusted when source is missing, null, or undefined', () => {
    expect(controlTrustFor({ context: VERIFIED_CONTEXT, createdAt: BEFORE_CUTOFF })).toBe(
      'untrusted',
    );
    expect(
      controlTrustFor({ source: null, context: VERIFIED_CONTEXT, createdAt: BEFORE_CUTOFF }),
    ).toBe('untrusted');
    expect(
      controlTrustFor({ source: undefined, context: VERIFIED_CONTEXT, createdAt: BEFORE_CUTOFF }),
    ).toBe('untrusted');
  });

  it('never throws on thoroughly malformed input', () => {
    const inputs = [
      {},
      { source: 'direct-observation', context: null, createdAt: 'not-a-date' },
      { source: 'direct-observation', context: '[]', createdAt: BEFORE_CUTOFF },
      { source: 'direct-observation', context: '42', createdAt: BEFORE_CUTOFF },
      { source: 'direct-observation', context: 42, createdAt: BEFORE_CUTOFF },
      { source: 'direct-observation', context: ['a', 'b'], createdAt: BEFORE_CUTOFF },
      { source: 123, context: VERIFIED_CONTEXT, createdAt: BEFORE_CUTOFF },
    ];
    for (const input of inputs) {
      expect(() => controlTrustFor(input)).not.toThrow();
      expect(['verified', 'legacy', 'untrusted']).toContain(controlTrustFor(input));
    }
  });
});

describe('isReservedTrustKey', () => {
  it('is true for the trust context key', () => {
    expect(isReservedTrustKey(TRUST_CONTEXT_KEY)).toBe(true);
  });

  it('is false for ordinary keys', () => {
    expect(isReservedTrustKey('task')).toBe(false);
    expect(isReservedTrustKey('cwd')).toBe(false);
    expect(isReservedTrustKey('')).toBe(false);
  });
});

describe('stripReservedTrustKeys', () => {
  it('removes the marker and leaves other keys intact', () => {
    const input = { task: 'debugging', [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST };
    const stripped = stripReservedTrustKeys(input);
    expect(stripped[TRUST_CONTEXT_KEY]).toBeUndefined();
    expect(stripped.task).toBe('debugging');
  });

  it('does not mutate the original object', () => {
    const input = { task: 'debugging', [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST };
    stripReservedTrustKeys(input);
    expect(input[TRUST_CONTEXT_KEY]).toBe(USER_VERIFIED_TRUST);
  });

  it('is a no-op when the marker is absent', () => {
    const input = { task: 'debugging' };
    expect(stripReservedTrustKeys(input)).toEqual(input);
  });

  it('passes undefined through unchanged', () => {
    expect(stripReservedTrustKeys(undefined)).toBeUndefined();
  });

  it('closes the forgery path end to end: stripped context can never verify a claim', () => {
    const forged = stripReservedTrustKeys({ [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST });
    expect(
      controlTrustFor({
        source: 'told-by-user',
        context: forged,
        createdAt: AFTER_CUTOFF,
      }),
    ).toBe('untrusted');
  });
});
