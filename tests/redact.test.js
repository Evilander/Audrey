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
    expect(result.redactions.find(r => r.class === 'password_assignment')?.count).toBeGreaterThanOrEqual(1);
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
    const result = redact('GET https://s3.amazonaws.com/bucket/key?X-Amz-Signature=abcdef12345 HTTP/1.1');
    expect(result.redactions.find(r => r.class === 'signed_url_signature')?.count).toBe(1);
    expect(result.text).toContain('s3.amazonaws.com/bucket/key');
    expect(result.text).not.toContain('abcdef12345');
  });

  it('redacts session cookie values', () => {
    const result = redact('Cookie: sessionid=abcdef0123456789xyz; other=foo');
    expect(result.redactions.find(r => r.class === 'session_cookie')?.count).toBe(1);
    expect(result.text).toContain('sessionid=[REDACTED:session_cookie]');
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

  it('summarizeRedactions reports class:count pairs', () => {
    expect(summarizeRedactions([])).toBe('clean');
    expect(summarizeRedactions([
      { class: 'aws_access_key', count: 2 },
      { class: 'us_ssn', count: 1 },
    ])).toBe('aws_access_key:2,us_ssn:1');
  });
});
