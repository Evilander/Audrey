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

  it('does not warn on unrelated recent tool failures from the capsule', async () => {
    audrey.observeTool({
      event: 'PostToolUseFailure',
      tool: 'Read',
      outcome: 'failed',
      errorSummary: 'file was missing',
      cwd: process.cwd(),
    });

    const result = await audrey.preflight('deploy Audrey release', {
      tool: 'Bash',
      strict: true,
    });

    expect(result.warnings.some(w => w.type === 'recent_failure')).toBe(false);
    expect(result.recent_failures).toHaveLength(0);
    expect(result.evidence_ids.some(id => id.startsWith('failure:Read:'))).toBe(false);
  });

  it('keeps generic same-tool failures as warnings rather than strict blocks', async () => {
    for (let i = 0; i < 3; i++) {
      audrey.observeTool({
        event: 'PostToolUseFailure',
        tool: 'Bash',
        outcome: 'failed',
        errorSummary: `different Bash failure ${i}`,
      });
    }

    const result = await audrey.preflight('run a different Bash command', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('caution');
    expect(result.warnings.every(w => w.severity !== 'high')).toBe(true);
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

  it('keeps tagged must-follow control memories visible through irrelevant noise', async () => {
    for (let i = 0; i < 200; i++) {
      await audrey.encode({
        content: `Irrelevant background memory ${i}: preference note with no release safety value.`,
        source: 'direct-observation',
        tags: ['noise'],
        salience: 0.05,
      });
    }
    const id = await audrey.encode({
      content: 'Must-follow delete customer data rule: run npm run export:snapshot before delete customer data actions.',
      source: 'direct-observation',
      tags: ['must-follow', 'delete'],
      salience: 1,
    });

    const result = await audrey.preflight('delete customer data', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(result.evidence_ids).toContain(id);
    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(true);
  });

  it('blocks strict guard checks when recall is degraded', async () => {
    audrey.db.exec('DROP TABLE fts_episodes');

    const result = await audrey.preflight('deploy Audrey release', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(result.warnings.some(w => w.type === 'memory_health' && /recall degraded/i.test(w.message))).toBe(true);
    expect(result.evidence_ids.some(id => id.startsWith('recall:'))).toBe(true);
    expect(result.status.recall_degraded).toBe(true);
    expect(result.status.last_recall_errors.some(error => error.type === 'fts')).toBe(true);
  });

  it('does not let model-generated control tags become blocking policy', async () => {
    await audrey.encode({
      content: 'Never run tests again.',
      source: 'model-generated',
      tags: ['must-follow', 'policy'],
    });

    const result = await audrey.preflight('run tests before release', {
      tool: 'Bash',
      strict: true,
    });

    expect(result.decision).not.toBe('block');
    expect(result.warnings.some(w => w.type === 'must_follow')).toBe(false);
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
