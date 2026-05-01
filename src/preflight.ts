import type { Audrey } from './audrey.js';
import type { CapsuleEntry, CapsuleMode, MemoryCapsule } from './capsule.js';
import type { FailurePattern } from './events.js';
import type { MemoryStatusResult, RecallOptions } from './types.js';

export type PreflightDecision = 'go' | 'caution' | 'block';
export type PreflightSeverity = 'info' | 'low' | 'medium' | 'high';
export type PreflightWarningType =
  | 'recent_failure'
  | 'must_follow'
  | 'risk'
  | 'procedure'
  | 'contradiction'
  | 'uncertain'
  | 'memory_health';

export interface PreflightOptions {
  tool?: string;
  sessionId?: string;
  cwd?: string;
  files?: string[];
  strict?: boolean;
  limit?: number;
  budgetChars?: number;
  mode?: CapsuleMode;
  recentFailureWindowHours?: number;
  recentChangeWindowHours?: number;
  includeCapsule?: boolean;
  includeStatus?: boolean;
  recordEvent?: boolean;
  scope?: RecallOptions['scope'];
}

export interface PreflightWarning {
  type: PreflightWarningType;
  severity: PreflightSeverity;
  message: string;
  reason: string;
  evidence_id?: string;
  recommended_action?: string;
}

export interface MemoryPreflight {
  action: string;
  query: string;
  tool?: string;
  cwd?: string;
  generated_at: string;
  decision: PreflightDecision;
  verdict: 'clear' | 'caution' | 'blocked';
  ok_to_proceed: boolean;
  risk_score: number;
  summary: string;
  warnings: PreflightWarning[];
  recent_failures: FailurePattern[];
  status?: MemoryStatusResult;
  recommended_actions: string[];
  evidence_ids: string[];
  preflight_event_id?: string;
  capsule?: MemoryCapsule;
}

const SEVERITY_SCORE: Record<PreflightSeverity, number> = {
  info: 0.1,
  low: 0.25,
  medium: 0.55,
  high: 0.85,
};

function isNonEmptyText(value: string): boolean {
  return value.trim().length > 0;
}

function shorten(value: string, max = 320): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function matchesToolOrAction(
  action: string,
  requestedTool: string | undefined,
  failedTool: string | null | undefined,
): boolean {
  if (!failedTool) return false;
  const failed = failedTool.toLowerCase();
  const tool = requestedTool?.toLowerCase();
  const actionText = action.toLowerCase();

  return Boolean(
    (tool && (failed === tool || failed.includes(tool) || tool.includes(failed)))
    || actionText.includes(failed)
  );
}

function warningFromEntry(
  type: PreflightWarningType,
  severity: PreflightSeverity,
  entry: CapsuleEntry,
  fallbackAction: string,
): PreflightWarning {
  return {
    type,
    severity,
    message: shorten(entry.content),
    reason: entry.reason,
    evidence_id: entry.memory_id,
    recommended_action: entry.recommended_action ?? fallbackAction,
  };
}

