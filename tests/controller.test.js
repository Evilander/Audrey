import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { Audrey } from '../dist/src/index.js';

const TEST_DIR = './test-controller-data';

function metadataOf(event) {
  return event.metadata ? JSON.parse(event.metadata) : {};
}

describe('Audrey Guard controller', () => {
  let audrey;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    audrey = new Audrey({
      dataDir: TEST_DIR,
      agent: 'controller-test',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });

  afterEach(() => {
    audrey.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('beforeAction returns go and records one receipt when no warnings exist', async () => {
    const result = await audrey.beforeAction('format docs', {
      tool: 'Bash',
      sessionId: 'S-1',
      includeCapsule: false,
    });

    expect(result.decision).toBe('go');
    expect(result.ok_to_proceed).toBe(true);
    expect(result.receipt_id).toMatch(/^01/);
    expect(result.preflight_event_id).toBe(result.receipt_id);
    expect(result.reflexes).toEqual([]);

    const events = audrey.listEvents({ eventType: 'PreToolUse', toolName: 'Bash' });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(result.receipt_id);
    expect(metadataOf(events[0]).guard).toBe(true);
  });

  it('beforeAction blocks strict high-severity memory and returns blocking reflexes', async () => {
    await audrey.encode({
      content: 'Never publish Audrey without running npm pack --dry-run first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
    });

    const result = await audrey.beforeAction('publish Audrey release', {
      tool: 'npm publish',
      strict: true,
      includeCapsule: false,
    });

    expect(result.decision).toBe('block');
    expect(result.ok_to_proceed).toBe(false);
    expect(result.reflexes.some(r => r.response_type === 'block')).toBe(true);
    expect(result.evidence_ids.some(id => !id.startsWith('failure:'))).toBe(true);
  });

  it('afterAction links the post event to the beforeAction receipt metadata', async () => {
    const before = await audrey.beforeAction('run unit tests', {
      tool: 'npm test',
      sessionId: 'S-2',
      includeCapsule: false,
    });

    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'npm test',
      sessionId: 'S-2',
      outcome: 'succeeded',
      output: 'all tests passed\nraw details',
    });

    expect(after.receipt_id).toBe(before.receipt_id);
    expect(after.post_event_id).toMatch(/^01/);
    expect(after.outcome).toBe('succeeded');

    const events = audrey.listEvents({ eventType: 'PostToolUse', toolName: 'npm test' });
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('S-2');
    expect(metadataOf(events[0]).preflight_event_id).toBe(before.receipt_id);
    expect(metadataOf(events[0]).guard).toBe(true);
    expect(metadataOf(events[0]).output_summary).toBe('all tests passed');
    expect(metadataOf(events[0]).redacted_output).toBeUndefined();
  });

  it('afterAction failure becomes a recent-failure warning on the next guard check', async () => {
    const before = await audrey.beforeAction('run npm test', {
      tool: 'npm test',
      includeCapsule: false,
    });

    audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM',
    });

    const next = await audrey.beforeAction('run npm test before release', {
      tool: 'npm test',
      includeCapsule: false,
    });

    expect(next.decision).toBe('caution');
    expect(next.warnings.some(w => w.type === 'recent_failure')).toBe(true);
  });

  it('afterAction validates real evidence ids and skips synthetic failure ids', async () => {
    const memoryId = await audrey.encode({
      content: 'Never deploy without package tarball inspection.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      salience: 0.5,
    });
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'deploy',
      outcome: 'failed',
      errorSummary: 'deploy failed before',
    });

    const before = await audrey.beforeAction('deploy Audrey release', {
      tool: 'deploy',
      strict: true,
      includeCapsule: false,
    });

    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'deploy',
      outcome: 'blocked',
      evidenceFeedback: Object.fromEntries(before.evidence_ids.map(id => [id, 'helpful'])),
    });

    expect(after.validated_evidence.some(v => v.id === memoryId && v.validated)).toBe(true);
    expect(after.validated_evidence.some(v => v.id.startsWith('failure:') && !v.validated)).toBe(true);

    const impact = audrey.impact();
    expect(impact.validatedTotal).toBe(1);
    expect(impact.outcomeBreakdownInWindow.helpful).toBe(1);
  });
});
