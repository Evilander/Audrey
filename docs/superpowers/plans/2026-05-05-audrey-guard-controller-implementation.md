# Audrey Guard Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Audrey Guard as the v0.23 controller loop that checks memory before action, returns evidence-backed go/caution/block decisions, records an auditable receipt, and learns from post-action outcomes.

**Architecture:** Add a focused `src/controller.ts` that composes existing `preflight`, reflex mapping, `observeTool`, `validate`, and `memory_events` metadata without a schema migration. Expose the controller through `Audrey.beforeAction()` / `Audrey.afterAction()`, REST routes, MCP tools, CLI subcommands, and docs. Keep `memory_preflight` and `memory_reflexes` intact.

**Tech Stack:** TypeScript, Node.js 20+, SQLite via `better-sqlite3`, Vitest, Hono REST routes, MCP SDK, existing Audrey CLI in `mcp-server/index.ts`.

---

## Research Notes

- Claude Code hooks are the key enforcement point: `PreToolUse` runs before a tool call and can allow, deny, ask, or defer; `PostToolUse` runs after tool completion and can provide feedback. Source: https://code.claude.com/docs/en/hooks
- LangGraph's memory docs distinguish short-term and long-term memory and explicitly name semantic, episodic, and procedural memory. Audrey already has these memory types; Guard makes them operational before action. Source: https://docs.langchain.com/oss/python/concepts/memory
- Mem0 positions itself as a production memory layer with MCP tools for add/search/update/delete/list events. Audrey's differentiator should not be "also an MCP memory server"; it should be the before/after action controller. Sources: https://docs.mem0.ai/platform/overview and https://docs.mem0.ai/platform/mem0-mcp
- Letta memory blocks stay visible in context and can store tool guidelines, shared policies, and scratchpad state. Audrey Guard should produce compact machine/human guidance without forcing every memory to stay always visible. Source: https://docs.letta.com/guides/core-concepts/memory/memory-blocks
- Zep emphasizes a dynamic knowledge graph and context block. Audrey's near-term wedge should remain local-first action receipts and feedback loops rather than competing head-on as a hosted graph store. Source: https://help.getzep.com/concepts

## Agent Research Summary

Two read-only explorer agents reviewed the repo.

- Controller-core agent found the cleanest path is to run preflight once, then extract a pure helper from `src/reflexes.ts` so `beforeAction()` derives reflexes from that same preflight result.
- Surface agent found the right insertion points: REST routes beside `/v1/preflight`, MCP schemas beside existing preflight/reflex schemas, CLI commands in the existing dispatcher, and docs in README sidecar tables.
- Both agents flagged the same pitfall: `evidence_ids` can include synthetic recent-failure ids like `failure:npm test:<timestamp>`, so `afterAction()` must skip nonexistent memory ids when applying validation feedback.

## File Structure

- Modify `src/reflexes.ts`: export a pure `buildReflexReportFromPreflight(preflight, options)` helper so existing `buildReflexReport()` and new controller code share one reflex mapping.
- Create `src/controller.ts`: define `GuardBeforeOptions`, `GuardDecision`, `GuardAfterInput`, `GuardOutcome`, `beforeAction()`, and `afterAction()`.
- Modify `src/audrey.ts`: add `beforeAction()` and `afterAction()` methods that delegate to the controller and emit `guard-before` / `guard-after` events.
- Modify `src/index.ts`: export controller functions and types.
- Modify `src/routes.ts`: add sanitized `POST /v1/guard/before` and `POST /v1/guard/after`.
- Modify `mcp-server/index.ts`: add guard schemas, MCP tools, CLI parser/formatters, help text, and dispatcher entries.
- Modify `README.md`: add Guard routes, CLI examples, and a short "memory before action" receipt demo.
- Modify `docs/PRODUCTION_BACKLOG.md`: mark the v0.23 controller chassis as implemented in the v0.23 product direction section.
- Add `tests/controller.test.js`: core controller tests.
- Modify `tests/http-api.test.js`: REST guard tests.
- Modify `tests/mcp-server.test.js`: schema and CLI tests.

## Design Decisions Locked For v0.23

- No database schema migration. Use existing `memory_events.metadata` JSON as the receipt link.
- `beforeAction()` always records one `PreToolUse` event. Guard is receipt-bearing by definition; callers that do not want receipts should keep using `preflight()`.
- `afterAction()` records `PostToolUse` for `succeeded`, `skipped`, `blocked`, or `unknown`; records `PostToolUseFailure` for `failed`.
- Feedback uses an explicit `evidence_feedback` object mapping memory ids to `used`, `helpful`, or `wrong`.
- Synthetic evidence ids that do not exist in memory tables are returned as skipped validation entries, not errors.
- The CLI `guard --json` exits `1` for `decision=block` and `0` for `go` or `caution`. Human output also clearly shows blocked decisions.

---

### Task 1: Extract Single-Pass Reflex Builder

**Files:**
- Modify: `src/reflexes.ts`
- Test: `tests/reflexes.test.js`

- [ ] **Step 1: Write the failing test**

Add this test to `tests/reflexes.test.js`:

