import type { Audrey } from './audrey.js';
import { guardActionKey } from './action-key.js';
import type { MemoryCapsule } from './capsule.js';
import type { EventOutcome, MemoryEvent } from './events.js';
import type { MemoryValidateOutcome, MemoryValidateResult } from './feedback.js';
import { buildPreflight, type MemoryPreflight, type PreflightOptions } from './preflight.js';
import { buildReflexReportFromPreflight, type MemoryReflex } from './reflexes.js';
import { redact, truncateRedactedText, type RedactionHit } from './redact.js';

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

export interface AgentAction {
  tool?: string;
  command?: string;
  action: string;
  cwd?: string;
  files?: string[];
  sessionId?: string;
  /**
   * If true, an exact-repeated-failure block degrades to `warn` rather than `block`.
   * Evidence and risk score remain attached. Use when the caller has explicitly
   * acknowledged the prior failure (e.g. the human said "retry exactly this") so a
   * deliberate retry is not silently blocked. Does not bypass other guard reasons.
   */
  acknowledgePriorFailure?: boolean;
}

export interface MemoryControllerOptions {
  /**
   * Window in days after which a same-action prior failure no longer triggers an
   * automatic block. Defaults to 7. Set to 0 to disable time-based decay (legacy
   * pre-1.0.1 hard-block-forever behavior).
   */
  failureDecayDays?: number;
}

const DEFAULT_FAILURE_DECAY_DAYS = 7;

export type ControllerGuardDecision = 'allow' | 'warn' | 'block';

export interface ControllerGuardResult {
  decision: ControllerGuardDecision;
  riskScore: number;
  summary: string;
  evidenceIds: string[];
  recommendedActions: string[];
  capsule?: MemoryCapsule;
  reflexes: MemoryReflex[];
  preflightEventId?: string;
}

export interface ToolOutcome {
  action: AgentAction;
  outcome: EventOutcome;
  output?: unknown;
  errorSummary?: string;
  retainDetails?: boolean;
  metadata?: Record<string, unknown>;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getPreToolUseReceipt(audrey: Audrey, receiptId: string): MemoryEvent | null {
  const receipt = audrey.db.prepare(`
    SELECT * FROM memory_events
    WHERE id = ? AND event_type = 'PreToolUse'
  `).get(receiptId) as MemoryEvent | undefined;
  return receipt ?? null;
}

function evidenceIdsFromMetadata(metadata: Record<string, unknown>): Set<string> {
  const raw = metadata.evidence_ids;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((id): id is string => typeof id === 'string'));
}

function isGuardBeforeReceipt(metadata: Record<string, unknown>): boolean {
  return metadata.guard === true && metadata.guard_phase === 'before';
}

function isMemoryValidateOutcome(value: unknown): value is MemoryValidateOutcome {
  return value === 'used' || value === 'helpful' || value === 'wrong';
}

function evidenceFeedbackEntries(
  feedback: GuardAfterInput['evidenceFeedback'],
): Array<[string, MemoryValidateOutcome]> {
  const entries = Object.entries((feedback ?? {}) as Record<string, unknown>);
  for (const [id, outcome] of entries) {
    if (!isMemoryValidateOutcome(outcome)) {
      throw new Error(`invalid evidence feedback outcome for ${id}: expected used, helpful, or wrong`);
    }
  }
  return entries as Array<[string, MemoryValidateOutcome]>;
}

