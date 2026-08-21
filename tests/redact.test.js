import { describe, it, expect } from 'vitest';
import { redact, redactJson, summarizeRedactions } from '../dist/src/redact.js';

describe('redact', () => {
  it('returns clean when nothing matches', () => {
    const result = redact('Just a normal message about stripe rate limits.');
    expect(result.state).toBe('clean');
    expect(result.redactions).toHaveLength(0);
    expect(result.text).toBe('Just a normal message about stripe rate limits.');
  });

  it('handles empty and null-ish input without throwing', () => {
    expect(redact('').state).toBe('clean');
  });

  it('redacts AWS access keys', () => {
    const result = redact('access_key: AKIAIOSFODNN7EXAMPLE');
    expect(result.state).toBe('redacted');
    expect(result.redactions).toEqual([{ class: 'aws_access_key', count: 1 }]);
    expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.text).toContain('[REDACTED:aws_access_key');
  });

  it('redacts OpenAI project and legacy keys', () => {
    const result = redact('key1=sk-abcd1234567890abcd1234 key2=sk-proj-1234567890abcdefghij');
    expect(result.state).toBe('redacted');
    const openai = result.redactions.find(r => r.class === 'openai_api_key');
    expect(openai?.count).toBeGreaterThanOrEqual(2);
    expect(result.text).not.toContain('sk-abcd1234567890abcd1234');
    expect(result.text).not.toContain('sk-proj-1234567890abcdefghij');
  });

  it('redacts Anthropic keys before generic openai pattern', () => {
    const result = redact('ANTHROPIC_API_KEY=sk-ant-abcdefghij1234567890');
    const anthropic = result.redactions.find(r => r.class === 'anthropic_api_key');
    expect(anthropic?.count).toBe(1);
    expect(result.text).not.toContain('sk-ant-abcdefghij1234567890');
  });

  it('redacts GitHub personal access tokens', () => {
    const result = redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used');
    expect(result.redactions.find(r => r.class === 'github_token')?.count).toBe(1);
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('redacts Stripe live keys', () => {
    // Source string is split so GitHub's secret scanner does not flag this
    // test fixture as a real Stripe live key. Runtime value is identical.
    const fakeKey = 'sk_live_' + 'abcdefghijklmnopqrstuvwx';
    const result = redact(`payment uses ${fakeKey}`);
    expect(result.redactions.find(r => r.class === 'stripe_live_key')?.count).toBe(1);
  });

  it('redacts Google API keys', () => {
    // Google keys are exactly 39 chars: AIza + 35 alphanumerics.
    const result = redact('apiKey: AIzaSyAbcdefghijklmnopqrstuvwxyz0123456');
    expect(result.redactions.find(r => r.class === 'google_api_key')?.count).toBe(1);
  });

  it('redacts Bearer tokens', () => {
    const result = redact('Authorization: Bearer eyAbcdef01234567890abcdefGHIJ');
    expect(result.redactions.find(r => r.class === 'generic_bearer')?.count).toBe(1);
    expect(result.text).not.toContain('eyAbcdef01234567890abcdefGHIJ');
  });

  it('redacts url credentials while keeping hostname', () => {
    const result = redact('postgres://alice:sup3rsecret@db.example.com/prod');
    expect(result.redactions.find(r => r.class === 'url_credentials')?.count).toBe(1);
    expect(result.text).toContain('alice:[REDACTED:url_credentials]@');
    expect(result.text).not.toContain('sup3rsecret');
  });

  it('redacts password-like assignments', () => {
    const result = redact('password="hunter2!" api_key: "abcdef123456"');
    expect(
      result.redactions.find(r => r.class === 'password_assignment')?.count,
    ).toBeGreaterThanOrEqual(1);
    expect(result.text).not.toContain('hunter2!');
  });

  it('redacts valid credit card numbers (Luhn)', () => {
    const result = redact('PAN 4111-1111-1111-1111 belongs to test account.');
    expect(result.redactions.find(r => r.class === 'credit_card_number')?.count).toBe(1);
    expect(result.text).not.toContain('4111-1111-1111-1111');
  });

  it('does not redact random 16-digit numbers that fail Luhn', () => {
    const result = redact('Invoice 1234567890123456 total $42.');
    expect(result.redactions.find(r => r.class === 'credit_card_number')).toBeUndefined();
  });

  it('redacts CVV mentions', () => {
    const result = redact('cvv: 123 expected');
    expect(result.redactions.find(r => r.class === 'cvv')?.count).toBe(1);
    expect(result.text).not.toMatch(/cvv:\s*123\b/);
  });

  it('redacts US SSN', () => {
    const result = redact('SSN 123-45-6789 on file');
    expect(result.redactions.find(r => r.class === 'us_ssn')?.count).toBe(1);
    expect(result.text).not.toContain('123-45-6789');
  });

  it('redacts PEM private key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA...fakeprivatekeybody...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redact(`before\n${pem}\nafter`);
    expect(result.redactions.find(r => r.class === 'private_key_block')?.count).toBe(1);
    expect(result.text).not.toContain('fakeprivatekeybody');
  });

  it('redacts signed URL signatures without destroying the hostname', () => {
    const result = redact(
      'GET https://s3.amazonaws.com/bucket/key?X-Amz-Signature=abcdef12345 HTTP/1.1',
    );
    expect(result.redactions.find(r => r.class === 'signed_url_signature')?.count).toBe(1);
    expect(result.text).toContain('s3.amazonaws.com/bucket/key');
    expect(result.text).not.toContain('abcdef12345');
  });

  it('redacts session cookie values', () => {
    const result = redact('Cookie: sessionid=abcdef0123456789xyz; other=foo');
    expect(result.redactions.find(r => r.class === 'session_cookie')?.count).toBe(1);
    expect(result.text).toContain('sessionid=[REDACTED:session_cookie]');
  });

  it('redacts naked high-entropy tokens without a credential prefix', () => {
    const token = 'q9V1nZ4LkP7sD2fGh8JmR3tY6uW0xAbC';
    const result = redact(`tool stderr leaked ${token} before exiting`);
    expect(result.redactions.find(r => r.class === 'high_entropy_secret')?.count).toBe(1);
    expect(result.text).not.toContain(token);
    expect(result.text).toContain('[REDACTED:high_entropy_secret');
  });

  it('does not redact long snake_case tool identifiers', () => {
    const tools = [
      'mcp__plugin_playwright_playwright__browser_navigate',
      'mcp__plugin_playwright_playwright__browser_take_screenshot',
      'mcp__audrey-memory__memory_observe_tool',
      'AUDREY_AUTOPILOT_MAINTENANCE_INTERVAL_HOURS',
    ];
    for (const tool of tools) {
      const result = redact(`${tool} failed 2x recently`);
      expect(result.state, tool).toBe('clean');
      expect(result.text, tool).toContain(tool);
    }
  });

  it('still redacts secrets that contain separators', () => {
    // base64url-style token with underscores/hyphens but digit-bearing segments
    const token = 'q9V1nZ4L_kP7sD2fGh8-JmR3tY6uW0xAbC5eF1gH';
    const result = redact(`leaked ${token} in output`);
    expect(result.redactions.find(r => r.class === 'high_entropy_secret')?.count).toBe(1);
    expect(result.text).not.toContain(token);
  });

  it('still redacts title-cased memorable passphrases', () => {
    // Mixed-case segments are passphrase-shaped, not identifier-shaped.
    const passphrase = 'Falcon-River-Cobalt-Meadow-Quartz';
    const result = redact(`leaked ${passphrase} in output`);
    expect(result.redactions.find(r => r.class === 'high_entropy_secret')?.count).toBe(1);
    expect(result.text).not.toContain(passphrase);
  });

  it('redactJson walks nested structures', () => {
    const result = redactJson({
      config: { password: 'hunter2abcdef' },
      notes: ['AKIAIOSFODNN7EXAMPLE is our key'],
      safe: 42,
    });
    expect(result.state).toBe('redacted');
    expect(result.redactions.length).toBeGreaterThan(0);
    const out = result.value;
    expect(JSON.stringify(out)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(out)).not.toContain('hunter2abcdef');
    expect(out.safe).toBe(42);
  });

  it('redacts a space-separated BIP39-style mnemonic', () => {
    const mnemonic =
      'abandon ability able absent absorb abstract absurd abuse access accident account acid';
    const result = redact(`seed phrase: ${mnemonic}`);
    expect(result.redactions.find(r => r.class === 'passphrase')?.count).toBe(1);
    expect(result.text).not.toContain(mnemonic);
    expect(result.text).toContain('[REDACTED:passphrase]');
  });

  it('redacts a hyphen-joined mnemonic-length passphrase even though it looks like an identifier', () => {
    const mnemonic =
      'abandon-ability-able-absent-absorb-abstract-absurd-abuse-access-accident-account-acid';
    // Pre-fix, looksLikeWordIdentifier exempted any 3+ all-lowercase
    // dash-joined token from the entropy rule, so this never redacted.
    const result = redact(`seed: ${mnemonic}`);
    expect(result.redactions.find(r => r.class === 'passphrase')?.count).toBe(1);
    expect(result.text).not.toContain(mnemonic);
  });

  it('does not redact an ordinary lowercase sentence fragment with stopwords', () => {
    const sentence =
      'the meeting will happen after lunch near the conference room to discuss next steps';
    const result = redact(sentence);
    expect(result.redactions.find(r => r.class === 'passphrase')).toBeUndefined();
    expect(result.text).toBe(sentence);
  });

  it('does not redact short (fewer than eight word) lowercase dash-joined phrases', () => {
    // This remains exempted by looksLikeWordIdentifier and is out of scope
    // for the new eight-word 'passphrase' rule.
    const result = redact('token correct-horse-battery-staple used here');
    expect(result.redactions.find(r => r.class === 'passphrase')).toBeUndefined();
  });

  it('redactJson preserves a literal __proto__ key without polluting the prototype', () => {
    // JSON.parse creates a genuine own property named "__proto__", exactly
    // like a parsed HTTP request body or an MCP tool's z.record() input.
    const payload = JSON.parse('{"__proto__": {"password": "hunter2ab"}}');
    const result = redactJson(payload);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true);
    const nested = Object.getOwnPropertyDescriptor(result.value, '__proto__').value;
    expect(nested.password).toContain('[REDACTED:password_assignment]');
    expect(result.state).toBe('redacted');
  });

  it('redactJson preserves a literal __proto__ key set to null without corrupting the object', () => {
    // Pre-fix, `out['__proto__'] = null` set the object's actual prototype to
    // null, silently dropping the "safe" sibling key from the bracket-based
    // walk and leaving an object whose own hasOwnProperty was gone.
    const payload = JSON.parse('{"__proto__": null, "safe": 1}');
    const result = redactJson(payload);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(() => Object.prototype.hasOwnProperty.call(result.value, 'safe')).not.toThrow();
    expect(result.value.safe).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(true);
  });

  it('leaves long mixed-case filesystem paths untouched', () => {
    // A 32+ char mixed-case POSIX path matches the high-entropy alphabet and
    // can cross the entropy gate, which mangled stored cwd context and broke
    // Guard project scoping on CI-depth checkout paths.
    for (const path of [
      '/home/runner/work/Audrey/Audrey/test-autopilot-data/project-a',
      '/home/tyler/Projects/MyApp/src/components',
      '/Users/casey/Development/ServiceMesh/ingress-gateway/config',
      'C:/Users/Someone/AppData/Local/Programs/example-tool',
    ]) {
      const result = redact(path);
      expect(result.state).toBe('clean');
      expect(result.text).toBe(path);
    }
  });

  it('still redacts base64 material even when it contains slashes', () => {
    const secret = 'dGhpcyBpcyBub3QgYSBwYXRo/aXQgaXM+c2VjcmV0IG1hdGVyaWFs+with+plus=';
    const result = redact(`token ${secret}`);
    expect(result.state).toBe('redacted');
    expect(result.text).not.toContain(secret);
  });

  it('redacts path-shaped secrets that carry no + or = to opt out with', () => {
    // The base64 test above is opted out of the path shape by its '+' and '='.
    // These are not: three clean segments, path alphabet only. A blanket
    // path-shape exemption left every one of them in plaintext.
    for (const secret of [
      'aZ9kLpQ2/mR7vT4wX1yB6cD8eF3gH5jK/nP0sU2vW9xY',
      'QpW2yb5ZQiUqGUhnI47YuSKF/1pfCFy/Pbc0NISw',
      'IUhc4vpwkC1ZmQjA4w/F4N0snk5Dea6/C6prbMI3',
    ]) {
      const result = redact(`token ${secret}`);
      expect(result.state).toBe('redacted');
      expect(result.text).not.toContain(secret);
    }
  });

  it('keeps the path-shape entropy bar above real paths and below random keys', () => {
    // Guards the calibration in PATH_SHAPE_ENTROPY_MIN from being widened
    // back into a blanket exemption. Randomly generated 40-char AWS secret
    // access keys draw from an alphabet containing '/', so a slice of them
    // land in the path shape by chance; almost none may survive.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+';
    let leaked = 0;
    const total = 4000;
    for (let i = 0; i < total; i++) {
      let key = '';
      for (let c = 0; c < 40; c++) key += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (redact(`aws_secret_access_key = ${key}`).state === 'clean') leaked++;
    }
    expect(leaked / total).toBeLessThan(0.005);
  });

  it('treats a sensitive word anywhere in a compound key as sensitive', () => {
    // Canonical credential fields are compounds. A suffix-anchored key
    // pattern matched none of them, so redactJson's sensitive-ancestor
    // fallback never fired for the exact names credentials ship under.
    for (const key of ['aws_secret_access_key', 'stripe_secret_key', 'client_secret_value']) {
      const result = redactJson({ [key]: 'plain-value-here' });
      expect(result.state).toBe('redacted');
      expect(result.value[key]).not.toBe('plain-value-here');
    }
  });

  it('does not treat count and collection fields as sensitive', () => {
    const result = redactJson({ tokens: 'a b c', budget_chars: 'many', token_count: 512 });
    expect(result.value.tokens).toBe('a b c');
    expect(result.value.budget_chars).toBe('many');
    // Numbers never route through string redaction regardless of key.
    expect(result.value.token_count).toBe(512);
  });

  it('summarizeRedactions reports class:count pairs', () => {
    expect(summarizeRedactions([])).toBe('clean');
    expect(
      summarizeRedactions([
        { class: 'aws_access_key', count: 2 },
        { class: 'us_ssn', count: 1 },
      ]),
    ).toBe('aws_access_key:2,us_ssn:1');
  });
});
