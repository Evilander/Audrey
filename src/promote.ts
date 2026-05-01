/**
 * Memory-to-Behavior promotion — candidate scoring.
 *
 * A "candidate" is a memory (usually procedural, sometimes high-confidence
 * semantic) that has earned the right to become an enforced project rule:
 *   - repeated occurrence (multiple supporting episodes)
 *   - low contradiction (active state, not disputed)
 *   - durable (not recently superseded)
 *   - not already promoted to this target
 *
 * Tool-failure context also boosts candidates: if the Bash tool has failed
 * 3 times this week with errors mentioning "sqlite extension", a procedural
 * memory about "initialize sqlite extension before tests" gets a
 * failure_prevented score, which bubbles it up in the ranked list.
 */

import type Database from 'better-sqlite3';
import { recentFailures, type FailurePattern } from './events.js';

export type PromotionTarget = 'claude-rules' | 'agents-md' | 'playbook' | 'hook' | 'checklist';

export interface PromotionCandidate {
  candidate_id: string;
  memory_id: string;
  memory_type: 'semantic' | 'procedural';
  content: string;
  scope?: string;
  confidence: number;
  evidence_count: number;
  usage_count: number;
  failure_prevented: number;
  tags: string[];
  score: number;
  reason: string;
}

export interface FindCandidatesOptions {
  minConfidence?: number;
  minEvidence?: number;
  limit?: number;
  target?: PromotionTarget;
  since?: string;
}

interface SemanticRow {
  id: string;
  content: string;
  state: string;
  evidence_count: number;
  supporting_count: number;
  contradicting_count: number;
  retrieval_count: number;
  usage_count: number | null;
  salience: number;
  created_at: string;
  last_reinforced_at: string | null;
}

interface ProceduralRow {
  id: string;
  content: string;
  state: string;
  success_count: number;
  failure_count: number;
  retrieval_count: number;
  usage_count: number | null;
  salience: number;
  created_at: string;
  last_reinforced_at: string | null;
  trigger_conditions: string | null;
}

interface EventRow {
  metadata: string | null;
}

function loadPromotedMemoryIds(db: Database.Database, target: PromotionTarget): Set<string> {
  const rows = db.prepare(
    `SELECT metadata FROM memory_events
     WHERE event_type = 'Promotion' AND tool_name = ?`,
  ).all(target) as EventRow[];

  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.metadata) continue;
    try {
      const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
      const memoryIds = parsed.memory_ids;
      if (Array.isArray(memoryIds)) {
        for (const id of memoryIds) ids.add(String(id));
      }
    } catch {
      // skip malformed metadata
    }
  }
  return ids;
}

function matchesFailure(memoryContent: string, failure: FailurePattern): number {
  if (!failure.last_error_summary) return 0;
  const lower = memoryContent.toLowerCase();
  const errLower = failure.last_error_summary.toLowerCase();
  const toolLower = (failure.tool_name || '').toLowerCase();

  const errWords = errLower.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  const memWords = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));

  let overlap = 0;
  for (const w of errWords) {
    if (memWords.has(w)) overlap++;
  }
  const toolBonus = toolLower && lower.includes(toolLower) ? 1 : 0;
  return overlap + toolBonus;
}

function scoreCandidate(params: {
  confidence: number;
  evidence: number;
  retrieval: number;
  usage: number;
  failurePrevented: number;
  ageHours: number;
}): number {
  const confidenceScore = params.confidence * 40;
  const evidenceScore = Math.min(params.evidence, 10) * 3;
  const retrievalScore = Math.min(params.retrieval, 20) * 1.5;
  const usageScore = Math.min(params.usage, 10) * 2;
  const failureScore = Math.min(params.failurePrevented, 5) * 8;
  // Slight penalty for very young memories so one flaky session can't promote itself.
  const agePenalty = params.ageHours < 6 ? 10 : 0;
  return confidenceScore + evidenceScore + retrievalScore + usageScore + failureScore - agePenalty;
}

function hoursSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (60 * 60 * 1000);
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return String(raw).split(',').map(t => t.trim()).filter(Boolean);
}

