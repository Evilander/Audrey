import { createHash } from 'node:crypto';
import type { Audrey } from './audrey.js';
import {
  buildPreflight,
  type MemoryPreflight,
  type PreflightDecision,
  type PreflightOptions,
  type PreflightSeverity,
  type PreflightWarning,
  type PreflightWarningType,
} from './preflight.js';

export type ReflexResponseType = 'guide' | 'warn' | 'block';

export interface MemoryReflex {
  id: string;
  trigger: string;
  response_type: ReflexResponseType;
  severity: PreflightSeverity;
  source: PreflightWarningType;
  response: string;
  reason: string;
  evidence_id?: string;
  action: string;
  tool?: string;
  cwd?: string;
}

export interface ReflexOptions extends PreflightOptions {
  includePreflight?: boolean;
}

export interface MemoryReflexReport {
  action: string;
  query: string;
  tool?: string;
  cwd?: string;
  generated_at: string;
  decision: PreflightDecision;
  risk_score: number;
  summary: string;
  reflexes: MemoryReflex[];
  evidence_ids: string[];
  recommended_actions: string[];
  preflight?: MemoryPreflight;
}

function reflexId(warning: PreflightWarning, action: string, tool?: string): string {
  const input = [
    warning.type,
    warning.evidence_id ?? '',
    warning.message,
    action,
    tool ?? '',
  ].join('\n');
  return `reflex_${createHash('sha256').update(input).digest('hex').slice(0, 12)}`;
}

function responseType(warning: PreflightWarning, decision: PreflightDecision): ReflexResponseType {
  if (decision === 'block' && warning.severity === 'high') return 'block';
  if (warning.type === 'procedure' && warning.severity === 'info') return 'guide';
  return 'warn';
}

function triggerFor(warning: PreflightWarning, action: string, tool?: string): string {
  if (warning.type === 'recent_failure' && tool) {
    return `Before using ${tool}`;
  }
  if (warning.type === 'memory_health') {
    return 'Before relying on Audrey recall';
  }
  if (tool) {
    return `Before ${tool}: ${action}`;
  }
  return `Before: ${action}`;
}

function responseFor(warning: PreflightWarning): string {
  if (warning.recommended_action && (warning.type === 'must_follow' || warning.type === 'risk')) {
    return `${warning.recommended_action} ${warning.message}`;
  }
  return warning.recommended_action ?? warning.message;
}

function summarizeReflexes(decision: PreflightDecision, reflexes: MemoryReflex[]): string {
  if (reflexes.length === 0) {
    return 'No active memory reflexes matched this action.';
  }

  const blocks = reflexes.filter(r => r.response_type === 'block').length;
  const warnings = reflexes.filter(r => r.response_type === 'warn').length;
  const guides = reflexes.filter(r => r.response_type === 'guide').length;
  const parts = [`${reflexes.length} memory reflex${reflexes.length === 1 ? '' : 'es'}`];
  if (blocks > 0) parts.push(`${blocks} blocking`);
  if (warnings > 0) parts.push(`${warnings} warning`);
  if (guides > 0) parts.push(`${guides} guidance`);
  return `${decision === 'block' ? 'Stop' : decision === 'caution' ? 'Slow down' : 'Proceed'}: ${parts.join(', ')} matched.`;
}

export async function buildReflexReport(
  audrey: Audrey,
  action: string,
  options: ReflexOptions = {},
): Promise<MemoryReflexReport> {
  const preflight = await buildPreflight(audrey, action, {
    ...options,
    includeCapsule: options.includeCapsule ?? false,
  });

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
