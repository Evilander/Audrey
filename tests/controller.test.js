import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { Audrey, MemoryController } from '../dist/src/index.js';
import { TRUST_CONTEXT_KEY, USER_VERIFIED_TRUST } from '../dist/src/trust.js';

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

  it('audits acknowledgement only when it applies to an exact prior failure', async () => {
    const result = await audrey.beforeAction('run a never-before-seen command', {
      tool: 'Bash',
      actionDigest: 'no-prior-failure-to-acknowledge',
      acknowledgePriorFailure: true,
      includeCapsule: false,
    });
    const receipt = audrey.db
      .prepare('SELECT metadata FROM memory_events WHERE id = ?')
      .get(result.receipt_id);

    expect(JSON.parse(receipt.metadata).prior_failure_acknowledged).toBe(false);
  });

  it('beforeAction blocks strict high-severity memory and returns blocking reflexes', async () => {
    await audrey.encode({
      content: 'Never publish Audrey without running npm pack --dry-run first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
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

  it('Audrey.beforeAction blocks an exact repeat with one canonical receipt', async () => {
    const action = 'deploy the exact production artifact';
    const options = {
      tool: 'Bash',
      actionDigest: 'canonical-snake-repeat',
      includeCapsule: false,
    };
    const first = await audrey.beforeAction(action, options);
    const failed = audrey.afterAction({
      receiptId: first.receipt_id,
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: 'deployment target is missing',
    });
    const beforeCount = audrey.countEvents({ eventType: 'PreToolUse' });

    const repeated = await audrey.beforeAction(action, options);

    expect(repeated.decision).toBe('block');
    expect(repeated.verdict).toBe('blocked');
    expect(repeated.ok_to_proceed).toBe(false);
    expect(repeated.risk_score).toBeGreaterThanOrEqual(0.9);
    expect(repeated.evidence_ids).toContain(failed.post_event_id);
    expect(repeated.warnings).toContainEqual(
      expect.objectContaining({
        type: 'recent_failure',
        severity: 'high',
        evidence_id: failed.post_event_id,
      }),
    );
    expect(audrey.countEvents({ eventType: 'PreToolUse' })).toBe(beforeCount + 1);

    const receipt = audrey.db
      .prepare('SELECT metadata FROM memory_events WHERE id = ?')
      .get(repeated.receipt_id);
    const metadata = JSON.parse(receipt.metadata);
    expect(metadata.preflight_decision).toBe('block');
    expect(metadata.preflight_warning_count).toBe(repeated.warnings.length);
    expect(metadata.preflight_evidence_ids).toEqual(repeated.evidence_ids);
  });

  it('extinguishes exact failures after success in both snake and camel response paths', async () => {
    const snakeAction = 'publish the recovered package';
    const snakeOptions = {
      tool: 'npm publish',
      actionDigest: 'snake-success-extinction',
      includeCapsule: false,
    };
    const snakeFirst = await audrey.beforeAction(snakeAction, snakeOptions);
    audrey.afterAction({
      receiptId: snakeFirst.receipt_id,
      tool: 'npm publish',
      outcome: 'failed',
      errorSummary: 'registry unavailable',
    });
    const snakeBlocked = await audrey.beforeAction(snakeAction, snakeOptions);
    expect(snakeBlocked.decision).toBe('block');
    expect(() =>
      audrey.afterAction({
        receiptId: snakeBlocked.receipt_id,
        tool: 'npm publish',
        outcome: 'succeeded',
      }),
    ).toThrow(/blocked.*acknowledged/i);
    const snakeAcknowledged = await audrey.beforeAction(snakeAction, {
      ...snakeOptions,
      acknowledgePriorFailure: true,
    });
    expect(snakeAcknowledged.decision).toBe('caution');
    const acknowledgedReceipt = audrey.db
      .prepare('SELECT metadata FROM memory_events WHERE id = ?')
      .get(snakeAcknowledged.receipt_id);
    expect(JSON.parse(acknowledgedReceipt.metadata).prior_failure_acknowledged).toBe(true);
    audrey.afterAction({
      receiptId: snakeAcknowledged.receipt_id,
      tool: 'npm publish',
      outcome: 'succeeded',
    });
    const snakeRecovered = await audrey.beforeAction(snakeAction, snakeOptions);
    expect(snakeRecovered.decision).toBe('go');
    expect(snakeRecovered.ok_to_proceed).toBe(true);

    const controller = new MemoryController(audrey);
    const camelAction = {
      tool: 'Write',
      action: 'write recovered release notes',
      actionDigest: 'camel-success-extinction',
    };
    await controller.beforeAction(camelAction);
    await controller.afterAction({
      action: camelAction,
      outcome: 'failed',
      errorSummary: 'disk was full',
    });
    expect((await controller.beforeAction(camelAction)).decision).toBe('block');
    expect(
      (
        await controller.beforeAction({
          ...camelAction,
          acknowledgePriorFailure: true,
        })
      ).decision,
    ).toBe('warn');
    await controller.afterAction({ action: camelAction, outcome: 'succeeded' });
    const camelRecovered = await controller.beforeAction(camelAction);
    expect(camelRecovered.decision).toBe('allow');
    expect(camelRecovered.summary).toMatch(/succeeded since the prior failure/i);
  });

  it('does not let exact-failure acknowledgement bypass an unrelated strict block', async () => {
    const policyId = await audrey.encode({
      content: 'Never deploy production without a signed approval receipt.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });
    const action = {
      tool: 'Bash',
      action: 'deploy production without approval',
      actionDigest: 'ack-cannot-bypass-policy',
    };
    const first = await audrey.beforeAction(action.action, {
      tool: action.tool,
      actionDigest: action.actionDigest,
      strict: true,
      includeCapsule: false,
    });
    audrey.afterAction({
      receiptId: first.receipt_id,
      tool: action.tool,
      outcome: 'failed',
      errorSummary: 'approval receipt missing',
    });

    const acknowledged = await audrey.beforeAction(action.action, {
      tool: action.tool,
      actionDigest: action.actionDigest,
      strict: true,
      includeCapsule: false,
      acknowledgePriorFailure: true,
    });

    expect(acknowledged.decision).toBe('block');
    expect(acknowledged.evidence_ids).toContain(policyId);
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

  it('does not collide exact-action fingerprints after a shared 2k prefix', async () => {
    const controller = new MemoryController(audrey);
    const prefix = 'x'.repeat(2500);
    const failedAction = { tool: 'Write', action: `${prefix}-first`, files: ['large.txt'] };
    const differentAction = { tool: 'Write', action: `${prefix}-second`, files: ['large.txt'] };

    await controller.beforeAction(failedAction);
    await controller.afterAction({
      action: failedAction,
      outcome: 'failed',
      errorSummary: 'first write failed',
    });

    const different = await controller.beforeAction(differentAction);
    const repeated = await controller.beforeAction(failedAction);
    expect(different.decision).not.toBe('block');
    expect(repeated.decision).toBe('block');
  });

  it('blocks an exact failed action even after more than 1000 newer events', async () => {
    const controller = new MemoryController(audrey);
    const failedAction = {
      tool: 'Bash',
      action: 'deploy the exact release artifact',
      command: 'npm run deploy -- --target production',
    };

    await controller.beforeAction(failedAction);
    await controller.afterAction({
      action: failedAction,
      outcome: 'failed',
      errorSummary: 'deployment target is missing',
    });
    for (let i = 0; i < 1001; i += 1) {
      audrey.observeTool({
        event: 'Observation',
        tool: `noise-${i}`,
        outcome: 'unknown',
      });
    }

    const repeated = await controller.beforeAction(failedAction);
    expect(repeated.decision).toBe('block');
    expect(repeated.evidenceIds).toContain(
      audrey.db
        .prepare("SELECT id FROM memory_events WHERE outcome = 'failed' AND tool_name = 'Bash'")
        .get().id,
    );
  });

  it('ignores helpful validation audit rows when evaluating an exact failed action', async () => {
    const evidenceId = await audrey.encode({
      content: 'Use the release checklist before deployment.',
      source: 'direct-observation',
    });
    const controller = new MemoryController(audrey);
    const action = {
      tool: 'Bash',
      action: 'deploy the validation-contamination target',
      actionDigest: 'validation-helpful-must-not-extinguish',
    };
    await controller.beforeAction(action);
    await controller.afterAction({
      action,
      outcome: 'failed',
      errorSummary: 'deployment failed',
    });
    const failedEvent = audrey.db
      .prepare(
        `SELECT action_key FROM memory_events
         WHERE event_type = 'PostToolUseFailure' AND outcome = 'failed'`,
      )
      .get();
    audrey.validate({
      id: evidenceId,
      outcome: 'helpful',
      actionKey: failedEvent.action_key,
    });

    expect((await controller.beforeAction(action)).decision).toBe('block');
  });

  it('ignores wrong validation audit rows when evaluating an exact succeeded action', async () => {
    const evidenceId = await audrey.encode({
      content: 'The user prefers compact changelog entries.',
      source: 'direct-observation',
    });
    const controller = new MemoryController(audrey);
    const action = {
      tool: 'Write',
      action: 'write the validation-contamination changelog',
      actionDigest: 'validation-wrong-must-not-create-failure',
    };
    await controller.beforeAction(action);
    await controller.afterAction({ action, outcome: 'succeeded' });
    const succeededEvent = audrey.db
      .prepare(
        `SELECT action_key FROM memory_events
         WHERE event_type = 'PostToolUse' AND outcome = 'succeeded'`,
      )
      .get();
    audrey.validate({
      id: evidenceId,
      outcome: 'wrong',
      actionKey: succeededEvent.action_key,
    });

    expect((await controller.beforeAction(action)).decision).not.toBe('block');
  });

  it('preserves unrelated caution after an exact failure has recovered', async () => {
    const controller = new MemoryController(audrey);
    const recoveredAction = {
      tool: 'Write',
      action: 'write the recovered deployment manifest',
      actionDigest: 'recovered-action-with-other-caution',
    };
    await controller.beforeAction(recoveredAction);
    await controller.afterAction({
      action: recoveredAction,
      outcome: 'failed',
      errorSummary: 'first manifest write failed',
    });
    await controller.afterAction({ action: recoveredAction, outcome: 'succeeded' });
    await controller.afterAction({
      action: {
        tool: 'Write',
        action: 'write a separate still-failing artifact',
        actionDigest: 'separate-current-failure',
      },
      outcome: 'failed',
      errorSummary: 'separate write still fails',
    });

    const result = await controller.beforeAction(recoveredAction);

    expect(result.decision).toBe('warn');
    expect(result.riskScore).toBeGreaterThanOrEqual(0.55);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'recent_failure', severity: 'medium' }),
    );
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
    expect(after.validated_evidence.some(v => v.id.startsWith('failure:') && !v.validated)).toBe(
      true,
    );

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

    expect(after.validated_evidence).toContainEqual(
      expect.objectContaining({
        id: receiptMemoryId,
        validated: true,
      }),
    );
    expect(after.validated_evidence).toContainEqual(
      expect.objectContaining({
        id: unrelatedMemoryId,
        validated: false,
      }),
    );
    expect(after.validated_evidence.find(v => v.id === unrelatedMemoryId)?.reason).toMatch(
      /receipt evidence/i,
    );

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

    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        tool: 'deploy',
        outcome: 'blocked',
        evidenceFeedback: {
          [memoryId]: 'bogus',
        },
      }),
    ).toThrow(/invalid evidence feedback/i);

    const impact = audrey.impact();
    expect(impact.validatedTotal).toBe(0);
  });

  it('afterAction only accepts guard receipts', () => {
    const preTool = audrey.observeTool({
      event: 'PreToolUse',
      tool: 'npm test',
      outcome: 'unknown',
    }).event;

    expect(() =>
      audrey.afterAction({
        receiptId: preTool.id,
        tool: 'npm test',
        outcome: 'succeeded',
      }),
    ).toThrow(/not a guard receipt/i);
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

    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        tool: 'npm test',
        outcome: 'failed',
        errorSummary: 'replayed failure',
      }),
    ).toThrow(/already has an outcome/i);

    expect(audrey.listEvents({ eventType: 'PostToolUse', toolName: 'npm test' })).toHaveLength(1);
    expect(
      audrey.listEvents({ eventType: 'PostToolUseFailure', toolName: 'npm test' }),
    ).toHaveLength(0);
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
    expect(
      audrey.listEvents({ eventType: 'PostToolUseFailure', toolName: 'npm test' }),
    ).toHaveLength(1);
    expect(
      audrey.listEvents({ eventType: 'PostToolUse', toolName: 'node script.js' }),
    ).toHaveLength(1);
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
    audrey.db
      .prepare('UPDATE memory_events SET metadata = ? WHERE id = ?')
      .run('{not-json', before.receipt_id);

    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        tool: 'npm test',
        outcome: 'succeeded',
      }),
    ).toThrow(/not a guard receipt/i);
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

  it('lets an explicit overrideReason record success against a non-exact-failure block, auditably', async () => {
    const policyId = await audrey.encode({
      content: 'Never deploy production without a signed approval receipt.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });
    const before = await audrey.beforeAction(
      'deploy production with a manually verified approval',
      {
        tool: 'Bash',
        strict: true,
        includeCapsule: false,
      },
    );
    expect(before.decision).toBe('block');
    expect(before.evidence_ids).toContain(policyId);

    // The pre-existing dead end: no exact failure exists to acknowledge, so
    // this receipt would otherwise never be recordable as succeeded.
    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        tool: 'Bash',
        outcome: 'succeeded',
      }),
    ).toThrow(/overrideReason/);

    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      tool: 'Bash',
      outcome: 'succeeded',
      overrideReason: 'Approval receipt verified manually out of band by the release manager.',
    });

    expect(after.outcome).toBe('succeeded');
    const event = audrey.db
      .prepare('SELECT metadata FROM memory_events WHERE id = ?')
      .get(after.post_event_id);
    const metadata = JSON.parse(event.metadata);
    expect(metadata.guard_block_overridden).toBe(true);
    expect(metadata.guard_override_reason).toBe(
      'Approval receipt verified manually out of band by the release manager.',
    );
  });

  it('rejects a blank overrideReason for a policy-caused block', async () => {
    await audrey.encode({
      content: 'Never deploy production without a signed approval receipt.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });
    const before = await audrey.beforeAction('deploy production for a blank override test', {
      tool: 'Bash',
      strict: true,
      includeCapsule: false,
    });
    expect(before.decision).toBe('block');

    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        tool: 'Bash',
        outcome: 'succeeded',
        overrideReason: '   ',
      }),
    ).toThrow(/overrideReason/);
  });

  it('still refuses to record success for an exact-repeat-failure block even with overrideReason supplied', async () => {
    const action = 'deploy the exact production artifact for override test';
    const options = {
      tool: 'Bash',
      actionDigest: 'override-cannot-bypass-exact-failure',
      includeCapsule: false,
    };
    const first = await audrey.beforeAction(action, options);
    audrey.afterAction({
      receiptId: first.receipt_id,
      tool: 'Bash',
      outcome: 'failed',
      errorSummary: 'deployment target is missing',
    });
    const blocked = await audrey.beforeAction(action, options);
    expect(blocked.decision).toBe('block');

    expect(() =>
      audrey.afterAction({
        receiptId: blocked.receipt_id,
        tool: 'Bash',
        outcome: 'succeeded',
        overrideReason: 'I am confident this is fine now.',
      }),
    ).toThrow(/exact repeat failure/i);
  });
});