```js
  it('builds reflexes from an existing preflight without running preflight again', async () => {
    await audrey.encode({
      content: 'Never deploy Audrey without checking the package tarball first.',
      source: 'direct-observation',
      tags: ['must-follow', 'release'],
    });

    const preflight = await audrey.preflight('deploy Audrey release', {
      strict: true,
      includeCapsule: false,
    });

    const { buildReflexReportFromPreflight } = await import('../dist/src/reflexes.js');
    const report = buildReflexReportFromPreflight(preflight, { includePreflight: true });

    expect(report.decision).toBe('block');
    expect(report.reflexes.some(r => r.response_type === 'block')).toBe(true);
    expect(report.preflight).toBe(preflight);
    expect(report.evidence_ids).toEqual(preflight.evidence_ids);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run build && npx vitest run tests/reflexes.test.js
```

Expected: FAIL because `buildReflexReportFromPreflight` is not exported.

- [ ] **Step 3: Implement the pure helper**

In `src/reflexes.ts`, add this function above `buildReflexReport()` and update `buildReflexReport()` to use it:

```ts
export function buildReflexReportFromPreflight(
  preflight: MemoryPreflight,
  options: Pick<ReflexOptions, 'includePreflight'> = {},
): MemoryReflexReport {
  const reflexes = preflight.warnings.map((warning): MemoryReflex => ({
    id: reflexId(warning, preflight.action, preflight.tool),
    trigger: triggerFor(warning, preflight.action, preflight.tool),
    response_type: responseType(warning, preflight.decision),
    severity: warning.severity,
    source: warning.type,
    response: responseFor(warning),
    reason: warning.reason,
    ...(warning.evidence_id ? { evidence_id: warning.evidence_id } : {}),
    action: preflight.action,
    ...(preflight.tool ? { tool: preflight.tool } : {}),
    ...(preflight.cwd ? { cwd: preflight.cwd } : {}),
  }));

  return {
    action: preflight.action,
    query: preflight.query,
    ...(preflight.tool ? { tool: preflight.tool } : {}),
    ...(preflight.cwd ? { cwd: preflight.cwd } : {}),
    generated_at: new Date().toISOString(),
    decision: preflight.decision,
    risk_score: preflight.risk_score,
    summary: summarizeReflexes(preflight.decision, reflexes),
    reflexes,
    evidence_ids: preflight.evidence_ids,
    recommended_actions: preflight.recommended_actions,
    ...(options.includePreflight ? { preflight } : {}),
  };
}
```

Then replace the existing reflex construction in `buildReflexReport()` with:

```ts
export async function buildReflexReport(
  audrey: Audrey,
  action: string,
  options: ReflexOptions = {},
): Promise<MemoryReflexReport> {
  const preflight = await buildPreflight(audrey, action, {
    ...options,
    includeCapsule: options.includeCapsule ?? false,
  });

  return buildReflexReportFromPreflight(preflight, options);
}
```

- [ ] **Step 4: Export the helper from the package**

In `src/index.ts`, change:

```ts
export { buildReflexReport } from './reflexes.js';
```

to:

```ts
export { buildReflexReport, buildReflexReportFromPreflight } from './reflexes.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm run build && npx vitest run tests/reflexes.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reflexes.ts src/index.ts tests/reflexes.test.js
git commit -m "feat: derive reflexes from existing preflight"
```

---

### Task 2: Add Controller Core

**Files:**
- Create: `src/controller.ts`
- Modify: `src/audrey.ts`
- Modify: `src/index.ts`
- Test: `tests/controller.test.js`

- [ ] **Step 1: Write the failing controller tests**

Create `tests/controller.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run build && npx vitest run tests/controller.test.js
```

Expected: FAIL because `audrey.beforeAction` and `audrey.afterAction` do not exist.

- [ ] **Step 3: Create controller types and beforeAction implementation**

Create `src/controller.ts`:

