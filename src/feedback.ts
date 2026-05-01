import type Database from 'better-sqlite3';

export type MemoryValidateOutcome = 'used' | 'helpful' | 'wrong';

export interface MemoryValidateInput {
  id: string;
  outcome: MemoryValidateOutcome;
}

export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export interface MemoryValidateResult {
  id: string;
  type: MemoryType;
  outcome: MemoryValidateOutcome;
  salience: number;
  usageCount: number;
  retrievalCount: number | null;
  challengeCount: number | null;
  state: string | null;
}

interface RowSnapshot {
  id: string;
  salience: number | null;
  usage_count: number | null;
  retrieval_count: number | null;
  challenge_count: number | null;
  state: string | null;
}

const SALIENCE_DELTA = {
  used: 0.02,
  helpful: 0.05,
  wrong: -0.10,
} as const;

const RETRIEVAL_BUMP = {
  used: 0,
  helpful: 1,
  wrong: 0,
} as const;

const CHALLENGE_BUMP = {
  used: 0,
  helpful: 0,
  wrong: 1,
} as const;

const TABLES: Array<{ type: MemoryType; name: 'episodes' | 'semantics' | 'procedures' }> = [
  { type: 'episodic', name: 'episodes' },
  { type: 'semantic', name: 'semantics' },
  { type: 'procedural', name: 'procedures' },
];

function clampSalience(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function findRow(db: Database.Database, id: string): { type: MemoryType; row: RowSnapshot } | null {
  for (const { type, name } of TABLES) {
    const hasState = name !== 'episodes';
    const hasRetrieval = name !== 'episodes';
    const hasChallenge = name === 'semantics';
    const cols = [
      'id',
      'salience',
      'usage_count',
      hasRetrieval ? 'retrieval_count' : 'NULL AS retrieval_count',
      hasChallenge ? 'challenge_count' : 'NULL AS challenge_count',
      hasState ? 'state' : 'NULL AS state',
    ].join(', ');
    const row = db.prepare(`SELECT ${cols} FROM ${name} WHERE id = ?`).get(id) as RowSnapshot | undefined;
    if (row) return { type, row };
  }
  return null;
}

/**
 * Apply an agent-supplied feedback signal to a memory. The closed-loop
 * primitive — agents tell Audrey "this memory was helpful / wrong / I used
 * it" and Audrey nudges salience and bookkeeping accordingly.
 *
 * Idempotent semantics: each call applies one delta. Callers that want
 * single-tap-per-recall behavior should dedupe upstream.
 *
 * Returns `null` if no memory matches the id.
 */
export function applyFeedback(db: Database.Database, input: MemoryValidateInput): MemoryValidateResult | null {
  const located = findRow(db, input.id);
  if (!located) return null;

  const { type, row } = located;
  const tableName = TABLES.find(t => t.type === type)!.name;
  const nowISO = new Date().toISOString();

  const currentSalience = row.salience ?? 0.5;
  const newSalience = clampSalience(currentSalience + SALIENCE_DELTA[input.outcome]);
  const newUsageCount = (row.usage_count ?? 0) + 1;

  // For semantics/procedures we keep retrieval_count + last_reinforced_at in
  // sync with the existing recall reinforcement path so the confidence math
  // stays coherent. For episodes those columns don't exist; only usage_count
  // and salience move.
  if (tableName === 'episodes') {
    db.prepare(
      `UPDATE ${tableName} SET salience = ?, usage_count = ?, last_used_at = ? WHERE id = ?`
    ).run(newSalience, newUsageCount, nowISO, input.id);
  } else if (tableName === 'semantics') {
    const newRetrieval = (row.retrieval_count ?? 0) + RETRIEVAL_BUMP[input.outcome];
    const newChallenge = (row.challenge_count ?? 0) + CHALLENGE_BUMP[input.outcome];
    const lastReinforced = RETRIEVAL_BUMP[input.outcome] > 0 ? nowISO : null;
    if (lastReinforced) {
      db.prepare(
        `UPDATE ${tableName} SET salience = ?, usage_count = ?, last_used_at = ?, retrieval_count = ?, last_reinforced_at = ?, challenge_count = ? WHERE id = ?`
      ).run(newSalience, newUsageCount, nowISO, newRetrieval, lastReinforced, newChallenge, input.id);
    } else {
      db.prepare(
        `UPDATE ${tableName} SET salience = ?, usage_count = ?, last_used_at = ?, retrieval_count = ?, challenge_count = ? WHERE id = ?`
      ).run(newSalience, newUsageCount, nowISO, newRetrieval, newChallenge, input.id);
    }
  } else {
    const newRetrieval = (row.retrieval_count ?? 0) + RETRIEVAL_BUMP[input.outcome];
    const lastReinforced = RETRIEVAL_BUMP[input.outcome] > 0 ? nowISO : null;
    if (lastReinforced) {
      db.prepare(
        `UPDATE ${tableName} SET salience = ?, usage_count = ?, last_used_at = ?, retrieval_count = ?, last_reinforced_at = ? WHERE id = ?`
      ).run(newSalience, newUsageCount, nowISO, newRetrieval, lastReinforced, input.id);
    } else {
      db.prepare(
        `UPDATE ${tableName} SET salience = ?, usage_count = ?, last_used_at = ?, retrieval_count = ? WHERE id = ?`
      ).run(newSalience, newUsageCount, nowISO, newRetrieval, input.id);
    }
  }

  // Re-read the row so we report committed state, not in-memory deltas.
  const fresh = findRow(db, input.id)!.row;

  return {
    id: input.id,
    type,
    outcome: input.outcome,
    salience: fresh.salience ?? newSalience,
    usageCount: fresh.usage_count ?? newUsageCount,
    retrievalCount: fresh.retrieval_count,
    challengeCount: fresh.challenge_count,
    state: fresh.state,
  };
}