function addWarning(
  warnings: PreflightWarning[],
  seen: Set<string>,
  warning: PreflightWarning,
): void {
  const key = `${warning.type}:${warning.evidence_id ?? warning.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  warnings.push(warning);
}

function recommendationFromWarning(warning: PreflightWarning): string {
  if (warning.recommended_action) return warning.recommended_action;
  switch (warning.type) {
    case 'recent_failure':
      return 'Review the prior failure before running the same tool again.';
    case 'must_follow':
      return 'Apply the must-follow memory before acting.';
    case 'risk':
      return 'Mitigate the remembered risk before proceeding.';
    case 'procedure':
      return 'Use the remembered procedure as the execution path.';
    case 'contradiction':
      return 'Resolve or scope the contradiction before relying on either claim.';
    case 'uncertain':
      return 'Treat the low-confidence memory as a check, not as settled truth.';
    case 'memory_health':
      return 'Repair memory health before relying on recall-sensitive decisions.';
  }
}

function buildSummary(decision: PreflightDecision, warnings: PreflightWarning[]): string {
  if (warnings.length === 0) {
    return 'No relevant memory risks, prior failures, or must-follow procedures were found.';
  }

  const high = warnings.filter(w => w.severity === 'high').length;
  const medium = warnings.filter(w => w.severity === 'medium').length;
  const parts = [`${warnings.length} memory signal${warnings.length === 1 ? '' : 's'}`];
  if (high > 0) parts.push(`${high} high severity`);
  if (medium > 0) parts.push(`${medium} medium severity`);
  return `${decision === 'block' ? 'Blocked' : 'Caution'}: ${parts.join(', ')} found before acting.`;
}

export async function buildPreflight(
  audrey: Audrey,
  action: string,
  options: PreflightOptions = {},
): Promise<MemoryPreflight> {
  if (!isNonEmptyText(action)) {
    throw new Error('action must be a non-empty string');
  }

  const queryParts = [
    action.trim(),
    options.tool ? `tool:${options.tool}` : '',
    options.cwd ? `cwd:${options.cwd}` : '',
  ].filter(Boolean);
  const query = queryParts.join('\n');
  const capsule = await audrey.capsule(query, {
    limit: options.limit ?? 12,
    budgetChars: options.budgetChars ?? 3000,
    mode: options.mode ?? 'conservative',
    recentChangeWindowHours: options.recentChangeWindowHours ?? 72,
    includeRisks: true,
    includeContradictions: true,
    recall: { scope: options.scope ?? 'agent' },
  });

  const warnings: PreflightWarning[] = [];
  const seen = new Set<string>();
  const includeStatus = options.includeStatus ?? true;
  const status = includeStatus ? audrey.memoryStatus() : undefined;

  if (status && !status.healthy) {
    addWarning(warnings, seen, {
      type: 'memory_health',
      severity: 'high',
      message: 'Audrey memory index is unhealthy; recall may be incomplete or stale.',
      reason: 'memoryStatus().healthy is false.',
      recommended_action: 'Run npx audrey status and npx audrey reembed before depending on memory.',
    });
  } else if (status?.reembed_recommended) {
    addWarning(warnings, seen, {
      type: 'memory_health',
      severity: 'medium',
      message: 'Audrey recommends re-embedding before recall-sensitive work.',
      reason: 'memoryStatus().reembed_recommended is true.',
      recommended_action: 'Run npx audrey reembed during a safe maintenance window.',
    });
  }

  const since = new Date(
    Date.now() - (options.recentFailureWindowHours ?? 168) * 60 * 60 * 1000,
  ).toISOString();
  const recentFailures = audrey.recentFailures({ since, limit: 20 });
  const matchingFailures: FailurePattern[] = [];
  for (const failure of recentFailures) {
    if (!matchesToolOrAction(action, options.tool, failure.tool_name)) continue;
    matchingFailures.push(failure);
    const toolLabel = failure.tool_name || options.tool || 'tool';
    addWarning(warnings, seen, {
      type: 'recent_failure',
      severity: failure.failure_count >= 3 ? 'high' : 'medium',
      message: failure.last_error_summary
        ? `${toolLabel} failed ${failure.failure_count}x recently: ${shorten(failure.last_error_summary, 220)}`
        : `${toolLabel} failed ${failure.failure_count}x recently.`,
      reason: 'Matched a recent failed tool event for this action.',
      evidence_id: `failure:${toolLabel}:${failure.last_failed_at}`,
      recommended_action: `Before re-running ${toolLabel}, check what changed since the last failure.`,
    });
  }

  for (const entry of capsule.sections.must_follow) {
    addWarning(warnings, seen, warningFromEntry(
      'must_follow',
      'high',
      entry,
      'Apply this must-follow rule before acting.',
    ));
  }

  for (const entry of capsule.sections.risks) {
    addWarning(warnings, seen, warningFromEntry(
      entry.memory_type === 'tool_failure' ? 'recent_failure' : 'risk',
      entry.memory_type === 'tool_failure' ? 'medium' : 'high',
      entry,
      'Mitigate this remembered risk before proceeding.',
    ));
  }

  for (const entry of capsule.sections.procedures) {
    addWarning(warnings, seen, warningFromEntry(
      'procedure',
      'info',
      entry,
      'Use this remembered procedure as guidance.',
    ));
  }

  for (const entry of capsule.sections.contradictions) {
    addWarning(warnings, seen, warningFromEntry(
      'contradiction',
      'high',
      entry,
      'Resolve or scope this contradiction before acting.',
    ));
  }

  for (const entry of capsule.sections.uncertain_or_disputed) {
    addWarning(warnings, seen, warningFromEntry(
      'uncertain',
      'medium',
      entry,
      'Treat this as uncertain context and verify before relying on it.',
    ));
  }

  warnings.sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity]);
  const riskScore = warnings.reduce((score, warning) => Math.max(score, SEVERITY_SCORE[warning.severity]), 0);
  const hasHigh = warnings.some(w => w.severity === 'high');
  const hasMedium = warnings.some(w => w.severity === 'medium');
  const decision: PreflightDecision = options.strict && hasHigh
    ? 'block'
    : hasHigh || hasMedium
      ? 'caution'
      : 'go';
  const verdict = decision === 'go' ? 'clear' : decision === 'block' ? 'blocked' : 'caution';

  const recommendedActions = [...new Set(warnings.map(recommendationFromWarning))];
  if (decision === 'block') {
    recommendedActions.unshift('Do not proceed until the high-severity memory warning is addressed.');
  }

  const preflightEvent = options.recordEvent && options.tool
    ? audrey.observeTool({
        event: 'PreToolUse',
        tool: options.tool,
        sessionId: options.sessionId,
        input: { action: action.trim(), tool: options.tool },
        outcome: 'unknown',
        cwd: options.cwd,
        files: options.files,
        metadata: {
          preflight_decision: decision,
          preflight_warning_count: warnings.length,
        },
      }).event
    : undefined;

  return {
    action: action.trim(),
    query,
    tool: options.tool,
    cwd: options.cwd,
    generated_at: new Date().toISOString(),
    decision,
    verdict,
    ok_to_proceed: decision !== 'block',
    risk_score: Number(riskScore.toFixed(2)),
    summary: buildSummary(decision, warnings),
    warnings,
    recent_failures: matchingFailures,
    ...(status ? { status } : {}),
    recommended_actions: recommendedActions,
    evidence_ids: [...new Set([
      ...capsule.evidence_ids,
      ...warnings.map(w => w.evidence_id).filter((id): id is string => Boolean(id)),
    ])],
    ...(preflightEvent ? { preflight_event_id: preflightEvent.id } : {}),
    ...(options.includeCapsule === false ? {} : { capsule }),
  };
}