```ts
import type { Audrey } from './audrey.js';
import type { EventOutcome } from './events.js';
import type { MemoryValidateOutcome, MemoryValidateResult } from './feedback.js';
import type { MemoryPreflight, PreflightOptions } from './preflight.js';
import { buildPreflight } from './preflight.js';
import {
  buildReflexReportFromPreflight,
  type MemoryReflex,
} from './reflexes.js';

export interface GuardBeforeOptions extends PreflightOptions {
  recordEvent?: boolean;
}

export interface GuardDecision {
  receipt_id: string;
  preflight_event_id: string;
  action: string;
  query: string;
  tool?: string;
  cwd?: string;
  generated_at: string;
  decision: MemoryPreflight['decision'];
  verdict: MemoryPreflight['verdict'];
  ok_to_proceed: boolean;
  risk_score: number;
  summary: string;
  warnings: MemoryPreflight['warnings'];
  reflexes: MemoryReflex[];
  recommended_actions: string[];
  evidence_ids: string[];
  recent_failures: MemoryPreflight['recent_failures'];
  status?: MemoryPreflight['status'];
  capsule?: MemoryPreflight['capsule'];
}

export interface GuardAfterInput {
  receiptId: string;
  tool?: string;
  sessionId?: string;
  input?: unknown;
  output?: unknown;
  outcome?: EventOutcome;
  errorSummary?: string;
  cwd?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
  retainDetails?: boolean;
  evidenceFeedback?: Record<string, MemoryValidateOutcome>;
}

export interface GuardValidatedEvidence {
  id: string;
  outcome: MemoryValidateOutcome;
  validated: boolean;
  result?: MemoryValidateResult;
  reason?: string;
}

export interface GuardOutcome {
  receipt_id: string;
  post_event_id: string;
  outcome: EventOutcome;
  validated_evidence: GuardValidatedEvidence[];
  learning_summary: string;
}

function postEventTypeFor(outcome: EventOutcome): 'PostToolUse' | 'PostToolUseFailure' {
  return outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse';
}

function summarizeLearning(validated: GuardValidatedEvidence[]): string {
  const applied = validated.filter(v => v.validated).length;
  const skipped = validated.length - applied;
  if (validated.length === 0) return 'Recorded action outcome; no evidence feedback supplied.';
  return `Recorded action outcome; validated ${applied} evidence item${applied === 1 ? '' : 's'}`
    + (skipped > 0 ? ` and skipped ${skipped} non-memory evidence item${skipped === 1 ? '' : 's'}.` : '.');
}

export async function beforeAction(audrey: Audrey, action: string, options: GuardBeforeOptions = {}): Promise<GuardDecision> {
  const preflight = await buildPreflight(audrey, action, {
    ...options,
    recordEvent: true,
  });
  const reflexReport = buildReflexReportFromPreflight(preflight);
  const receiptId = preflight.preflight_event_id;
  if (!receiptId) {
    throw new Error('guard beforeAction could not record a receipt event');
  }

  const events = audrey.listEvents({ eventType: 'PreToolUse', limit: 20 });
  const receipt = events.find(event => event.id === receiptId);
  if (receipt) {
    const metadata = receipt.metadata ? JSON.parse(receipt.metadata) as Record<string, unknown> : {};
    audrey.db.prepare('UPDATE memory_events SET metadata = ? WHERE id = ?').run(JSON.stringify({
      ...metadata,
      guard: true,
      guard_phase: 'before',
      evidence_ids: preflight.evidence_ids,
      reflex_ids: reflexReport.reflexes.map(r => r.id),
    }), receiptId);
  }

  return {
    receipt_id: receiptId,
    preflight_event_id: receiptId,
    action: preflight.action,
    query: preflight.query,
    ...(preflight.tool ? { tool: preflight.tool } : {}),
    ...(preflight.cwd ? { cwd: preflight.cwd } : {}),
    generated_at: preflight.generated_at,
    decision: preflight.decision,
    verdict: preflight.verdict,
    ok_to_proceed: preflight.ok_to_proceed,
    risk_score: preflight.risk_score,
    summary: preflight.summary,
    warnings: preflight.warnings,
    reflexes: reflexReport.reflexes,
    recommended_actions: preflight.recommended_actions,
    evidence_ids: preflight.evidence_ids,
    recent_failures: preflight.recent_failures,
    ...(preflight.status ? { status: preflight.status } : {}),
    ...(preflight.capsule ? { capsule: preflight.capsule } : {}),
  };
}
```

- [ ] **Step 4: Add afterAction implementation**

Append to `src/controller.ts`:

```ts
export function afterAction(audrey: Audrey, input: GuardAfterInput): GuardOutcome {
  if (!input.receiptId || input.receiptId.trim().length === 0) {
    throw new Error('receiptId is required');
  }

  const receipt = audrey.listEvents({ eventType: 'PreToolUse', limit: 1000 })
    .find(event => event.id === input.receiptId);
  if (!receipt) {
    throw new Error(`guard receipt not found: ${input.receiptId}`);
  }

  const outcome = input.outcome ?? 'unknown';
  const receiptMetadata = receipt.metadata ? JSON.parse(receipt.metadata) as Record<string, unknown> : {};
  const result = audrey.observeTool({
    event: postEventTypeFor(outcome),
    tool: input.tool ?? receipt.tool_name ?? 'unknown',
    sessionId: input.sessionId ?? receipt.session_id ?? undefined,
    input: input.input,
    output: input.output,
    outcome,
    errorSummary: input.errorSummary,
    cwd: input.cwd ?? receipt.cwd ?? undefined,
    files: input.files,
    metadata: {
      ...(input.metadata ?? {}),
      guard: true,
      guard_phase: 'after',
      receipt_id: input.receiptId,
      preflight_event_id: input.receiptId,
      preflight_decision: receiptMetadata.preflight_decision,
      preflight_warning_count: receiptMetadata.preflight_warning_count,
    },
    retainDetails: input.retainDetails,
  });

  const validated: GuardValidatedEvidence[] = [];
  for (const [id, feedbackOutcome] of Object.entries(input.evidenceFeedback ?? {})) {
    const feedback = audrey.validate({ id, outcome: feedbackOutcome });
    if (feedback) {
      validated.push({ id, outcome: feedbackOutcome, validated: true, result: feedback });
    } else {
      validated.push({
        id,
        outcome: feedbackOutcome,
        validated: false,
        reason: 'No memory row matched this evidence id.',
      });
    }
  }

  return {
    receipt_id: input.receiptId,
    post_event_id: result.event.id,
    outcome,
    validated_evidence: validated,
    learning_summary: summarizeLearning(validated),
  };
}
```

