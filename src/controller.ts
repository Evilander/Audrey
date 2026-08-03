import type { Audrey } from './audrey.js';
import { guardActionKey } from './action-key.js';
import type { MemoryCapsule } from './capsule.js';
import { exactActionHistory, type EventOutcome, type MemoryEvent } from './events.js';
import type { MemoryValidateOutcome, MemoryValidateResult } from './feedback.js';
import { buildPreflight, type MemoryPreflight, type PreflightOptions } from './preflight.js';
import { buildReflexReportFromPreflight, type MemoryReflex } from './reflexes.js';
import { redact, truncateRedactedText, type RedactionHit } from './redact.js';
import { requireAgent } from './utils.js';

export interface GuardBeforeOptions extends PreflightOptions {
  recordEvent?: boolean;
  acknowledgePriorFailure?: boolean;
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
  actorAgent?: string;
  evidenceFeedback?: Record<string, MemoryValidateOutcome>;
  /**
   * Required to record a `succeeded` outcome against a receipt whose
   * beforeAction decision was `block`, when that block was not caused by an
   * exact-repeat failure (a persistent policy or must-follow memory keeps
   * blocking every fresh beforeAction check otherwise, with no way to ever
   * record the outcome). Never inferred — a caller must state why the
   * advisory block is being overridden, and the reason is written into the
   * outcome event as durable, auditable evidence. Does not apply to an
   * exact-repeat-failure block: that can only be cleared by re-running
   * beforeAction with acknowledgePriorFailure.
   */
  overrideReason?: string;
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
  actionDigest?: string;
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
  warnings: MemoryPreflight['warnings'];
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
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getPreToolUseReceipt(
  audrey: Audrey,
  receiptId: string,
  actorAgent: string,
): MemoryEvent | null {
  const receipt = audrey.db
    .prepare(
      `
    SELECT * FROM memory_events
    WHERE id = ? AND event_type = 'PreToolUse' AND actor_agent = ?
  `,
    )
    .get(receiptId, actorAgent) as MemoryEvent | undefined;
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
      throw new Error(
        `invalid evidence feedback outcome for ${id}: expected used, helpful, or wrong`,
      );
    }
  }
  return entries as Array<[string, MemoryValidateOutcome]>;
}

function getGuardOutcomeEvent(
  audrey: Audrey,
  receiptId: string,
  actorAgent: string,
): MemoryEvent | null {
  const event = audrey.db
    .prepare(
      `
    SELECT * FROM memory_events
    WHERE event_type IN ('PostToolUse', 'PostToolUseFailure')
      AND receipt_id = ?
      AND actor_agent = ?
    ORDER BY created_at DESC
    LIMIT 1
  `,
    )
    .get(receiptId, actorAgent) as MemoryEvent | undefined;
  return event ?? null;
}

function postEventTypeFor(outcome: EventOutcome): 'PostToolUse' | 'PostToolUseFailure' {
  return outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse';
}

function summarizeLearning(validated: GuardValidatedEvidence[]): string {
  const applied = validated.filter(v => v.validated).length;
  const skipped = validated.length - applied;
  if (validated.length === 0) return 'Recorded action outcome; no evidence feedback supplied.';
  return (
    `Recorded action outcome; validated ${applied} evidence item${applied === 1 ? '' : 's'}` +
    (skipped > 0
      ? ` and skipped ${skipped} non-memory evidence item${skipped === 1 ? '' : 's'}.`
      : '.')
  );
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

function failureMemoryContent(
  action: AgentAction,
  tool: string,
  errorSummary: string | null | undefined,
): string | undefined {
  const safeError = redactedText(errorSummary ?? undefined);
  if (!safeError) return undefined;
  const safeAction = redactedText(action.action) ?? action.action;
  const safeCommand = redactedText(action.command);
  return [
    `Tool failure: ${tool} failed while attempting: ${safeAction}.`,
    safeCommand ? `Command: ${safeCommand}.` : '',
    `Error: ${safeError}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function eventOrder(a: MemoryEvent, b: MemoryEvent): number {
  // ULID ids are monotonic within a process, breaking same-millisecond ties.
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

function latestSucceededEvent(events: MemoryEvent[]): MemoryEvent | undefined {
  return events
    .filter(event => event.outcome === 'succeeded')
    .sort(eventOrder)
    .at(-1);
}

function exactActionState(
  audrey: Audrey,
  action: AgentAction,
  failureDecayDays: number,
  actorAgent: string,
): {
  failures: MemoryEvent[];
  recoveredBy?: MemoryEvent;
  recoveredFailures?: MemoryEvent[];
  recoveredFailureMemoryIds?: string[];
} {
  if (!action.tool) return { failures: [] };
  const since =
    failureDecayDays > 0
      ? new Date(Date.now() - failureDecayDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
  const events = exactActionHistory(audrey.db, {
    actionKey: guardActionKey(action),
    actorAgent,
    ...(since ? { since } : {}),
  });
  const latestSuccess = latestSucceededEvent(events);
  const failures = events
    .filter(event => event.outcome === 'failed')
    .filter(event => !latestSuccess || eventOrder(event, latestSuccess) > 0);
  if (failures.length > 0 || !latestSuccess) return { failures };
  const recoveredFailures = events.filter(
    event => event.outcome === 'failed' && eventOrder(event, latestSuccess) < 0,
  );
  const recoveredFailureMemoryIds = recoveredFailures.flatMap(event => {
    const linkedId = parseMetadata(event.metadata).failure_memory_id;
    if (typeof linkedId === 'string' && linkedId.length > 0) return [linkedId];

    const content = failureMemoryContent(action, action.tool ?? 'unknown', event.error_summary);
    if (!content) return [];
    const legacy = audrey.db
      .prepare(
        `SELECT id FROM episodes
         WHERE agent = ? AND source = 'tool-result' AND content = ? AND created_at >= ?
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(actorAgent, content, event.created_at) as { id: string } | undefined;
    return legacy ? [legacy.id] : [];
  });
  return {
    failures,
    ...(recoveredFailures.length > 0
      ? { recoveredBy: latestSuccess, recoveredFailures, recoveredFailureMemoryIds }
      : {}),
  };
}

