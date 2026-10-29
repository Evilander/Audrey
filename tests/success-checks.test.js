import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Audrey,
  MemoryController,
  inferAutopilotOutcome,
  runAutopilotHook,
} from '../dist/src/index.js';
import { createApp } from '../dist/src/routes.js';
import {
  compileSuccessChecks,
  readSuccessChecks,
  verifySuccessChecks,
} from '../dist/src/success-checks.js';
import {
  buildMemoryGuardBeforeHandler,
  buildMemoryGuardAfterHandler,
} from '../dist/mcp-server/index.js';
import { memoryGuardBeforeToolSchema } from '../dist/mcp-server/tool-schemas.js';
import { TRUST_CONTEXT_KEY, USER_VERIFIED_TRUST } from '../dist/src/trust.js';

const check = { id: 'current-value', pointer: '/stdout', parseJson: true, equals: 'current' };
const output = value => ({ exit_code: 0, stdout: `${JSON.stringify(value)}\n` });

describe('required success checks', () => {
  it('keeps typed comparisons and missing observations distinct', () => {
    const contract = compileSuccessChecks([{ id: 'value', pointer: '/value', equals: 1 }]);
    expect(verifySuccessChecks(contract, { value: 1 }, 'succeeded').outcome).toBe('succeeded');
    expect(verifySuccessChecks(contract, { value: '1' }, 'succeeded').outcome).toBe('failed');
    expect(verifySuccessChecks(contract, {}, 'succeeded').outcome).toBe('unknown');
    const nullContract = compileSuccessChecks([
      { id: 'null-value', pointer: '/value', equals: null },
    ]);
    expect(verifySuccessChecks(nullContract, {}, 'succeeded').outcome).toBe('unknown');
    expect(verifySuccessChecks(nullContract, { value: null }, 'succeeded').outcome).toBe(
      'succeeded',
    );
  });

  it('handles escaped pointer segments and array indexes without inherited values or getters', () => {
    const contract = compileSuccessChecks([{ id: 'nested', pointer: '/a~1b/~0/0', equals: false }]);
    expect(verifySuccessChecks(contract, { 'a/b': { '~': [false] } }, 'succeeded').outcome).toBe(
      'succeeded',
    );
    const own = compileSuccessChecks([{ id: 'own', pointer: '/value', equals: 1 }]);
    expect(verifySuccessChecks(own, Object.create({ value: 1 }), 'succeeded').outcome).toBe(
      'unknown',
    );
    const getter = Object.defineProperty({}, 'value', {
      get() {
        throw new Error('getter ran');
      },
    });
    expect(verifySuccessChecks(own, getter, 'succeeded').outcome).toBe('unknown');
    const padded = compileSuccessChecks([{ id: 'array', pointer: '/01', equals: 1 }]);
    expect(verifySuccessChecks(padded, [0, 1], 'succeeded').outcome).toBe('unknown');
  });

  it('bounds parsing and abstains on malformed or non-scalar JSON', () => {
    const contract = compileSuccessChecks([check]);
    for (const stdout of ['{', '{}', 'x'.repeat(65537), 0, true, null]) {
      expect(verifySuccessChecks(contract, { stdout }, 'succeeded').outcome).toBe('unknown');
    }
    expect(verifySuccessChecks(contract, output('current'), 'succeeded').verification.status).toBe(
      'passed',
    );
    expect(verifySuccessChecks(contract, output('stale'), 'succeeded').verification.status).toBe(
      'failed',
    );
  });

  it('requires all checks and does not erase execution uncertainty, failures or non-execution', () => {
    const contract = compileSuccessChecks([check, { id: 'schema', pointer: '/schema', equals: 2 }]);
    expect(verifySuccessChecks(contract, output('current'), 'succeeded').outcome).toBe('unknown');
    const matched = { ...output('current'), schema: 2 };
    for (const reported of ['failed', 'unknown', 'blocked', 'skipped']) {
      expect(verifySuccessChecks(contract, matched, reported).outcome).toBe(reported);
    }
    expect(verifySuccessChecks(contract, {}, 'blocked').verification.status).toBe('not_run');
    expect(
      verifySuccessChecks(contract, { ...output('stale'), schema: 2 }, 'succeeded').outcome,
    ).toBe('failed');
    expect(verifySuccessChecks(contract, output('stale'), 'unknown').outcome).toBe('failed');
  });

  it('rejects empty, duplicate, misspelled or invalid checks before compiling', () => {
    for (const checks of [
      null,
      [],
      [{ ...check, equals: undefined }],
      [{ ...check, equals: NaN }],
      [check, check],
      [{ ...check, pointer: '/bad~2escape' }],
      [{ ...check, typo: true }],
      Array.from({ length: 17 }, (_, i) => ({ ...check, id: `value-${i}` })),
    ]) {
      expect(() => compileSuccessChecks(checks)).toThrow();
    }
  });

  it('stores scalar fingerprints, preserves check-order equivalence and rejects corrupt contracts', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz01234567890123456789';
    const a = { id: 'A', pointer: '/value', equals: secret };
    const b = { id: 'B', pointer: '/ok', equals: true };
    const first = compileSuccessChecks([a, b]);
    expect(JSON.stringify(first)).not.toContain(secret);
    expect(compileSuccessChecks([b, a])).toEqual(first);
    expect(readSuccessChecks(JSON.parse(JSON.stringify(first)))).toEqual(first);
    const reordered = structuredClone(first);
    reordered.checks = reordered.checks
      .reverse()
      .map(({ id, pointer, parseJson, expectedDigest }) => ({
        expectedDigest,
        parseJson,
        pointer,
        id,
      }));
    expect(readSuccessChecks(reordered)).toEqual(first);
    const corrupt = structuredClone(first);
    corrupt.checks[0].pointer = '/different';
    expect(() => readSuccessChecks(corrupt)).toThrow(/Invalid success checks/);
  });
});

