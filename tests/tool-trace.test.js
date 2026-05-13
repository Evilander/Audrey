import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Audrey } from '../dist/src/index.js';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = './test-tool-trace-data';

describe('observeTool — end-to-end action trace memory', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'tool-trace-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('stores a PostToolUse event with hashes and no raw payload', () => {
    const { event, redactions } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Bash',
      input: { command: 'npm test' },
      output: 'Tests: 491 passed, 28 skipped\nDuration: 11s',
      outcome: 'succeeded',
      sessionId: 'session-1',
    });

    expect(event.event_type).toBe('PostToolUse');
    expect(event.tool_name).toBe('Bash');
    expect(event.outcome).toBe('succeeded');
    expect(event.input_hash).toHaveLength(64);
    expect(event.output_hash).toHaveLength(64);
    expect(event.actor_agent).toBe('tool-trace-test');
    expect(redactions).toEqual([]);

    const metadata = JSON.parse(event.metadata ?? '{}');
    expect(metadata.output_summary).toBe('Tests: 491 passed, 28 skipped');
    expect(metadata.redacted_input).toBeUndefined();
    expect(metadata.redacted_output).toBeUndefined();
  });

  it('redacts secrets from error_summary and reports redaction state', () => {
    const { event, redactions } = audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: 'curl failed: HTTP 401 at Bearer eyJabcdef0123456789abcdefghij endpoint',
    });

    expect(event.redaction_state).toBe('redacted');
    expect(redactions.find(r => r.class === 'generic_bearer')).toBeDefined();
    expect(event.error_summary).not.toContain('eyJabcdef0123456789abcdefghij');
    expect(event.error_summary).toContain('[REDACTED:generic_bearer]');
  });

  it('redacts long error summaries before truncating them', () => {
    const { event, redactions } = audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: `${'x'.repeat(1990)} Bearer eyJabcdef0123456789abcdefghij`,
    });

    expect(event.redaction_state).toBe('redacted');
    expect(redactions.find(r => r.class === 'generic_bearer')).toBeDefined();
    expect(event.error_summary).not.toContain('Bearer eyJ');
  });

  it('redacts output summaries before truncating them', () => {
    const { event, redactions } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Bash',
      output: `${'x'.repeat(230)} Bearer eyJabcdef0123456789abcdefghij\nsecond line`,
      outcome: 'failed',
    });

    const metadata = JSON.parse(event.metadata ?? '{}');
    expect(event.redaction_state).toBe('redacted');
    expect(redactions.find(r => r.class === 'generic_bearer')).toBeDefined();
    expect(metadata.output_summary).not.toContain('Bearer eyJ');
  });

  it('redacts secrets from metadata payload', () => {
    const { event, redactions } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Edit',
      metadata: { env: { OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz012345' } },
    });

    expect(event.redaction_state).toBe('redacted');
    expect(redactions.find(r => r.class === 'openai_api_key')).toBeDefined();
    expect(event.metadata).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('redacts sensitive metadata keys and nested sensitive values', () => {
    const { event, redactions } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Bash',
      metadata: {
        'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345': true,
        api_key: { current: 'hunter2' },
        header: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      },
    });

    expect(event.redaction_state).toBe('redacted');
    expect(redactions.find(r => r.class === 'openai_api_key')).toBeDefined();
    expect(redactions.find(r => r.class === 'basic_auth')).toBeDefined();
    expect(event.metadata).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(event.metadata).not.toContain('hunter2');
    expect(event.metadata).not.toContain('dXNlcjpwYXNzd29yZA');
  });

  it('retainDetails stores redacted input and output alongside hashes', () => {
    const { event } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Bash',
      input: { command: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' },
      outcome: 'succeeded',
      retainDetails: true,
    });
    const metadata = JSON.parse(event.metadata ?? '{}');
    expect(metadata.redacted_input.command).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(metadata.redacted_input.command).toContain('[REDACTED:aws_access_key');
    expect(event.redaction_state).toBe('redacted');
  });

  it('fingerprints real files and tolerates missing paths', () => {
    const realFile = join(TEST_DIR, 'hello.txt');
    writeFileSync(realFile, 'hello world');
    const { event } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Edit',
      files: [realFile, join(TEST_DIR, 'missing.txt')],
      cwd: process.cwd(),
      outcome: 'succeeded',
    });
    const fingerprints = JSON.parse(event.file_fingerprints ?? '[]');
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0]).toContain('test-tool-trace-data/hello.txt');
    expect(fingerprints[0].split('|')[1]).toBe('11'); // size of "hello world"
    expect(fingerprints[0].split('|')).toHaveLength(3);
  });

  it('does not fingerprint files outside cwd', () => {
    const realFile = join(TEST_DIR, 'hello.txt');
    writeFileSync(realFile, 'hello world');
    const { event } = audrey.observeTool({
      event: 'PostToolUse',
      tool: 'Read',
      files: [realFile],
      cwd: join(TEST_DIR, 'nested'),
      outcome: 'succeeded',
    });

    expect(event.file_fingerprints).toBeNull();
  });

  it('recentFailures surfaces previously-failed tools', () => {
    audrey.observeTool({ event: 'PostToolUseFailure', tool: 'Bash', outcome: 'failed', errorSummary: 'missing env var' });
    audrey.observeTool({ event: 'PostToolUse', tool: 'Bash', outcome: 'succeeded' });
    audrey.observeTool({ event: 'PostToolUseFailure', tool: 'Edit', outcome: 'failed', errorSummary: 'file locked' });

    const failures = audrey.recentFailures();
    expect(failures.map(f => f.tool_name).sort()).toEqual(['Bash', 'Edit']);
    const bash = failures.find(f => f.tool_name === 'Bash');
    expect(bash?.failure_count).toBe(1);
    expect(bash?.last_error_summary).toContain('missing env var');
  });

  it('listEvents filters by toolName and limit', () => {
    for (let i = 0; i < 4; i++) {
      audrey.observeTool({ event: 'PostToolUse', tool: 'Bash', outcome: 'succeeded' });
    }
    audrey.observeTool({ event: 'PostToolUse', tool: 'Edit', outcome: 'succeeded' });
    expect(audrey.listEvents({ toolName: 'Bash' })).toHaveLength(4);
    expect(audrey.listEvents({ toolName: 'Edit' })).toHaveLength(1);
    expect(audrey.countEvents()).toBe(5);
    expect(audrey.listEvents({ limit: 2 })).toHaveLength(2);
  });

  it('emits "tool-observed" event', async () => {
    const received = [];
    audrey.on('tool-observed', ev => received.push(ev));
    audrey.observeTool({ event: 'PostToolUse', tool: 'Bash', outcome: 'succeeded' });
    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe('PostToolUse');
  });

  it('sessions persist across observations', () => {
    audrey.observeTool({ event: 'PreToolUse', tool: 'Bash', sessionId: 'S-1', outcome: 'succeeded' });
    audrey.observeTool({ event: 'PostToolUse', tool: 'Bash', sessionId: 'S-1', outcome: 'succeeded' });
    audrey.observeTool({ event: 'PreToolUse', tool: 'Edit', sessionId: 'S-2', outcome: 'succeeded' });
    expect(audrey.countEvents({ sessionId: 'S-1' })).toBe(2);
    expect(audrey.countEvents({ sessionId: 'S-2' })).toBe(1);
  });
});