- [ ] **Step 5: Add Audrey class methods**

In `src/audrey.ts`, add imports:

```ts
import {
  beforeAction as guardBeforeAction,
  afterAction as guardAfterAction,
  type GuardBeforeOptions,
  type GuardDecision,
  type GuardAfterInput,
  type GuardOutcome,
} from './controller.js';
```

Add methods near `preflight()` and `reflexes()`:

```ts
  async beforeAction(action: string, options: GuardBeforeOptions = {}): Promise<GuardDecision> {
    const decision = await guardBeforeAction(this, action, options);
    this.emit('guard-before', decision);
    return decision;
  }

  afterAction(input: GuardAfterInput): GuardOutcome {
    const outcome = guardAfterAction(this, input);
    this.emit('guard-after', outcome);
    return outcome;
  }
```

- [ ] **Step 6: Export controller types**

In `src/index.ts`, add:

```ts
export { beforeAction, afterAction } from './controller.js';
export type {
  GuardBeforeOptions,
  GuardDecision,
  GuardAfterInput,
  GuardOutcome,
  GuardValidatedEvidence,
} from './controller.js';
```

- [ ] **Step 7: Run controller tests**

Run:

```bash
npm run build && npx vitest run tests/controller.test.js
```

Expected: PASS.

- [ ] **Step 8: Run preflight/reflex regression tests**

Run:

```bash
npm run build && npx vitest run tests/preflight.test.js tests/reflexes.test.js tests/controller.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/controller.ts src/audrey.ts src/index.ts tests/controller.test.js
git commit -m "feat: add Audrey Guard controller"
```

---

### Task 3: Add REST Guard Routes

**Files:**
- Modify: `src/routes.ts`
- Test: `tests/http-api.test.js`

- [ ] **Step 1: Write failing REST tests**

Add these tests after the existing `/v1/reflexes` test in `tests/http-api.test.js`:

```js
  it('POST /v1/guard/before returns a receipt-backed guard decision', async () => {
    audrey.observeTool({
      event: 'PostToolUse',
      tool: 'npm test',
      outcome: 'failed',
      errorSummary: 'Vitest failed with spawn EPERM on this host',
      cwd: process.cwd(),
    });

    const res = await app.request('/v1/guard/before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'run npm test before release',
        tool: 'npm test',
        include_capsule: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt_id).toMatch(/^01/);
    expect(body.decision).toBe('caution');
    expect(body.reflexes.length).toBeGreaterThan(0);
    expect(body.warnings.some(w => w.type === 'recent_failure')).toBe(true);
  });

  it('POST /v1/guard/before rejects blank action', async () => {
    const res = await app.request('/v1/guard/before', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '   ', tool: 'Bash' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/action/i);
  });

  it('POST /v1/guard/after records redacted outcome linked to receipt', async () => {
    const before = await audrey.beforeAction('call remote service', {
      tool: 'curl',
      includeCapsule: false,
    });

    const res = await app.request('/v1/guard/after', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt_id: before.receipt_id,
        tool: 'curl',
        outcome: 'failed',
        error_summary: 'request failed with token sk-test-secret',
        output: 'token sk-test-secret appeared in stderr',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt_id).toBe(before.receipt_id);
    expect(body.post_event_id).toMatch(/^01/);
    expect(JSON.stringify(body)).not.toContain('sk-test-secret');

    const events = audrey.listEvents({ eventType: 'PostToolUseFailure', toolName: 'curl' });
    expect(events).toHaveLength(1);
    expect(events[0].error_summary).not.toContain('sk-test-secret');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run build && npx vitest run tests/http-api.test.js
```

Expected: FAIL because `/v1/guard/before` and `/v1/guard/after` do not exist.

- [ ] **Step 3: Add explicit route body types**

In `src/routes.ts`, extend `RouteBody` with:

```ts
  receipt_id?: string;
  receiptId?: string;
  input?: unknown;
  output?: unknown;
  outcome?: 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'unknown';
  error_summary?: string;
  errorSummary?: string;
  metadata?: Record<string, unknown>;
  retain_details?: boolean;
  retainDetails?: boolean;
  evidence_feedback?: Record<string, 'used' | 'helpful' | 'wrong'>;
  evidenceFeedback?: Record<string, 'used' | 'helpful' | 'wrong'>;
```

- [ ] **Step 4: Add sanitized guard routes**

In `src/routes.ts`, add these routes after `/v1/reflexes`:

```ts
  app.post('/v1/guard/before', async (c) => {
    try {
      const body = await c.req.json();
      const action = actionFromBody(body);
      if (typeof action !== 'string' || action.trim().length === 0) {
        return c.json({ error: 'action must be a non-empty string' }, 400);
      }

      const result = await audrey.beforeAction(action, {
        ...preflightOptionsFromBody(body),
        recordEvent: true,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/v1/guard/after', async (c) => {
    try {
      const body = await c.req.json();
      const receiptId = body.receipt_id ?? body.receiptId;
      if (typeof receiptId !== 'string' || receiptId.trim().length === 0) {
        return c.json({ error: 'receipt_id is required' }, 400);
      }

      const result = audrey.afterAction({
        receiptId,
        tool: body.tool,
        sessionId: body.session_id ?? body.sessionId,
        input: body.input,
        output: body.output,
        outcome: body.outcome,
        errorSummary: body.error_summary ?? body.errorSummary,
        cwd: body.cwd,
        files: body.files,
        metadata: body.metadata,
        retainDetails: body.retain_details ?? body.retainDetails,
        evidenceFeedback: body.evidence_feedback ?? body.evidenceFeedback,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /receipt not found/i.test(message) ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });
```

- [ ] **Step 5: Run REST tests**

Run:

```bash
npm run build && npx vitest run tests/http-api.test.js tests/controller.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts tests/http-api.test.js
git commit -m "feat: expose guard controller over REST"
```

---

### Task 4: Add MCP Guard Tools And Schemas

**Files:**
- Modify: `mcp-server/index.ts`
- Test: `tests/mcp-server.test.js`

- [ ] **Step 1: Write failing schema tests**

Update the imports in `tests/mcp-server.test.js` to include:

```js
  memoryGuardBeforeToolSchema,
  memoryGuardAfterToolSchema,
```

Add these tests near the existing `memory_preflight` and `memory_reflexes` schema tests:

```js
  it('memory_guard_before mirrors preflight inputs', () => {
    const schema = z.object(memoryGuardBeforeToolSchema);
    expect(schema.safeParse({ action: '', tool: 'Bash' }).success).toBe(false);
    expect(schema.safeParse({
      action: 'run npm test',
      tool: 'npm test',
      strict: true,
      failure_window_hours: 24,
      record_event: true,
      include_capsule: false,
      scope: 'agent',
    }).success).toBe(true);
  });

  it('memory_guard_after accepts observe-tool outcome payloads', () => {
    const schema = z.object(memoryGuardAfterToolSchema);
    expect(schema.safeParse({
      receipt_id: '01KTESTRECEIPT',
      tool: 'npm test',
      outcome: 'failed',
      error_summary: 'test failed',
      metadata: { source: 'unit-test' },
      evidence_feedback: { '01KMEMORY': 'helpful' },
    }).success).toBe(true);
    expect(schema.safeParse({
      receipt_id: '01KTESTRECEIPT',
      tool: 'npm test',
      outcome: 'exploded',
    }).success).toBe(false);
  });
```

- [ ] **Step 2: Run schema tests to verify they fail**

Run:

```bash
npm run build && npx vitest run tests/mcp-server.test.js
```

Expected: FAIL because guard schemas are not exported.

- [ ] **Step 3: Add MCP schemas**

In `mcp-server/index.ts`, add after `memoryReflexesToolSchema`:

```ts
export const memoryGuardBeforeToolSchema = {
  ...memoryPreflightToolSchema,
};

export const memoryGuardAfterToolSchema = {
  receipt_id: z.string().refine(isNonEmptyText, 'Receipt id must not be empty').describe('Guard receipt id returned by memory_guard_before.'),
  tool: z.string().optional().describe('Tool name observed after the guard decision.'),
  session_id: z.string().optional().describe('Session identifier for grouping related events.'),
  input: z.unknown().optional().describe('Tool input. Hashed and not stored raw unless retain_details is true.'),
  output: z.unknown().optional().describe('Tool output. Summarized by default; redacted if retained.'),
  outcome: z.enum(['succeeded', 'failed', 'blocked', 'skipped', 'unknown']).optional().describe('Post-action execution outcome.'),
  error_summary: z.string().optional().describe('Short error description if the tool failed. Redacted and truncated.'),
  cwd: z.string().optional().describe('Working directory at the time of the tool call.'),
  files: z.array(z.string()).optional().describe('File paths to fingerprint.'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Additional structured metadata, redacted before storage.'),
  retain_details: z.boolean().optional().describe('If true, redacted input/output payloads are stored alongside hashes.'),
  evidence_feedback: z.record(z.string(), z.enum(['used', 'helpful', 'wrong'])).optional().describe(
    'Map evidence memory ids to feedback outcomes. Synthetic evidence ids are skipped.'
  ),
};
```

- [ ] **Step 4: Register MCP tools**

In `mcp-server/index.ts`, add after `memory_reflexes`:

```ts
  server.tool('memory_guard_before', memoryGuardBeforeToolSchema, async ({
    action,
    tool,
    session_id,
    cwd,
    files,
    strict,
    limit,
    budget_chars,
    mode,
    failure_window_hours,
    include_status,
    record_event,
    include_capsule,
    scope,
  }) => {
    try {
      const result = await audrey.beforeAction(action, {
        tool,
        sessionId: session_id,
        cwd,
        files,
        strict,
        limit,
        budgetChars: budget_chars,
        mode,
        recentFailureWindowHours: failure_window_hours,
        includeStatus: include_status,
        recordEvent: true,
        includeCapsule: include_capsule,
        scope: scope ?? 'agent',
      });
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_guard_after', memoryGuardAfterToolSchema, async ({
    receipt_id,
    tool,
    session_id,
    input,
    output,
    outcome,
    error_summary,
    cwd,
    files,
    metadata,
    retain_details,
    evidence_feedback,
  }) => {
    try {
      const result = audrey.afterAction({
        receiptId: receipt_id,
        tool,
        sessionId: session_id,
        input,
        output,
        outcome,
        errorSummary: error_summary,
        cwd,
        files,
        metadata,
        retainDetails: retain_details,
        evidenceFeedback: evidence_feedback,
      });
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  });
```

