/**
 * Memory Capsule — structured, evidence-backed retrieval packet.
 *
 * Replaces "loose list of relevant memories" with a ranked, categorized,
 * token-budgeted, explainable packet organized into nine sections:
 *   must_follow       — rules the agent must respect this turn
 *   project_facts     — stable facts about entities/concepts in the project
 *   user_preferences  — how this user works (told-by-user or tagged preference)
 *   procedures        — procedural memories the agent should apply
 *   risks             — recent failures + memories tagged risk/warning/failure
 *   recent_changes    — memories created or reinforced in the last N hours
 *   contradictions    — open contradictions in the memory store
 *   uncertain_or_disputed — low-confidence or disputed-state memories
 *   evidence          — IDs of every memory referenced in the other sections
 *
 * Every entry carries a `reason` explaining why it was included.
 */

import type Database from 'better-sqlite3';
import type { Audrey } from './audrey.js';
import type { RecallResult, RecallOptions, MemoryType, MemoryState } from './types.js';
import { recentFailures, type FailurePattern } from './events.js';

export type CapsuleMode = 'balanced' | 'conservative' | 'aggressive';

export interface CapsuleOptions {
  limit?: number;
  budgetChars?: number;
  mode?: CapsuleMode;
  recentChangeWindowHours?: number;
  includeRisks?: boolean;
  includeContradictions?: boolean;
  recall?: RecallOptions;
}

export type CapsuleEntryType = 'episode' | 'semantic' | 'procedural' | 'tool_failure' | 'contradiction';

export interface CapsuleEntry {
  memory_id: string;
  memory_type: CapsuleEntryType;
  content: string;
  confidence: number;
  scope?: string;
  evidence?: string[];
  reason: string;
  source?: string;
  tags?: string[];
  state?: MemoryState;
  created_at?: string;
  recommended_action?: string;
}

export interface MemoryCapsule {
  query: string;
  generated_at: string;
  budget_chars: number;
  used_chars: number;
  truncated: boolean;
  policy: {
    mode: CapsuleMode;
    recent_change_window_hours: number;
  };
  sections: {
    must_follow: CapsuleEntry[];
    project_facts: CapsuleEntry[];
    user_preferences: CapsuleEntry[];
    procedures: CapsuleEntry[];
    risks: CapsuleEntry[];
    recent_changes: CapsuleEntry[];
    contradictions: CapsuleEntry[];
    uncertain_or_disputed: CapsuleEntry[];
  };
  evidence_ids: string[];
}

const MUST_FOLLOW_TAGS = new Set(['must-follow', 'must', 'required', 'never', 'always', 'policy']);
const PREFERENCE_TAGS = new Set(['preference', 'prefers', 'user-preference']);
const RISK_TAGS = new Set(['risk', 'warning', 'failure', 'failure-prevention', 'danger']);
const PROCEDURE_TAGS = new Set(['procedure', 'playbook', 'howto', 'workflow']);

const SECTION_PRIORITY: readonly (keyof MemoryCapsule['sections'])[] = [
  'must_follow',
  'risks',
  'contradictions',
  'procedures',
  'project_facts',
  'user_preferences',
  'recent_changes',
  'uncertain_or_disputed',
];

interface EpisodeTagRow {
  id: string;
  tags: string | null;
  source: string;
  created_at: string;
  private: number;
  agent?: string | null;
}

interface SemanticTagRow {
  id: string;
  state: string;
  evidence_episode_ids: string | null;
  created_at: string;
  last_reinforced_at: string | null;
}

interface ContradictionRow {
  id: string;
  claim_a_id: string;
  claim_b_id: string;
  claim_a_type: string;
  claim_b_type: string;
  state: string;
  created_at: string;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through: some rows may have been stored as comma-separated
  }
  return String(raw).split(',').map(t => t.trim()).filter(Boolean);
}

function parseEvidence(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // ignore
  }
  return [];
}

function memoryTypeOf(t: MemoryType): CapsuleEntryType {
  if (t === 'episodic') return 'episode';
  if (t === 'procedural') return 'procedural';
  return 'semantic';
}

function withinWindow(createdAt: string | undefined, windowMs: number): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= windowMs;
}

function hashMatchesAny(tags: string[], pool: Set<string>): boolean {
  for (const tag of tags) {
    if (pool.has(tag.toLowerCase())) return true;
  }
  return false;
}

function buildRecallEntry(
  result: RecallResult,
  enrichment: { tags: string[]; evidence: string[]; scope?: string },
  reason: string,
): CapsuleEntry {
  return {
    memory_id: result.id,
    memory_type: memoryTypeOf(result.type),
    content: result.content,
    confidence: result.confidence,
    scope: enrichment.scope,
    evidence: enrichment.evidence.length > 0 ? enrichment.evidence : undefined,
    reason,
    source: result.source,
    tags: enrichment.tags.length > 0 ? enrichment.tags : undefined,
    state: result.state,
    created_at: result.createdAt,
  };
}