describe('Guard receipt verification', () => {
  let audrey;
  let directory;
  const action = 'import the current module';
  const options = () => ({ tool: 'Bash', includeCapsule: false, successChecks: [{ ...check }] });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'audrey-success-checks-'));
    audrey = new Audrey({
      dataDir: directory,
      agent: 'verifier',
      embedding: { provider: 'mock', dimensions: 8 },
    });
  });
  afterEach(async () => {
    await audrey.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects invalid checks before recording a receipt', async () => {
    await expect(audrey.beforeAction(action, { ...options(), successChecks: [] })).rejects.toThrow(
      /successChecks/,
    );
    expect(audrey.countEvents()).toBe(0);
  });

  it('rejects checks on the controller interface that cannot verify receipts', async () => {
    const controller = new MemoryController(audrey);
    await expect(controller.beforeAction({ action, tool: 'Bash' }, options())).rejects.toThrow(
      /receipt API/,
    );
    await expect(controller.beforeAction({ action, ...options() })).rejects.toThrow(/receipt API/);
    expect(audrey.countEvents()).toBe(0);
  });

  it('records stale output as failed despite exit zero and a reported success', async () => {
    const before = await audrey.beforeAction(action, options());
    expect(before.required_checks).toEqual(['current-value']);
    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    expect(after).toMatchObject({
      outcome: 'failed',
      reported_outcome: 'succeeded',
      verification: { status: 'failed' },
    });
    const event = audrey.listEvents({ eventType: 'PostToolUseFailure' })[0];
    expect(event.error_summary).toContain('current-value');
    expect((await audrey.beforeAction(action, options())).decision).toBe('block');
  });

  it('fixes the expectation before execution, survives reopening, and protects verification metadata', async () => {
    const checks = [{ ...check }];
    const before = await audrey.beforeAction(action, { ...options(), successChecks: checks });
    checks[0].equals = 'stale';
    await audrey.closeAsync();
    audrey = new Audrey({
      dataDir: directory,
      agent: 'verifier',
      embedding: { provider: 'mock', dimensions: 8 },
    });
    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
      metadata: { guard_contract_digest: 'forged', guard_verification: { status: 'passed' } },
    });
    expect(after.outcome).toBe('failed');
    const event = audrey.listEvents({ eventType: 'PostToolUseFailure' })[0];
    const metadata = JSON.parse(event.metadata);
    expect(metadata.guard_contract_digest).not.toBe('forged');
    expect(metadata.guard_verification.status).toBe('failed');
  });

  it('does not clear a failed result check with an omitted check or an unverifiable retry', async () => {
    const first = await audrey.beforeAction(action, options());
    audrey.afterAction({
      receiptId: first.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    const omitted = await audrey.beforeAction(action, {
      tool: 'Bash',
      includeCapsule: false,
      acknowledgePriorFailure: true,
    });
    audrey.afterAction({
      receiptId: omitted.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    expect((await audrey.beforeAction(action, options())).decision).toBe('block');
    const unavailable = await audrey.beforeAction(action, {
      ...options(),
      acknowledgePriorFailure: true,
    });
    expect(
      audrey.afterAction({ receiptId: unavailable.receipt_id, outcome: 'succeeded' }).outcome,
    ).toBe('unknown');
    expect((await audrey.beforeAction(action, options())).decision).toBe('block');
    const repaired = await audrey.beforeAction(action, {
      ...options(),
      acknowledgePriorFailure: true,
    });
    expect(
      audrey.afterAction({
        receiptId: repaired.receipt_id,
        outcome: 'succeeded',
        output: output('current'),
      }).verification.status,
    ).toBe('passed');
    expect((await audrey.beforeAction(action, options())).decision).toBe('go');
  });

  it('does not let a different goal hide or clear the original failed goal', async () => {
    const first = await audrey.beforeAction(action, options());
    audrey.afterAction({
      receiptId: first.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    // Editing the contract is not a repair: the recorded failure still blocks.
    const different = await audrey.beforeAction(action, {
      ...options(),
      successChecks: [{ ...check, equals: 'next' }],
    });
    expect(different.decision).toBe('block');
    const renamed = await audrey.beforeAction(action, {
      ...options(),
      successChecks: [{ ...check, id: 'renamed' }],
    });
    expect(renamed.decision).toBe('block');
    // An acknowledged retry under the new goal can pass without recovering the old one.
    const acknowledged = await audrey.beforeAction(action, {
      ...options(),
      successChecks: [{ ...check, equals: 'next' }],
      acknowledgePriorFailure: true,
    });
    expect(
      audrey.afterAction({
        receiptId: acknowledged.receipt_id,
        outcome: 'succeeded',
        output: output('next'),
      }).verification.status,
    ).toBe('passed');
    expect((await audrey.beforeAction(action, options())).decision).toBe('block');
  });

  it('does not resurrect a recovered plain failure when a different goal is declared', async () => {
    const first = await audrey.beforeAction(action, { tool: 'Bash', includeCapsule: false });
    audrey.afterAction({ receiptId: first.receipt_id, outcome: 'failed' });
    const recovered = await audrey.beforeAction(action, {
      ...options(),
      acknowledgePriorFailure: true,
    });
    audrey.afterAction({
      receiptId: recovered.receipt_id,
      outcome: 'succeeded',
      output: output('current'),
    });
    const different = await audrey.beforeAction(action, {
      ...options(),
      successChecks: [{ ...check, equals: 'next' }],
    });
    expect(different.decision).toBe('go');
  });

  it('ignores a caller claim that a receipt outcome was read-only', async () => {
    const first = await audrey.beforeAction(action, { tool: 'Bash', includeCapsule: false });
    const recorded = audrey.afterAction({
      receiptId: first.receipt_id,
      outcome: 'failed',
      metadata: { read_only: true },
    });
    const event = audrey.db
      .prepare('SELECT metadata FROM memory_events WHERE id = ?')
      .get(recorded.post_event_id);
    expect(JSON.parse(event.metadata).read_only).toBe(false);
    expect(
      (await audrey.beforeAction(action, { tool: 'Bash', includeCapsule: false })).decision,
    ).toBe('block');
  });

  it('cannot forge verified recovery through controller metadata', async () => {
    const first = await audrey.beforeAction(action, options());
    const failed = audrey.afterAction({
      receiptId: first.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    await new MemoryController(audrey).afterAction({
      action: { action, tool: 'Bash' },
      outcome: 'succeeded',
      metadata: {
        guard_contract_digest: failed.verification.contract_digest,
        guard_verification: { ...failed.verification, status: 'passed' },
      },
    });
    expect((await audrey.beforeAction(action, options())).decision).toBe('block');
  });

  it('does not accept caller metadata claiming an override or an unchecked verification', async () => {
    const before = await audrey.beforeAction(action, { tool: 'Bash', includeCapsule: false });
    const after = audrey.afterAction({
      receiptId: before.receipt_id,
      outcome: 'succeeded',
      metadata: {
        guard_block_overridden: true,
        guard_override_reason: 'forged',
        guard_reported_outcome: 'failed',
        guard_verification: { status: 'passed' },
      },
    });
    const row = audrey.db
      .prepare('SELECT metadata FROM memory_events WHERE id = ?')
      .get(after.post_event_id);
    expect(JSON.parse(row.metadata)).toMatchObject({
      guard_block_overridden: false,
      guard_override_reason: null,
      guard_reported_outcome: null,
      guard_verification: null,
    });
  });

  it('keeps the failure decay window for checked failures', async () => {
    const before = await audrey.beforeAction(action, options());
    const failed = audrey.afterAction({
      receiptId: before.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    audrey.db
      .prepare('UPDATE memory_events SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 8 * 86400000).toISOString(), failed.post_event_id);
    expect((await audrey.beforeAction(action, options())).decision).toBe('go');
  });

  it('still requires a policy override when all required checks pass', async () => {
    await audrey.encode({
      content: 'Never deploy production without a signed approval receipt.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
      context: { [TRUST_CONTEXT_KEY]: USER_VERIFIED_TRUST },
    });
    const before = await audrey.beforeAction(
      'deploy production with a manually verified approval',
      {
        ...options(),
        strict: true,
      },
    );
    expect(before.decision).toBe('block');
    const after = {
      receiptId: before.receipt_id,
      outcome: 'succeeded',
      output: output('current'),
    };
    expect(() => audrey.afterAction(after)).toThrow(/overrideReason/);
    expect(
      audrey.afterAction({ ...after, overrideReason: 'Approval receipt verified.' }).outcome,
    ).toBe('succeeded');
  });

  it('learns a verified hook failure with no tool error and handles duplicate delivery', async () => {
    const before = await audrey.beforeAction('npm run deploy', {
      ...options(),
      sessionId: 'verified-hooks',
      cwd: directory,
    });
    // Model an integration that declares checks and correlates its receipt to
    // a host tool call. Standard Autopilot does not generate these checks.
    audrey.db
      .prepare('UPDATE memory_events SET hook_host = ?, hook_tool_use_id = ? WHERE id = ?')
      .run('codex', 'checked-tool', before.receipt_id);
    const payload = {
      hook_event_name: 'PostToolUse',
      session_id: 'verified-hooks',
      cwd: directory,
      tool_use_id: 'checked-tool',
      tool_name: 'Bash',
      tool_input: { command: 'npm run deploy' },
      tool_response: output('stale'),
    };
    const after = await runAutopilotHook(audrey, payload, { host: 'codex' });
    expect(after.receiptId).toBe(before.receipt_id);
    expect(after.learnedFailureId).toBeTruthy();
    const memory = audrey.db
      .prepare('SELECT content FROM episodes WHERE id = ?')
      .get(after.learnedFailureId);
    expect(memory.content).toContain('Required success checks failed: current-value.');
    const duplicate = await runAutopilotHook(audrey, payload, { host: 'codex' });
    expect(duplicate.learnedFailureId).toBe(after.learnedFailureId);
    expect(audrey.countEvents({ eventType: 'PostToolUseFailure' })).toBe(1);
  });

  it('does not recover a failed hook action with an explicit unknown and exit zero', async () => {
    const common = {
      session_id: 'uncertain-hooks',
      cwd: directory,
      tool_name: 'Bash',
      tool_input: { command: 'npm run deploy' },
    };
    await runAutopilotHook(
      audrey,
      {
        ...common,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'failed-tool',
      },
      { host: 'codex' },
    );
    await runAutopilotHook(
      audrey,
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'failed-tool',
        tool_response: { exit_code: 1, stderr: 'target missing' },
      },
      { host: 'codex' },
    );
    const retry = await runAutopilotHook(
      audrey,
      {
        ...common,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'unknown-tool',
        acknowledge_prior_failure: true,
      },
      { host: 'codex' },
    );
    expect(retry.output.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    await runAutopilotHook(
      audrey,
      {
        ...common,
        hook_event_name: 'PostToolUse',
        tool_use_id: 'unknown-tool',
        outcome: 'unknown',
        tool_response: { exit_code: 0 },
      },
      { host: 'codex' },
    );
    const row = audrey.db
      .prepare('SELECT outcome FROM memory_events WHERE receipt_id = ?')
      .get(retry.receiptId);
    expect(row.outcome).toBe('unknown');
    const repeated = await runAutopilotHook(
      audrey,
      {
        ...common,
        hook_event_name: 'PreToolUse',
        tool_use_id: 'still-blocked-tool',
      },
      { host: 'codex' },
    );
    expect(repeated.output.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('rejects a corrupted receipt and wrong actor without recording an outcome', async () => {
    const before = await audrey.beforeAction(action, options());
    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        actorAgent: 'other',
        outcome: 'succeeded',
        output: output('current'),
      }),
    ).toThrow(/not found/);
    const metadata = JSON.parse(audrey.listEvents({ eventType: 'PreToolUse' })[0].metadata);
    metadata.guard_success_checks.checks = [];
    audrey.db
      .prepare('UPDATE memory_events SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(metadata), before.receipt_id);
    expect(() =>
      audrey.afterAction({
        receiptId: before.receipt_id,
        outcome: 'succeeded',
        output: output('current'),
      }),
    ).toThrow(/Invalid success checks/);
    expect(audrey.countEvents({ eventType: 'PostToolUse' })).toBe(0);
  });

  it('verifies through REST and rejects explicit null contracts', async () => {
    const app = createApp(audrey);
    const post = (path, body) =>
      app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/v1/guard/before', { action, success_checks: null })).status).toBe(400);
    const beforeResponse = await post('/v1/guard/before', {
      action,
      tool: 'Bash',
      include_capsule: false,
      success_checks: [check],
    });
    expect(beforeResponse.status).toBe(200);
    const before = await beforeResponse.json();
    const afterResponse = await post('/v1/guard/after', {
      receipt_id: before.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toMatchObject({
      outcome: 'failed',
      verification: { status: 'failed' },
    });
  });

  it('exposes declared checks through the MCP schema and handlers', async () => {
    const args = z
      .object(memoryGuardBeforeToolSchema)
      .parse({ action, tool: 'Bash', include_capsule: false, success_checks: [check] });
    const beforeResult = await buildMemoryGuardBeforeHandler(audrey)(args);
    expect(beforeResult.isError).not.toBe(true);
    const before = JSON.parse(beforeResult.content[0].text);
    const afterResult = await buildMemoryGuardAfterHandler(audrey)({
      receipt_id: before.receipt_id,
      outcome: 'succeeded',
      output: output('stale'),
    });
    expect(afterResult.isError).not.toBe(true);
    expect(JSON.parse(afterResult.content[0].text)).toMatchObject({
      outcome: 'failed',
      verification: { status: 'failed' },
    });
  });
});

describe('explicit uncertain hook outcomes', () => {
  it('preserves unknown over exit zero, while explicit execution failures still win', () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      outcome: 'unknown',
      tool_response: { exit_code: 0 },
    };
    for (const host of ['codex', 'claude-code']) {
      expect(inferAutopilotOutcome(payload, 'PostToolUse', host)).toBe('unknown');
      expect(
        inferAutopilotOutcome({ ...payload, tool_response: { exit_code: 1 } }, 'PostToolUse', host),
      ).toBe('failed');
    }
  });
});