interface GuardEvaluation {
  decision: GuardDecision;
  controller: ControllerGuardResult;
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
    const evaluation = await this.evaluate(action, {
      tool: action.tool,
      actionDigest: action.actionDigest,
      cwd: action.cwd,
      files: action.files,
      sessionId: action.sessionId,
      strict: true,
      includeCapsule: true,
      includeStatus: true,
      recordEvent: true,
      scope: 'agent',
    });
    return evaluation.controller;
  }

  async beforeActionDecision(
    action: string,
    options: GuardBeforeOptions = {},
  ): Promise<GuardDecision> {
    const tool = options.tool ?? 'guard';
    const evaluation = await this.evaluate(
      {
        action,
        tool,
        actionDigest: options.actionDigest,
        cwd: options.cwd,
        files: options.files,
        sessionId: options.sessionId,
        acknowledgePriorFailure: options.acknowledgePriorFailure,
      },
      {
        ...options,
        tool,
        recordEvent: true,
      },
    );
    return evaluation.decision;
  }

  private async evaluate(
    action: AgentAction,
    options: GuardBeforeOptions,
  ): Promise<GuardEvaluation> {
    const tool = options.tool ?? action.tool ?? 'guard';
    const actorAgent = requireAgent(options.agent, this.audrey.agent);
    const preflight = await buildPreflight(this.audrey, action.action, {
      ...options,
      tool,
      recordEvent: true,
    });
    const receiptId = preflight.preflight_event_id;
    if (!receiptId) {
      throw new Error('guard beforeAction could not record a receipt event');
    }

    const receipt = getPreToolUseReceipt(this.audrey, receiptId, actorAgent);
    if (!receipt) {
      throw new Error(`guard receipt not found: ${receiptId}`);
    }

    const exactAction = {
      ...action,
      tool,
      action: preflight.action,
      actionDigest: options.actionDigest ?? action.actionDigest,
      cwd: options.cwd ?? action.cwd,
      files: options.files ?? action.files,
      sessionId: options.sessionId ?? action.sessionId,
    };
    const {
      failures: exactFailures,
      recoveredBy: recoveredFailure,
      recoveredFailures = [],
      recoveredFailureMemoryIds = [],
    } = exactActionState(this.audrey, exactAction, this.failureDecayDays, actorAgent);
    const exactFailureEvidence = exactFailures.map(event => event.id);
    const hasExactFailure = exactFailures.length > 0;
    const acknowledgedPriorFailure = hasExactFailure && action.acknowledgePriorFailure === true;
    const exactRepeatedFailure = hasExactFailure && !acknowledgedPriorFailure;
    const recoveredExactFailure =
      !hasExactFailure && recoveredFailure && preflight.decision !== 'block';
    const recoveredFailureEvidence = new Set([
      ...recoveredFailures.map(event => event.id),
      ...recoveredFailureMemoryIds,
    ]);
    const preflightWarnings = recoveredExactFailure
      ? preflight.warnings.filter(
          warning => !warning.evidence_id || !recoveredFailureEvidence.has(warning.evidence_id),
        )
      : preflight.warnings;
    const preflightHasHigh = preflightWarnings.some(warning => warning.severity === 'high');
    const preflightHasMedium = preflightWarnings.some(warning => warning.severity === 'medium');
    const preflightDecision =
      options.strict && preflightHasHigh
        ? 'block'
        : preflightHasHigh || preflightHasMedium
          ? 'caution'
          : 'go';
    const preflightRiskScore = preflightWarnings.reduce((score, warning) => {
      const severityScore = { info: 0.1, low: 0.25, medium: 0.55, high: 0.85 }[warning.severity];
      return Math.max(score, severityScore);
    }, 0);
    const recommendedActions = recoveredExactFailure
      ? [
          ...new Set(
            preflightWarnings
              .map(warning => warning.recommended_action)
              .filter((value): value is string => Boolean(value)),
          ),
        ]
      : [...preflight.recommended_actions];
    if (exactRepeatedFailure) {
      recommendedActions.unshift(
        'Do not repeat the exact failed action until the prior error is understood or the command is changed.',
      );
    } else if (acknowledgedPriorFailure) {
      recommendedActions.unshift(
        'Prior failure acknowledged; proceeding with extra caution. Surface the prior error in your action notes.',
      );
    } else if (recoveredExactFailure) {
      recommendedActions.unshift(
        'This exact action has succeeded since its last failure; proceed with normal validation.',
      );
    }

    let decision: MemoryPreflight['decision'];
    if (exactRepeatedFailure) decision = 'block';
    else if (acknowledgedPriorFailure)
      decision = preflightDecision === 'block' ? 'block' : 'caution';
    else decision = preflightDecision;

    let riskScore: number;
    if (exactRepeatedFailure) riskScore = Math.max(preflightRiskScore, 0.9);
    else if (acknowledgedPriorFailure) riskScore = Math.max(preflightRiskScore, 0.6);
    else riskScore = preflightRiskScore;

    let summary: string;
    if (exactRepeatedFailure) {
      summary = `Blocked: this exact ${tool} action failed before. ${preflight.summary}`;
    } else if (acknowledgedPriorFailure) {
      summary = `Caution: prior failure acknowledged for this exact ${tool} action; proceed with caution. ${preflight.summary}`;
    } else if (recoveredExactFailure) {
      summary =
        preflightWarnings.length > 0
          ? `Recovered: this exact ${tool} action has succeeded since the prior failure. Caution: ${preflightWarnings.length} other memory signal${preflightWarnings.length === 1 ? '' : 's'} still applies.`
          : `Recovered: this exact ${tool} action has succeeded since the prior failure.`;
    } else {
      summary = preflight.summary;
    }

    const latestExactFailure = exactFailures.at(-1);
    const warnings = [...preflightWarnings];
    if (latestExactFailure) {
      warnings.unshift({
        type: 'recent_failure',
        severity: exactRepeatedFailure ? 'high' : 'medium',
        message: latestExactFailure.error_summary
          ? `This exact ${tool} action failed before: ${latestExactFailure.error_summary}`
          : `This exact ${tool} action failed before.`,
        reason: 'Matched the indexed exact action fingerprint within the Guard failure window.',
        evidence_id: latestExactFailure.id,
        recommended_action: exactRepeatedFailure
          ? 'Do not repeat the exact failed action until the prior error is understood or the action is changed.'
          : 'Surface the acknowledged prior error and validate the retry carefully.',
      });
    }
    const evidenceIds = [
      ...new Set([
        ...exactFailureEvidence,
        ...(recoveredFailure ? [recoveredFailure.id] : []),
        ...preflight.evidence_ids,
      ]),
    ];
    const finalRecommendedActions = [...new Set(recommendedActions)];
    const verdict = decision === 'go' ? 'clear' : decision === 'block' ? 'blocked' : 'caution';
    const reflexReport = buildReflexReportFromPreflight({
      ...preflight,
      decision,
      verdict,
      ok_to_proceed: decision !== 'block',
      risk_score: riskScore,
      summary,
      warnings,
      recommended_actions: finalRecommendedActions,
      evidence_ids: evidenceIds,
    });
    const metadata = parseMetadata(receipt.metadata);
    this.audrey.db
      .prepare('UPDATE memory_events SET metadata = ? WHERE id = ? AND actor_agent = ?')
      .run(
        JSON.stringify({
          ...metadata,
          guard: true,
          guard_phase: 'before',
          evidence_ids: evidenceIds,
          reflex_ids: reflexReport.reflexes.map(reflex => reflex.id),
          preflight_decision: decision,
          preflight_warning_count: warnings.length,
          preflight_evidence_ids: evidenceIds,
          prior_failure_acknowledged: acknowledgedPriorFailure,
          exact_repeat_failure_block: exactRepeatedFailure,
        }),
        receiptId,
        actorAgent,
      );

    const guardDecision: GuardDecision = {
      receipt_id: receiptId,
      preflight_event_id: receiptId,
      action: preflight.action,
      query: preflight.query,
      ...(preflight.tool ? { tool: preflight.tool } : {}),
      ...(preflight.cwd ? { cwd: preflight.cwd } : {}),
      generated_at: preflight.generated_at,
      decision,
      verdict,
      ok_to_proceed: decision !== 'block',
      risk_score: Number(riskScore.toFixed(2)),
      summary,
      warnings,
      reflexes: reflexReport.reflexes,
      recommended_actions: finalRecommendedActions,
      evidence_ids: evidenceIds,
      recent_failures: preflight.recent_failures,
      ...(preflight.status ? { status: preflight.status } : {}),
      ...(preflight.capsule ? { capsule: preflight.capsule } : {}),
    };

    return {
      decision: guardDecision,
      controller: {
        decision: displayDecision(guardDecision.decision),
        riskScore: guardDecision.risk_score,
        summary: guardDecision.summary,
        warnings: guardDecision.warnings,
        evidenceIds: guardDecision.evidence_ids,
        recommendedActions: guardDecision.recommended_actions,
        capsule: guardDecision.capsule,
        reflexes: guardDecision.reflexes,
        preflightEventId: guardDecision.preflight_event_id,
      },
    };
  }

  async afterAction(outcome: ToolOutcome): Promise<void> {
    const tool = outcome.action.tool ?? 'unknown';
    const event = outcome.outcome === 'failed' ? 'PostToolUseFailure' : 'PostToolUse';

    const observed = this.audrey.observeTool({
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

    if (outcome.outcome !== 'failed') return;
    const content = failureMemoryContent(outcome.action, tool, outcome.errorSummary);
    if (!content) return;

    const failureMemoryId = await this.audrey.encode({
      content,
      source: 'tool-result',
      tags: ['tool-failure', tool],
      salience: 0.85,
      context: contextFor(outcome.action),
    });
    this.audrey.db.prepare('UPDATE memory_events SET metadata = ? WHERE id = ?').run(
      JSON.stringify({
        ...parseMetadata(observed.event.metadata),
        failure_memory_id: failureMemoryId,
      }),
      observed.event.id,
    );
  }
}

export async function beforeAction(
  audrey: Audrey,
  action: string,
  options: GuardBeforeOptions = {},
): Promise<GuardDecision> {
  return new MemoryController(audrey).beforeActionDecision(action, options);
}

export function afterAction(audrey: Audrey, input: GuardAfterInput): GuardOutcome {
  if (!input.receiptId || input.receiptId.trim().length === 0) {
    throw new Error('receiptId is required');
  }

  const actorAgent = requireAgent(input.actorAgent, audrey.agent);
  const receipt = getPreToolUseReceipt(audrey, input.receiptId, actorAgent);
  if (!receipt) {
    throw new Error(`guard receipt not found: ${input.receiptId}`);
  }

  const outcome = input.outcome ?? 'unknown';
  const receiptMetadata = parseMetadata(receipt.metadata);
  if (!isGuardBeforeReceipt(receiptMetadata)) {
    throw new Error(`not a guard receipt: ${input.receiptId}`);
  }
  if (getGuardOutcomeEvent(audrey, input.receiptId, actorAgent)) {
    throw new Error(`guard receipt already has an outcome: ${input.receiptId}`);
  }
  let overrideReason: string | undefined;
  if (outcome === 'succeeded' && receiptMetadata.preflight_decision === 'block') {
    if (receiptMetadata.exact_repeat_failure_block === true) {
      throw new Error(
        'Cannot record a succeeded outcome for a Guard receipt blocked by an exact repeat failure; overrideReason cannot clear this — run a new acknowledged beforeAction check (acknowledgePriorFailure: true) before retrying.',
      );
    }
    const trimmedReason = input.overrideReason?.trim();
    if (!trimmedReason) {
      throw new Error(
        'Cannot record a succeeded outcome for a blocked Guard receipt without overrideReason: this block was not caused by an exact repeat failure, so acknowledgePriorFailure cannot clear it — pass overrideReason to afterAction stating why the advisory block is being overridden.',
      );
    }
    overrideReason = trimmedReason;
  }
  const feedbackEntries = evidenceFeedbackEntries(input.evidenceFeedback);
  const receiptEvidenceIds = evidenceIdsFromMetadata(receiptMetadata);
  const result = audrey.observeTool({
    event: postEventTypeFor(outcome),
    tool: input.tool ?? receipt.tool_name ?? 'unknown',
    sessionId: input.sessionId ?? receipt.session_id ?? undefined,
    actorAgent,
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
      audrey_guard_action_key: receiptMetadata.audrey_guard_action_key,
      ...(overrideReason
        ? { guard_block_overridden: true, guard_override_reason: overrideReason }
        : {}),
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

    const feedback = audrey.validate({ id, outcome: feedbackOutcome, agent: actorAgent });
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