function buildFailureEntry(f: FailurePattern, reason: string): CapsuleEntry {
  const toolLabel = f.tool_name || 'unknown tool';
  const summary = f.last_error_summary
    ? `${toolLabel} failed ${f.failure_count}x recently — last error: ${f.last_error_summary}`
    : `${toolLabel} failed ${f.failure_count}x recently`;
  return {
    memory_id: `failure:${f.tool_name}:${f.last_failed_at}`,
    memory_type: 'tool_failure',
    content: summary,
    confidence: Math.min(0.5 + (f.failure_count - 1) * 0.1, 0.95),
    reason,
    created_at: f.last_failed_at,
    recommended_action: `Before re-running ${toolLabel}, check preflight conditions from the last failure.`,
  };
}

function buildContradictionEntry(row: ContradictionRow, reason: string): CapsuleEntry {
  return {
    memory_id: row.id,
    memory_type: 'contradiction',
    content: `Contradiction between ${row.claim_a_type}:${row.claim_a_id} and ${row.claim_b_type}:${row.claim_b_id}`,
    confidence: 0.5,
    reason,
    created_at: row.created_at,
    state: 'disputed',
    evidence: [row.claim_a_id, row.claim_b_id],
    recommended_action: 'Resolve or mark context_dependent before acting on either claim.',
  };
}

function loadEpisodeEnrichment(db: Database.Database, id: string): EpisodeTagRow | undefined {
  return db.prepare(`SELECT id, tags, source, created_at, private, agent FROM episodes WHERE id = ?`).get(id) as EpisodeTagRow | undefined;
}

function loadSemanticEnrichment(db: Database.Database, id: string): SemanticTagRow | undefined {
  return db.prepare(`SELECT id, state, evidence_episode_ids, created_at, last_reinforced_at FROM semantics WHERE id = ?`).get(id) as SemanticTagRow | undefined;
}

function loadProcedureEnrichment(db: Database.Database, id: string): SemanticTagRow | undefined {
  return db.prepare(`SELECT id, state, evidence_episode_ids, created_at, last_reinforced_at FROM procedures WHERE id = ?`).get(id) as SemanticTagRow | undefined;
}

