import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { Audrey } from '../dist/src/index.js';

const TEST_DIR = './test-preflight-data';

describe('Memory Preflight', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'preflight-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('returns go when there are no relevant memory warnings', async () => {
    const result = await audrey.preflight('format the docs', {
      includeCapsule: false,
    });

    expect(result.decision).toBe('go');
    expect(result.warnings).toEqual([]);
    expect(result.risk_score).toBe(0);
    expect(result.capsule).toBeUndefined();
  });

  it('warns before repeating a known failed tool action', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this Windows host',
      cwd: process.cwd(),
    });

    const result = await audrey.preflight('run npm test before release', {
      tool: 'npm test',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('caution');
    expect(result.risk_score).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.type === 'recent_failure')).toBe(true);
    expect(result.warnings.map(w => w.message).join('\n')).toMatch(/spawn EPERM|failed/i);
    expect(result.recent_failures).toHaveLength(1);
    expect(result.status.healthy).toBe(true);
    expect(result.recommended_actions.length).toBeGreaterThan(0);
  });

  it('blocks in strict mode when a must-follow memory is relevant', async () => {
    await audrey.encode({
      content: 'Never publish Audrey without running npm pack --dry-run first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
    });

    const result = await audrey.preflight('publish Audrey release', {
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(result.warnings[0].severity).toBe('high');
    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(true);
    expect(result.recommended_actions[0]).toMatch(/Do not proceed/);
  });

  it('can record a redacted PreToolUse event for the preflight check', async () => {
    const result = await audrey.preflight('edit the release notes', {
      tool: 'Edit',
      sessionId: 'session-1',
      recordEvent: true,
      includeCapsule: false,
    });

    expect(result.preflight_event_id).toMatch(/^01/);
    const events = audrey.listEvents({ eventType: 'PreToolUse', toolName: 'Edit' });
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('session-1');
    expect(events[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