- [ ] **Step 5: Run MCP tests**

Run:

```bash
npm run build && npx vitest run tests/mcp-server.test.js tests/controller.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/index.ts tests/mcp-server.test.js
git commit -m "feat: add guard MCP tools"
```

---

### Task 5: Add Guard CLI Commands

**Files:**
- Modify: `mcp-server/index.ts`
- Test: `tests/mcp-server.test.js`

- [ ] **Step 1: Write failing CLI tests**

Add these tests to the `describe('CLI surface')` block in `tests/mcp-server.test.js`:

```js
  it('--help lists guard commands', () => {
    const r = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('guard');
    expect(r.stdout).toContain('guard-after');
  });

  it('guard --json emits a machine-readable decision', () => {
    const r = spawnSync(process.execPath, [
      cli,
      'guard',
      '--json',
      '--tool',
      'Bash',
      'list files before editing',
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AUDREY_DATA_DIR: './test-cli-guard',
        AUDREY_EMBEDDING_PROVIDER: 'mock',
      },
    });
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.receipt_id).toMatch(/^01/);
    expect(body.decision).toBe('go');
    expect(Array.isArray(body.evidence_ids)).toBe(true);
  });

  it('guard requires an action', () => {
    const r = spawnSync(process.execPath, [cli, 'guard', '--tool', 'Bash'], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('guard: action is required');
  });
```

Add this cleanup inside the `describe('CLI surface')` block in `tests/mcp-server.test.js`, directly after `const cli = resolve('dist/mcp-server/index.js');`:

```js
  afterEach(() => {
    if (existsSync('./test-cli-guard')) rmSync('./test-cli-guard', { recursive: true });
  });
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run:

```bash
npm run build && npx vitest run tests/mcp-server.test.js
```

Expected: FAIL because `guard` is an unknown command.

- [ ] **Step 3: Add CLI parsers and formatters**

In `mcp-server/index.ts`, add near `parseObserveToolArgs()`:

```ts
function parseGuardArgs(argv: string[]): {
  action?: string;
  tool?: string;
  sessionId?: string;
  cwd?: string;
  strict?: boolean;
  includeCapsule?: boolean;
  json?: boolean;
} {
  const out: Record<string, unknown> = { includeCapsule: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--tool') out.tool = next();
    else if (token === '--session-id') out.sessionId = next();
    else if (token === '--cwd') out.cwd = next();
    else if (token === '--strict') out.strict = true;
    else if (token === '--include-capsule') out.includeCapsule = true;
    else if (token === '--json') out.json = true;
    else if (token && !token.startsWith('-')) positionals.push(token);
  }
  out.action = positionals.join(' ').trim();
  return out as ReturnType<typeof parseGuardArgs>;
}

