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
      sessionId: 'S-1',
      includeCapsule: false,
    });

    expect(result.decision).toBe('go');
    expect(result.ok_to_proceed).toBe(true);
    expect(result.receipt_id).toMatch(/^01/);
    expect(result.preflight_event_id).toBe(result.receipt_id);
    expect(result.reflexes).toEqual([]);

    const events = audrey.listEvents({ eventType: 'PreToolUse', toolName: 'guard' });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(result.receipt_id);
    expect(events[0].tool_name).toBe('guard');
    const metadata = metadataOf(events[0]);
    expect(metadata.guard).toBe(true);
    expect(metadata.guard_phase).toBe('before');
    expect(metadata.evidence_ids).toEqual([]);
    expect(metadata.reflex_ids).toEqual([]);
    expect(metadata.preflight_decision).toBe('go');
    expect(metadata.preflight_warning_count).toBe(0);
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
    expect(metadataOf(events[0]).guard_phase).toBe('after');
    expect(metadataOf(events[0]).receipt_id).toBe(before.receipt_id);
    expect(metadataOf(events[0]).preflight_decision).toBe('go');
    expect(metadataOf(events[0]).preflight_warning_count).toBe(0);
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

  it('afterAction rejects feedback outside receipt evidence', async () => {
    const receiptMemoryId = await audrey.encode({
      content: 'Never deploy Audrey without package tarball inspection.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      salience: 0.5,
    });
    const before = await audrey.beforeAction('deploy Audrey release', {
      tool: 'deploy',
      strict: true,
      includeCapsule: false,
    });
    const unrelatedMemoryId = await audrey.encode({
      content: 'The user prefers compact status updates in the morning.',
      source: 'direct-observation',
      salience: 0.5,
    });

    expect(before.evidence_ids).toContain(receiptMemoryId);
    expect(before.evidence_ids).not.toContain(unrelatedMemoryId);

    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'deploy',
      outcome: 'blocked',
      evidenceFeedback: {
        [receiptMemoryId]: 'helpful',
        [unrelatedMemoryId]: 'helpful',
      },
    });

    expect(after.validated_evidence).toContainEqual(expect.objectContaining({
      id: receiptMemoryId,
      validated: true,
    }));
    expect(after.validated_evidence).toContainEqual(expect.objectContaining({
      id: unrelatedMemoryId,
      validated: false,
    }));
    expect(after.validated_evidence.find(v => v.id === unrelatedMemoryId)?.reason).toMatch(/receipt evidence/i);

    const impact = audrey.impact();
    expect(impact.validatedTotal).toBe(1);
    expect(impact.outcomeBreakdownInWindow.helpful).toBe(1);
  });

  it('afterAction rejects invalid evidence feedback outcomes before validation mutates memory', async () => {
    const memoryId = await audrey.encode({
      content: 'Never deploy Audrey without package tarball inspection.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      salience: 0.5,
    });
    const before = await audrey.beforeAction('deploy Audrey release', {
      tool: 'deploy',
      strict: true,
      includeCapsule: false,
    });

    expect(() => audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'deploy',
      outcome: 'blocked',
      evidenceFeedback: {
        [memoryId]: 'bogus',
      },
    })).toThrow(/invalid evidence feedback/i);

    const impact = audrey.impact();
    expect(impact.validatedTotal).toBe(0);
  });

  it('afterAction only accepts guard receipts', () => {
    const preTool = audrey.observeTool({
      event: 'PreToolUse',
      tool: 'npm test',
      outcome: 'unknown',
    }).event;

    expect(() => audrey.afterAction({
      receiptId: preTool.id,
      tool: 'npm test',
      outcome: 'succeeded',
    })).toThrow(/not a guard receipt/i);
  });

  it('afterAction rejects replay for a receipt that already has an outcome', async () => {
    const before = await audrey.beforeAction('run unit tests', {
      tool: 'npm test',
      includeCapsule: false,
    });

    audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'npm test',
      outcome: 'succeeded',
    });

    expect(() => audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'replayed failure',
    })).toThrow(/already has an outcome/i);

    expect(audrey.listEvents({ eventType: 'PostToolUse', toolName: 'npm test' })).toHaveLength(1);
    expect(audrey.listEvents({ eventType: 'PostToolUseFailure', toolName: 'npm test' })).toHaveLength(0);
  });

  it('afterAction records failed outcomes as PostToolUseFailure and default outcomes as PostToolUse', async () => {
    const failedBefore = await audrey.beforeAction('run failing command', {
      tool: 'npm test',
      includeCapsule: false,
    });
    const unknownBefore = await audrey.beforeAction('run command with unknown result', {
      tool: 'node script.js',
      includeCapsule: false,
    });

    const failed = audrey.afterAction({
      receiptId: failedBefore.receipt_id,
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'tests failed',
    });
    const unknown = audrey.afterAction({
      receiptId: unknownBefore.receipt_id,
      tool: 'node script.js',
    });

    expect(failed.outcome).toBe('failed');
    expect(unknown.outcome).toBe('unknown');
    expect(audrey.listEvents({ eventType: 'PostToolUseFailure', toolName: 'npm test' })).toHaveLength(1);
    expect(audrey.listEvents({ eventType: 'PostToolUse', toolName: 'node script.js' })).toHaveLength(1);
  });

  it('emits guard-before and guard-after events', async () => {
    const beforeEvents = [];
    const afterEvents = [];
    audrey.on('guard-before', event => beforeEvents.push(event));
    audrey.on('guard-after', event => afterEvents.push(event));

    const before = await audrey.beforeAction('format docs', {
      includeCapsule: false,
    });
    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      outcome: 'succeeded',
    });

    expect(beforeEvents).toHaveLength(1);
    expect(beforeEvents[0].receipt_id).toBe(before.receipt_id);
    expect(afterEvents).toHaveLength(1);
    expect(afterEvents[0].post_event_id).toBe(after.post_event_id);
  });

  it('afterAction rejects malformed receipt metadata because it cannot verify a guard receipt', async () => {
    const before = await audrey.beforeAction('run unit tests', {
      tool: 'npm test',
      includeCapsule: false,
    });
    audrey.db.prepare('UPDATE memory_events SET metadata = ? WHERE id = ?').run('{not-json', before.receipt_id);

    expect(() => audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'npm test',
      outcome: 'succeeded',
    })).toThrow(/not a guard receipt/i);
  });

  it('afterAction finds receipts outside the recent event list limit', async () => {
    const before = await audrey.beforeAction('run old receipt command', {
      tool: 'old-tool',
      includeCapsule: false,
    });
    for (let i = 0; i < 1001; i += 1) {
      audrey.observeTool({
        event: 'PreToolUse',
        tool: `newer-tool-${i}`,
        outcome: 'unknown',
      });
    }

    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'old-tool',
      outcome: 'succeeded',
    });

    expect(after.receipt_id).toBe(before.receipt_id);
    expect(after.post_event_id).toMatch(/^01/);
  });
});