export function findPromotionCandidates(
  db: Database.Database,
  options: FindCandidatesOptions = {},
): PromotionCandidate[] {
  const minConfidence = options.minConfidence ?? 0.7;
  const minEvidence = options.minEvidence ?? 2;
  const limit = options.limit ?? 20;
  const target: PromotionTarget = options.target ?? 'claude-rules';
  const alreadyPromoted = loadPromotedMemoryIds(db, target);

  const failures = recentFailures(db, {
    since: options.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    limit: 20,
  });

  const candidates: PromotionCandidate[] = [];

  // Procedural memories: primary promotion stream
  const procedurals = db.prepare(
    `SELECT id, content, state, success_count, failure_count, retrieval_count,
            usage_count, salience, created_at, last_reinforced_at, trigger_conditions
     FROM procedures
     WHERE state = 'active'`,
  ).all() as ProceduralRow[];

  for (const row of procedurals) {
    if (alreadyPromoted.has(row.id)) continue;

    const successes = row.success_count ?? 0;
    const failures_count = row.failure_count ?? 0;
    const evidenceTotal = successes + failures_count;
    if (evidenceTotal < minEvidence) continue;

    const confidence = evidenceTotal === 0 ? 0 : successes / evidenceTotal;
    if (confidence < minConfidence) continue;

    const tags = parseTags(row.trigger_conditions);

    let failurePrevented = 0;
    for (const f of failures) {
      if (matchesFailure(row.content, f) >= 2) failurePrevented += 1;
    }

    const score = scoreCandidate({
      confidence,
      evidence: evidenceTotal,
      retrieval: row.retrieval_count ?? 0,
      usage: row.usage_count ?? 0,
      failurePrevented,
      ageHours: hoursSince(row.last_reinforced_at ?? row.created_at),
    });

    const reasonParts: string[] = [
      `procedural memory with ${successes}/${evidenceTotal} successful applications`,
    ];
    if (failurePrevented > 0) reasonParts.push(`would have prevented ${failurePrevented} recent tool failure${failurePrevented === 1 ? '' : 's'}`);
    if ((row.usage_count ?? 0) > 0) reasonParts.push(`used ${row.usage_count} time${row.usage_count === 1 ? '' : 's'}`);

    candidates.push({
      candidate_id: `proc:${row.id}`,
      memory_id: row.id,
      memory_type: 'procedural',
      content: row.content,
      confidence,
      evidence_count: evidenceTotal,
      usage_count: row.usage_count ?? 0,
      failure_prevented: failurePrevented,
      tags,
      score,
      reason: reasonParts.join('; '),
    });
  }

  // Semantic memories: only high-confidence, high-evidence, heavily reinforced ones.
  // The bar is higher because semantic memories are "facts," not "procedures" — we
  // do not want to promote every shared fact as a rule.
  const semantics = db.prepare(
    `SELECT id, content, state, evidence_count, supporting_count, contradicting_count,
            retrieval_count, usage_count, salience, created_at, last_reinforced_at
     FROM semantics
     WHERE state = 'active'`,
  ).all() as SemanticRow[];

  for (const row of semantics) {
    if (alreadyPromoted.has(row.id)) continue;
    const evidence = row.evidence_count ?? 0;
    if (evidence < Math.max(minEvidence, 3)) continue;
    if ((row.contradicting_count ?? 0) > 0) continue;

    const supporting = row.supporting_count ?? evidence;
    const confidence = supporting === 0 ? 0 : Math.min(1, supporting / Math.max(evidence, 1));
    if (confidence < Math.max(minConfidence, 0.8)) continue;

    let failurePrevented = 0;
    for (const f of failures) {
      if (matchesFailure(row.content, f) >= 2) failurePrevented += 1;
    }

    const score = scoreCandidate({
      confidence,
      evidence,
      retrieval: row.retrieval_count ?? 0,
      usage: row.usage_count ?? 0,
      failurePrevented,
      ageHours: hoursSince(row.last_reinforced_at ?? row.created_at),
    });

    const reasonParts: string[] = [
      `semantic principle with ${supporting}/${evidence} supporting episodes`,
    ];
    if (failurePrevented > 0) reasonParts.push(`matches ${failurePrevented} recent tool failure${failurePrevented === 1 ? '' : 's'}`);

    candidates.push({
      candidate_id: `sem:${row.id}`,
      memory_id: row.id,
      memory_type: 'semantic',
      content: row.content,
      confidence,
      evidence_count: evidence,
      usage_count: row.usage_count ?? 0,
      failure_prevented: failurePrevented,
      tags: [],
      score,
      reason: reasonParts.join('; '),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
