import type { Audrey } from './audrey.js';
import type { EventOutcome, MemoryEvent } from './events.js';
import type { MemoryValidateOutcome, MemoryValidateResult } from './feedback.js';
import { buildPreflight, type MemoryPreflight, type PreflightOptions } from './preflight.js';
import { buildReflexReportFromPreflight, type MemoryReflex } from './reflexes.js';

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
  for (const [id, feedbackOutcome] of Object.entries(input.evidenceFeedback ?? {})) {
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