function formatGuardDecision(result: Awaited<ReturnType<Audrey['beforeAction']>>): string {
  const lines = [
    `[audrey] guard ${result.decision.toUpperCase()} - ${result.summary}`,
    `receipt: ${result.receipt_id}`,
  ];
  if (result.recommended_actions.length > 0) {
    lines.push('recommended actions:');
    for (const action of result.recommended_actions.slice(0, 5)) {
      lines.push(`  - ${action}`);
    }
  }
  if (result.reflexes.length > 0) {
    lines.push('reflexes:');
    for (const reflex of result.reflexes.slice(0, 5)) {
      lines.push(`  - ${reflex.response_type}: ${reflex.response}`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Add guard CLI command**

Add:

```ts
async function guardCli(): Promise<void> {
  const args = parseGuardArgs(process.argv.slice(3));
  if (!args.action) {
    console.error('[audrey] guard: action is required');
    process.exit(2);
  }

  const dataDir = resolveDataDir(process.env);
  const embedding = resolveEmbeddingProvider(process.env, process.env['AUDREY_EMBEDDING_PROVIDER']);
  const audrey = new Audrey({
    dataDir,
    agent: process.env['AUDREY_AGENT'] ?? 'guard',
    embedding,
  });

  try {
    const result = await audrey.beforeAction(args.action, {
      tool: args.tool,
      sessionId: args.sessionId,
      cwd: args.cwd,
      strict: args.strict,
      includeCapsule: args.includeCapsule,
      recordEvent: true,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatGuardDecision(result));
    if (result.decision === 'block') process.exitCode = 1;
  } finally {
    await audrey.closeAsync();
  }
}
```

- [ ] **Step 5: Wire dispatcher and help**

Update `KNOWN_SUBCOMMANDS` to include `'guard'` and `'guard-after'`.

In `printHelp()`, add:

```text
  guard                         Check memory before an action and return a receipt
  guard-after                   Record post-action outcome for a guard receipt
```

In the direct-run dispatcher, add before `impact`:

```ts
  } else if (subcommand === 'guard') {
    guardCli().catch(err => {
      console.error('[audrey] guard failed:', err);
      process.exit(1);
    });
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
npm run build && npx vitest run tests/mcp-server.test.js
```

Expected: PASS for the new `guard` tests.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/index.ts tests/mcp-server.test.js
git commit -m "feat: add guard CLI before-action command"
```

---

### Task 6: Add Guard-After CLI

**Files:**
- Modify: `mcp-server/index.ts`
- Test: `tests/mcp-server.test.js`

- [ ] **Step 1: Write failing guard-after CLI test**

Add this test to the `describe('CLI surface')` block:

```js
  it('guard-after records hook-shaped stdin payloads', () => {
    const before = spawnSync(process.execPath, [
      cli,
      'guard',
      '--json',
      '--tool',
      'Bash',
      'run a safe command',
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AUDREY_DATA_DIR: './test-cli-guard-after',
        AUDREY_EMBEDDING_PROVIDER: 'mock',
      },
    });
    expect(before.status).toBe(0);
    const receipt = JSON.parse(before.stdout).receipt_id;

    const after = spawnSync(process.execPath, [
      cli,
      'guard-after',
      '--receipt',
      receipt,
    ], {
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        session_id: 'S-cli',
        tool_response: { success: true, stdout: 'ok' },
      }),
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AUDREY_DATA_DIR: './test-cli-guard-after',
        AUDREY_EMBEDDING_PROVIDER: 'mock',
      },
    });
    expect(after.status).toBe(0);
    const body = JSON.parse(after.stdout);
    expect(body.receipt_id).toBe(receipt);
    expect(body.post_event_id).toMatch(/^01/);
    expect(body.outcome).toBe('succeeded');
  });
```

Extend the same CLI `afterEach()` cleanup so it removes both guard test stores:

```js
  afterEach(() => {
    if (existsSync('./test-cli-guard')) rmSync('./test-cli-guard', { recursive: true });
    if (existsSync('./test-cli-guard-after')) rmSync('./test-cli-guard-after', { recursive: true });
  });
```

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
npm run build && npx vitest run tests/mcp-server.test.js
```

Expected: FAIL because `guard-after` is not implemented.

- [ ] **Step 3: Add parser**

In `mcp-server/index.ts`, add:

```ts
function parseGuardAfterArgs(argv: string[]): {
  receiptId?: string;
  tool?: string;
  sessionId?: string;
  outcome?: 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'unknown';
  errorSummary?: string;
  cwd?: string;
  json?: boolean;
} {
  const out: Record<string, unknown> = { json: true };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--receipt' || token === '--receipt-id') out.receiptId = next();
    else if (token === '--tool') out.tool = next();
    else if (token === '--session-id') out.sessionId = next();
    else if (token === '--outcome') out.outcome = next();
    else if (token === '--error-summary') out.errorSummary = next();
    else if (token === '--cwd') out.cwd = next();
    else if (token === '--json') out.json = true;
  }
  return out as ReturnType<typeof parseGuardAfterArgs>;
}
```

- [ ] **Step 4: Add guard-after CLI command**

Add:

```ts
async function guardAfterCli(): Promise<void> {
  const args = parseGuardAfterArgs(process.argv.slice(3));
  if (!args.receiptId) {
    console.error('[audrey] guard-after: --receipt is required');
    process.exit(2);
  }

  let stdinPayload: Record<string, unknown> | null = null;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) {
      try { stdinPayload = JSON.parse(raw) as Record<string, unknown>; }
      catch { console.error('[audrey] guard-after: stdin was not valid JSON, ignoring.'); }
    }
  }

  const resp = (stdinPayload?.tool_response as Record<string, unknown> | undefined) ?? undefined;
  const successField = resp?.['success'];
  const errField = resp?.['error'] ?? resp?.['stderr'];
  const inferredOutcome = typeof successField === 'boolean'
    ? (successField ? 'succeeded' : 'failed')
    : errField ? 'failed' : undefined;

  const dataDir = resolveDataDir(process.env);
  const embedding = resolveEmbeddingProvider(process.env, process.env['AUDREY_EMBEDDING_PROVIDER']);
  const audrey = new Audrey({
    dataDir,
    agent: process.env['AUDREY_AGENT'] ?? 'guard-after',
    embedding,
  });

  try {
    const result = audrey.afterAction({
      receiptId: args.receiptId,
      tool: args.tool ?? (stdinPayload?.tool_name as string | undefined),
      sessionId: args.sessionId ?? (stdinPayload?.session_id as string | undefined),
      input: stdinPayload?.tool_input ?? stdinPayload?.input,
      output: stdinPayload?.tool_response ?? stdinPayload?.tool_output ?? stdinPayload?.output,
      outcome: args.outcome ?? inferredOutcome,
      errorSummary: args.errorSummary ?? (typeof errField === 'string' ? errField : undefined),
      cwd: args.cwd ?? (stdinPayload?.cwd as string | undefined),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await audrey.closeAsync();
  }
}
```