function getGuardOutcomeEvent(audrey: Audrey, receiptId: string): MemoryEvent | null {
  const event = audrey.db.prepare(`
    SELECT * FROM memory_events
    WHERE event_type IN ('PostToolUse', 'PostToolUseFailure')
      AND metadata IS NOT NULL
      AND json_valid(metadata)
      AND json_extract(metadata, '$.receipt_id') = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(receiptId) as MemoryEvent | undefined;
  return event ?? null;
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

function displayDecision(decision: MemoryPreflight['decision']): ControllerGuardDecision {
  if (decision === 'block') return 'block';
  if (decision === 'caution') return 'warn';
  return 'allow';
}

function compact(
  value: string | undefined,
  max = 2000,
  redactions: RedactionHit[] = [],
): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return truncateRedactedText(text, max, redactions);
}

function redactedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const result = redact(value);
  return compact(result.text, 2000, result.redactions);
}

function contextFor(action: AgentAction): Record<string, string> {
  const context: Record<string, string> = {};
  if (action.cwd) context.cwd = action.cwd;
  if (action.sessionId) context.sessionId = action.sessionId;
  if (action.tool) context.tool = action.tool;
  if (action.command) context.command = redactedText(action.command) ?? action.command;
  if (action.files?.length) context.files = action.files.join('\n');
  return context;
}

function sameActionEvents(audrey: Audrey, action: AgentAction): MemoryEvent[] {
  if (!action.tool) return [];
  const key = guardActionKey(action);
  const tool = action.tool.toLowerCase();
  return audrey.listEvents({ limit: 1000 })
    .filter(event => {
      if (event.tool_name?.toLowerCase() !== tool) return false;
      if (event.actor_agent && event.actor_agent !== audrey.agent) return false;
      if (!event.metadata) return false;
      try {
        const metadata = JSON.parse(event.metadata) as Record<string, unknown>;
        return metadata.audrey_guard_action_key === key;
      } catch {
        return false;
      }
    });
}

function latestSucceededEvent(events: MemoryEvent[]): MemoryEvent | undefined {
  return events
    .filter(event => event.outcome === 'succeeded')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
}

function matchingFailureEvents(
  audrey: Audrey,
  action: AgentAction,
  failureDecayDays: number,
): MemoryEvent[] {
  const events = sameActionEvents(audrey, action);
  const latestSuccessAt = latestSucceededEvent(events)?.created_at;
  const cutoffMs = failureDecayDays > 0
    ? Date.now() - failureDecayDays * 24 * 60 * 60 * 1000
    : -Infinity;
  return events
    .filter(event => event.outcome === 'failed')
    .filter(event => !latestSuccessAt || event.created_at > latestSuccessAt)
    .filter(event => Date.parse(event.created_at) >= cutoffMs);
}

function recoveredFailureEvent(audrey: Audrey, action: AgentAction): MemoryEvent | undefined {
  const events = sameActionEvents(audrey, action);
  const latestSuccess = latestSucceededEvent(events);
  if (!latestSuccess) return undefined;
  const priorFailure = events
    .filter(event => event.outcome === 'failed' && event.created_at < latestSuccess.created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return priorFailure ? latestSuccess : undefined;
}

export class MemoryController {
  private readonly failureDecayDays: number;

  constructor(
    private readonly audrey: Audrey,
    options: MemoryControllerOptions = {},
  ) {
    this.failureDecayDays = options.failureDecayDays ?? DEFAULT_FAILURE_DECAY_DAYS;
  }

  async beforeAction(action: AgentAction): Promise<ControllerGuardResult> {
    const result = await beforeAction(this.audrey, action.action, {
      tool: action.tool,
      cwd: action.cwd,
      files: action.files,
      sessionId: action.sessionId,
      strict: true,
      includeCapsule: true,
      includeStatus: true,
      recordEvent: true,
      scope: 'agent',
    });
    const exactFailures = matchingFailureEvents(this.audrey, action, this.failureDecayDays);
    const recoveredFailure = recoveredFailureEvent(this.audrey, action);
    const exactFailureEvidence = exactFailures.map(event => event.id);
    const hasExactFailure = exactFailures.length > 0;
    const acknowledgedPriorFailure = hasExactFailure && action.acknowledgePriorFailure === true;
    const exactRepeatedFailure = hasExactFailure && !acknowledgedPriorFailure;
    const recoveredExactFailure = !hasExactFailure && recoveredFailure && result.decision !== 'block';
    const recommendedActions = [...result.recommended_actions];
    if (exactRepeatedFailure) {
      recommendedActions.unshift('Do not repeat the exact failed action until the prior error is understood or the command is changed.');
    } else if (acknowledgedPriorFailure) {
      recommendedActions.unshift('Prior failure acknowledged; proceeding with extra caution. Surface the prior error in your action notes.');
    } else if (recoveredExactFailure) {
      recommendedActions.unshift('This exact action has succeeded since its last failure; proceed with normal validation.');
    }

    let decision: ControllerGuardDecision;
    if (exactRepeatedFailure) decision = 'block';
    else if (acknowledgedPriorFailure) decision = displayDecision(result.decision) === 'block' ? 'block' : 'warn';
    else if (recoveredExactFailure) decision = 'allow';
    else decision = displayDecision(result.decision);

    let riskScore: number;
    if (exactRepeatedFailure) riskScore = Math.max(result.risk_score, 0.9);
    else if (acknowledgedPriorFailure) riskScore = Math.max(result.risk_score, 0.6);
    else if (recoveredExactFailure) riskScore = Math.min(result.risk_score, 0.2);
    else riskScore = result.risk_score;

    let summary: string;
    if (exactRepeatedFailure) {
      summary = `Blocked: this exact ${action.tool ?? 'tool'} action failed before. ${result.summary}`;
    } else if (acknowledgedPriorFailure) {
      summary = `Warn: prior failure acknowledged for this exact ${action.tool ?? 'tool'} action; proceed with caution. ${result.summary}`;
    } else if (recoveredExactFailure) {
      summary = `Allowed: this exact ${action.tool ?? 'tool'} action has succeeded since the prior failure. ${result.summary}`;
    } else {
      summary = result.summary;
    }

    return {
      decision,
      riskScore,
      summary,
      evidenceIds: [...new Set([...exactFailureEvidence, ...(recoveredFailure ? [recoveredFailure.id] : []), ...result.evidence_ids])],
      recommendedActions: [...new Set(recommendedActions)],
      capsule: result.capsule,
      reflexes: result.reflexes,
      preflightEventId: result.preflight_event_id,
    };
  }

  async afterAction(outcome: ToolOutcome): Promise<void> {
    const tool = outcome.action.tool ?? 'unknown';
    const event = outcome.outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse';
    const safeAction = redactedText(outcome.action.action) ?? outcome.action.action;
    const safeCommand = redactedText(outcome.action.command);
    const safeError = redactedText(outcome.errorSummary);

    this.audrey.observeTool({
      event,
      tool,
      sessionId: outcome.action.sessionId,
      input: {
        action: outcome.action.action,
        command: outcome.action.command,
      },
      output: outcome.output,
      outcome: outcome.outcome,
      errorSummary: outcome.errorSummary,
      cwd: outcome.action.cwd,
      files: outcome.action.files,
      retainDetails: outcome.retainDetails,
      metadata: {
        ...(outcome.metadata ?? {}),
        audrey_guard_action_key: guardActionKey(outcome.action),
      },
    });

    if (outcome.outcome !== 'failed' || !safeError) return;

    await this.audrey.encode({
      content: [
        `Tool failure: ${tool} failed while attempting: ${safeAction}.`,
        safeCommand ? `Command: ${safeCommand}.` : '',
        `Error: ${safeError}`,
      ].filter(Boolean).join(' '),
      source: 'tool-result',
      tags: ['tool-failure', tool],
      salience: 0.85,
      context: contextFor(outcome.action),
    });
  }
}

export async function beforeAction(
  audrey: Audrey,
  action: string,
  options: GuardBeforeOptions = {},
): Promise<GuardDecision> {
  const tool = options.tool ?? 'guard';
  const preflight = await buildPreflight(audrey, action, {
    ...options,
    tool,
    recordEvent: true,
  });
  const reflexReport = buildReflexReportFromPreflight(preflight);
  const receiptId = preflight.preflight_event_id;
  if (!receiptId) {
    throw new Error('guard beforeAction could not record a receipt event');
  }

  const receipt = getPreToolUseReceipt(audrey, receiptId);
  if (!receipt) {
    throw new Error(`guard receipt not found: ${receiptId}`);
  }
  const metadata = parseMetadata(receipt.metadata);
  audrey.db.prepare('UPDATE memory_events SET metadata = ? WHERE id = ?').run(JSON.stringify({
    ...metadata,
    guard: true,
    guard_phase: 'before',
    evidence_ids: preflight.evidence_ids,
    reflex_ids: reflexReport.reflexes.map(reflex => reflex.id),
  }), receiptId);

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

export function afterAction(audrey: Audrey, input: GuardAfterInput): GuardOutcome {
  if (!input.receiptId || input.receiptId.trim().length === 0) {
    throw new Error('receiptId is required');
  }

  const receipt = getPreToolUseReceipt(audrey, input.receiptId);
  if (!receipt) {
    throw new Error(`guard receipt not found: ${input.receiptId}`);
  }

  const outcome = input.outcome ?? 'unknown';
  const receiptMetadata = parseMetadata(receipt.metadata);
  if (!isGuardBeforeReceipt(receiptMetadata)) {
    throw new Error(`not a guard receipt: ${input.receiptId}`);
  }
  if (getGuardOutcomeEvent(audrey, input.receiptId)) {
    throw new Error(`guard receipt already has an outcome: ${input.receiptId}`);
  }
  const feedbackEntries = evidenceFeedbackEntries(input.evidenceFeedback);
  const receiptEvidenceIds = evidenceIdsFromMetadata(receiptMetadata);
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
  for (const [id, feedbackOutcome] of feedbackEntries) {
    if (!receiptEvidenceIds.has(id)) {
      validated.push({
        id,
        outcome: feedbackOutcome,
        validated: false,
        reason: 'Evidence id was not part of the guard receipt evidence.',
      });
      continue;
    }

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
