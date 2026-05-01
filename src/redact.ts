/**
 * Redaction for secrets, credentials, and personally identifying data.
 *
 * Audrey never ingests raw shell output, tool input, or files. Anything that
 * reaches a memory_events row must first be filtered through redact().
 *
 * Rules are intentionally conservative: false positives are far cheaper than
 * leaking a real credential into long-lived memory.
 */

export type RedactionClass =
  | 'aws_access_key'
  | 'openai_api_key'
  | 'anthropic_api_key'
  | 'github_token'
  | 'stripe_live_key'
  | 'stripe_test_key'
  | 'google_api_key'
  | 'slack_token'
  | 'generic_bearer'
  | 'private_key_block'
  | 'jwt'
  | 'url_credentials'
  | 'password_assignment'
  | 'credit_card_number'
  | 'cvv'
  | 'us_ssn'
  | 'signed_url_signature'
  | 'session_cookie'
  | 'high_entropy_secret';

interface RedactionRule {
  readonly class: RedactionClass;
  readonly pattern: RegExp;
  readonly replacement: (match: string) => string;
}

export interface RedactionHit {
  class: RedactionClass;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionHit[];
  state: 'clean' | 'redacted';
}

function tokenPlaceholder(className: RedactionClass, match: string): string {
  const tail = match.slice(-4).replace(/[^A-Za-z0-9]/g, '');
  const suffix = tail.length === 4 ? `:${tail}` : '';
  return `[REDACTED:${className}${suffix}]`;
}