- [ ] **Step 5: Wire dispatcher**

Add dispatcher branch:

```ts
  } else if (subcommand === 'guard-after') {
    guardAfterCli().catch(err => {
      console.error('[audrey] guard-after failed:', err);
      process.exit(1);
    });
```

- [ ] **Step 6: Run CLI tests**

Run:

```bash
npm run build && npx vitest run tests/mcp-server.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/index.ts tests/mcp-server.test.js
git commit -m "feat: add guard-after CLI outcome recording"
```

---

### Task 7: Update Documentation And Product Story

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCTION_BACKLOG.md`
- Test: command-only docs verification

- [ ] **Step 1: Update README command list**

In `README.md`, change the CLI surface row to include `guard`:

```md
| CLI | `doctor`, `demo`, `guard`, `guard-after`, `install`, `mcp-config`, `status`, `dream`, `reembed`, `observe-tool`, `promote`, `impact` |
```

- [ ] **Step 2: Update REST sidecar table**

In the REST table in `README.md`, add:

```md
| Guard an action before tool use | `POST /v1/guard/before` |
| Record the outcome after tool use | `POST /v1/guard/after` |
```

- [ ] **Step 3: Add headline guard demo**

Add a short section after "Core sidecar tools":

````md
## Audrey Guard

Audrey Guard is the memory-before-action loop. It asks Audrey what matters before a tool runs, returns a receipt-backed `go`, `caution`, or `block` decision, and records the outcome afterward so memory quality improves over time.

```bash
npx audrey guard --tool "npm test" --strict "run npm test before release"
npx audrey guard --json --tool "npm test" --strict "run npm test before release"
```

Agents and hooks should pair `guard` with `guard-after`:

```bash
npx audrey guard-after --receipt <receipt_id> --outcome failed --error-summary "Vitest failed with spawn EPERM"
```
````

- [ ] **Step 4: Update production backlog**

In `docs/PRODUCTION_BACKLOG.md`, add this bullet at the top of "v0.23 Product Direction":

```md
- Audrey Guard controller: `beforeAction()` / `afterAction()` plus REST, MCP, and CLI surfaces. The first v0.23 slice uses `memory_events` metadata as receipts and avoids a schema migration.
```

- [ ] **Step 5: Verify docs snippets reference real commands**

Run:

```bash
rg -n "guard|guard-after|/v1/guard" README.md docs/PRODUCTION_BACKLOG.md
node dist/mcp-server/index.js --help
```

Expected: README/backlog references are visible, and help includes `guard` and `guard-after`.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/PRODUCTION_BACKLOG.md
git commit -m "docs: document Audrey Guard controller loop"
```

---

### Task 8: Final Verification And Release Gate Slice

**Files:**
- No production file changes expected.

- [ ] **Step 1: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run focused tests**

Run:

```bash
npx vitest run tests/controller.test.js tests/preflight.test.js tests/reflexes.test.js tests/http-api.test.js tests/mcp-server.test.js
```

Expected: all selected tests pass.

- [ ] **Step 3: Run release-gate-compatible build checks**

Run:

```bash
npm run build
npm run bench:perf
npm run bench:memory:check
npm run pack:check
```

Expected: exit 0 for each command.

- [ ] **Step 4: Run CLI smoke with an isolated mock store**

Run:

```bash
rm -rf .audrey-guard-smoke
AUDREY_DATA_DIR=.audrey-guard-smoke AUDREY_EMBEDDING_PROVIDER=mock node dist/mcp-server/index.js guard --json --tool "npm test" --strict "run npm test before release"
```

Expected: JSON with `receipt_id`, `decision`, `ok_to_proceed`, and `evidence_ids`.

- [ ] **Step 5: Record post-action smoke**

Use the `receipt_id` from Step 4:

```bash
AUDREY_DATA_DIR=.audrey-guard-smoke AUDREY_EMBEDDING_PROVIDER=mock node dist/mcp-server/index.js guard-after --receipt <receipt_id> --tool "npm test" --outcome failed --error-summary "smoke failure"
```

Expected: JSON with `post_event_id`, `receipt_id`, `outcome: "failed"`, and `learning_summary`.

- [ ] **Step 6: Inspect git status**

Run:

```bash
git status --short --branch
```

Expected: clean working tree and branch ahead by the new implementation commits.

- [ ] **Step 7: Final commit if any verification docs changed**

If verification reveals only transient smoke data, remove it:

```bash
rm -rf .audrey-guard-smoke
git status --short
```

If no tracked files changed, do not create a commit.

---

## Self-Review

Spec coverage:
- Controller core: Tasks 1-2.
- REST routes: Task 3.
- MCP tools: Task 4.
- CLI commands: Tasks 5-6.
- Docs and product story: Task 7.
- Verification: Task 8.

No schema migration is planned. Existing routes/tools remain in place. Tests are written before production changes in every implementation task.

## Execution Recommendation

Use Subagent-Driven Development, but do not start implementation directly on `master`. Create a worktree or feature branch first, then assign one task at a time to a fresh worker with spec and quality review between tasks.