function loadOpenContradictions(db: Database.Database, limit: number): ContradictionRow[] {
  return db.prepare(
    `SELECT id, claim_a_id, claim_b_id, claim_a_type, claim_b_type, state, created_at
     FROM contradictions
     WHERE state = 'open'
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(limit) as ContradictionRow[];
}

function categorize(
  entry: CapsuleEntry,
  result: RecallResult,
  tags: string[],
  recentWindowMs: number,
): Array<keyof MemoryCapsule['sections']> {
  const sections = new Set<keyof MemoryCapsule['sections']>();
  const lowerTags = tags.map(t => t.toLowerCase());

  if (hashMatchesAny(lowerTags, MUST_FOLLOW_TAGS)) {
    sections.add('must_follow');
  }

  if (hashMatchesAny(lowerTags, RISK_TAGS)) {
    sections.add('risks');
  }

  if (entry.memory_type === 'procedural' || hashMatchesAny(lowerTags, PROCEDURE_TAGS)) {
    sections.add('procedures');
  }

  if (hashMatchesAny(lowerTags, PREFERENCE_TAGS) || result.source === 'told-by-user') {
    sections.add('user_preferences');
  }

  if (entry.state === 'disputed' || entry.state === 'context_dependent' || result.confidence < 0.55) {
    sections.add('uncertain_or_disputed');
  }

  if (withinWindow(result.createdAt, recentWindowMs)) {
    sections.add('recent_changes');
  }

  if (sections.size === 0) {
    if (entry.memory_type === 'semantic') {
      sections.add('project_facts');
    } else if (entry.memory_type === 'episode') {
      sections.add('project_facts');
    }
  }

  return [...sections];
}

function charsOf(entry: CapsuleEntry): number {
  return entry.content.length + (entry.recommended_action?.length ?? 0);
}

export async function buildCapsule(
  audrey: Audrey,
  query: string,
  options: CapsuleOptions = {},
): Promise<MemoryCapsule> {
  const mode: CapsuleMode = options.mode
    ?? ((process.env['AUDREY_CAPSULE_MODE'] as CapsuleMode | undefined) ?? 'balanced');
  const budgetChars = options.budgetChars
    ?? Number.parseInt(process.env['AUDREY_CONTEXT_BUDGET_CHARS'] ?? '4000', 10);
  const recentChangeWindowHours = options.recentChangeWindowHours ?? 24;
  const recallLimit = options.limit ?? (mode === 'conservative' ? 8 : mode === 'aggressive' ? 24 : 16);
  const recentWindowMs = recentChangeWindowHours * 60 * 60 * 1000;
  const includeRisks = options.includeRisks ?? true;
  const includeContradictions = options.includeContradictions ?? true;

  const sections: MemoryCapsule['sections'] = {
    must_follow: [],
    project_facts: [],
    user_preferences: [],
    procedures: [],
    risks: [],
    recent_changes: [],
    contradictions: [],
    uncertain_or_disputed: [],
  };

  const evidenceIds = new Set<string>();
  const seenPerSection = new Map<keyof MemoryCapsule['sections'], Set<string>>();

  function push(section: keyof MemoryCapsule['sections'], entry: CapsuleEntry): void {
    let seen = seenPerSection.get(section);
    if (!seen) {
      seen = new Set();
      seenPerSection.set(section, seen);
    }
    if (seen.has(entry.memory_id)) return;
    seen.add(entry.memory_id);
    sections[section].push(entry);
    evidenceIds.add(entry.memory_id);
    for (const id of entry.evidence ?? []) evidenceIds.add(id);
  }

  // 1. Primary recall (vector + confidence scoring)
  const results = await audrey.recall(query, {
    limit: recallLimit,
    scope: 'agent',
    ...(options.recall ?? {}),
  });

  const db = audrey.db;

  for (const result of results) {
    let tags: string[] = [];
    let evidence: string[] = [];
    let scope: string | undefined;

    if (result.type === 'episodic') {
      const row = loadEpisodeEnrichment(db, result.id);
      tags = parseTags(row?.tags);
      scope = row?.agent ? `agent:${row.agent}` : undefined;
    } else if (result.type === 'semantic') {
      const row = loadSemanticEnrichment(db, result.id);
      evidence = parseEvidence(row?.evidence_episode_ids);
    } else if (result.type === 'procedural') {
      const row = loadProcedureEnrichment(db, result.id);
      evidence = parseEvidence(row?.evidence_episode_ids);
    }

    const entry = buildRecallEntry(result, { tags, evidence, scope }, 'Matched query via semantic similarity.');
    const assigned = categorize(entry, result, tags, recentWindowMs);
    for (const section of assigned) {
      const entryForSection = { ...entry };
      if (section === 'recent_changes') {
        entryForSection.reason = 'Created or reinforced inside the recent-change window.';
      } else if (section === 'must_follow') {
        entryForSection.reason = 'Tagged as a must-follow rule.';
      } else if (section === 'procedures') {
        entryForSection.reason = entry.memory_type === 'procedural' ? 'Procedural memory matching query.' : 'Tagged as a procedure.';
      } else if (section === 'user_preferences') {
        entryForSection.reason = result.source === 'told-by-user' ? 'User-stated preference.' : 'Tagged as a user preference.';
      } else if (section === 'risks') {
        entryForSection.reason = 'Tagged as a risk or warning.';
      } else if (section === 'uncertain_or_disputed') {
        entryForSection.reason = entry.state === 'disputed' ? 'Disputed memory.' : 'Low-confidence memory.';
      }
      push(section, entryForSection);
    }
  }

  // 2. Tool-failure risks from memory_events
  if (includeRisks) {
    const failures = recentFailures(db, { since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), limit: 5 });
    for (const failure of failures) {
      push('risks', buildFailureEntry(failure, `Tool ${failure.tool_name ?? '(unknown)'} failed recently; treat as preflight warning.`));
    }
  }

  // 3. Open contradictions
  if (includeContradictions) {
    const contradictions = loadOpenContradictions(db, 5);
    for (const row of contradictions) {
      push('contradictions', buildContradictionEntry(row, 'Open contradiction — both sides referenced in capsule.'));
    }
  }

  // 4. Enforce the token budget. Iterate sections in priority order and trim.
  let usedChars = 0;
  let truncated = false;
  const prunedSections: MemoryCapsule['sections'] = {
    must_follow: [],
    project_facts: [],
    user_preferences: [],
    procedures: [],
    risks: [],
    recent_changes: [],
    contradictions: [],
    uncertain_or_disputed: [],
  };

  for (const section of SECTION_PRIORITY) {
    const ordered = [...sections[section]].sort((a, b) => b.confidence - a.confidence);
    for (const entry of ordered) {
      const cost = charsOf(entry);
      if (usedChars + cost > budgetChars) {
        truncated = true;
        continue;
      }
      prunedSections[section].push(entry);
      usedChars += cost;
    }
  }

  return {
    query,
    generated_at: new Date().toISOString(),
    budget_chars: budgetChars,
    used_chars: usedChars,
    truncated,
    policy: {
      mode,
      recent_change_window_hours: recentChangeWindowHours,
    },
    sections: prunedSections,
    evidence_ids: [...evidenceIds],
  };
}