const RULES: RedactionRule[] = [
  {
    class: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: m => tokenPlaceholder('aws_access_key', m),
  },
  {
    class: 'anthropic_api_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: m => tokenPlaceholder('anthropic_api_key', m),
  },
  {
    class: 'openai_api_key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: m => tokenPlaceholder('openai_api_key', m),
  },
  {
    class: 'github_token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
    replacement: m => tokenPlaceholder('github_token', m),
  },
  {
    class: 'stripe_live_key',
    pattern: /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{20,}\b/g,
    replacement: m => tokenPlaceholder('stripe_live_key', m),
  },
  {
    class: 'stripe_test_key',
    pattern: /\b(?:sk|rk|pk)_test_[A-Za-z0-9]{20,}\b/g,
    replacement: m => tokenPlaceholder('stripe_test_key', m),
  },
  {
    class: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: m => tokenPlaceholder('google_api_key', m),
  },
  {
    class: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: m => tokenPlaceholder('slack_token', m),
  },
  {
    class: 'jwt',
    pattern: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: m => tokenPlaceholder('jwt', m),
  },
  {
    class: 'private_key_block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    replacement: () => '[REDACTED:private_key_block]',
  },
  {
    class: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replacement: (match: string) => {
      const parts = match.match(/^([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/i);
      if (!parts) return '[REDACTED:url_credentials]';
      return `${parts[1]}${parts[2]}:[REDACTED:url_credentials]@`;
    },
  },
  {
    class: 'generic_bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
    replacement: () => 'Bearer [REDACTED:generic_bearer]',
  },
  {
    class: 'credit_card_number',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    replacement: (match: string) => {
      const digits = match.replace(/[^0-9]/g, '');
      if (digits.length < 13 || digits.length > 19) return match;
      if (!isLikelyCard(digits)) return match;
      return tokenPlaceholder('credit_card_number', digits);
    },
  },
  {
    class: 'cvv',
    pattern: /\b(?:cvv|cvc|cvn|cid)\s*[:=]?\s*(\d{3,4})\b/gi,
    replacement: (match: string) => match.replace(/\d{3,4}$/, '[REDACTED:cvv]'),
  },
  {
    class: 'us_ssn',
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    replacement: () => '[REDACTED:us_ssn]',
  },
  {
    class: 'signed_url_signature',
    pattern: /([?&](?:X-Amz-Signature|sig|signature|token)=)[^&\s"']+/gi,
    replacement: (match: string) => {
      const parts = match.match(/^([?&](?:X-Amz-Signature|sig|signature|token)=)/i);
      const prefix = parts ? parts[1] : '';
      return `${prefix}[REDACTED:signed_url_signature]`;
    },
  },
  {
    class: 'session_cookie',
    pattern: /\b(?:session|sid|sessionid|connect\.sid|JSESSIONID|PHPSESSID|laravel_session)=([A-Za-z0-9%._-]{8,})/gi,
    replacement: (match: string) => {
      const eq = match.indexOf('=');
      const name = eq > 0 ? match.slice(0, eq + 1) : match;
      return `${name}[REDACTED:session_cookie]`;
    },
  },
  {
    // Keep this after named credential formats so a caller writing
    // `api_key: <token>` gets a key-assignment redaction, not a generic one.
    class: 'password_assignment',
    pattern: /(?:\b|_)(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|bearer[_-]?token)\s*[:=]\s*["']?([^\s"'&]{4,})["']?/gi,
    replacement: (match: string) => {
      const split = match.match(/^((?:\b|_)(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|bearer[_-]?token)\s*[:=]\s*["']?)/i);
      const prefix = split ? split[1] : '';
      return `${prefix}[REDACTED:password_assignment]`;
    },
  },
  {
    class: 'high_entropy_secret',
    pattern: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g,
    replacement: (match: string) => (
      looksLikeHighEntropySecret(match) ? tokenPlaceholder('high_entropy_secret', match) : match
    ),
  },
];

function isLikelyCard(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charAt(i);
    let d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) return false;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikeHighEntropySecret(value: string): boolean {
  if (value.length < 32) return false;
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[+/_=-]/.test(value),
  ].filter(Boolean).length;
  if (classes < 2) return false;

  const entropy = shannonEntropy(value);
  if (/^[a-f0-9]+$/i.test(value)) {
    // Git SHA-1 (40), git tree/blob hashes, SHA-256 hex (64) are not secrets on their
    // own. Only treat hex strings as secrets if they're long enough that they exceed
    // common public-hash sizes (>=80 hex chars) AND have hash-grade entropy.
    return value.length >= 80 && entropy >= 3.3;
  }
  return entropy >= 4.0;
}

export function redact(input: string): RedactionResult {
  if (!input) {
    return { text: '', redactions: [], state: 'clean' };
  }

  const counts = new Map<RedactionClass, number>();
  let text = input;

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string) => {
      const replaced = rule.replacement(match);
      if (replaced !== match) {
        counts.set(rule.class, (counts.get(rule.class) ?? 0) + 1);
      }
      return replaced;
    });
  }

  const redactions: RedactionHit[] = [...counts.entries()].map(([cls, count]) => ({
    class: cls,
    count,
  }));

  return {
    text,
    redactions,
    state: redactions.length === 0 ? 'clean' : 'redacted',
  };
}

const SENSITIVE_KEY_PATTERN = /(^|_|-)(password|passwd|pwd|secret|api[_-]?key|auth[_-]?token|bearer[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?token|jwt|aws[_-]?secret|token)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactJson(value: unknown): { value: unknown; redactions: RedactionHit[]; state: 'clean' | 'redacted' } {
  const counts = new Map<RedactionClass, number>();

  function walk(node: unknown, parentKey?: string): unknown {
    if (node == null) return node;
    if (typeof node === 'string') {
      // Try specific pattern redaction first so a value like
      // { OPENAI_API_KEY: "sk-..." } is tagged openai_api_key, not the
      // generic password_assignment class.
      const r = redact(node);
      if (r.redactions.length > 0) {
        for (const hit of r.redactions) {
          counts.set(hit.class, (counts.get(hit.class) ?? 0) + hit.count);
        }
        return r.text;
      }
      if (parentKey && isSensitiveKey(parentKey) && node.length > 0) {
        counts.set('password_assignment', (counts.get('password_assignment') ?? 0) + 1);
        return '[REDACTED:password_assignment]';
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map(item => walk(item, parentKey));
    }
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(val, key);
      }
      return out;
    }
    return node;
  }

  const redactedValue = walk(value);
  const redactions: RedactionHit[] = [...counts.entries()].map(([cls, count]) => ({ class: cls, count }));
  return {
    value: redactedValue,
    redactions,
    state: redactions.length === 0 ? 'clean' : 'redacted',
  };
}

export function summarizeRedactions(hits: RedactionHit[]): string {
  if (hits.length === 0) return 'clean';
  return hits.map(h => `${h.class}:${h.count}`).join(',');
}
