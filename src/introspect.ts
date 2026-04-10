import Database from 'better-sqlite3';
import type { IntrospectResult } from './types.js';

interface CountsRow {
  episodic: number;
  semantic: number;
  procedural: number;
  causal_links: number;
  dormant: number;
}

interface ContradictionCountsRow {
  open: number | null;
  resolved: number | null;
  context_dependent: number | null;
  reopened: number | null;
}

interface CompletedAtRow {
  completed_at: string;
}

interface CountRow {
  count: number;
}

export function introspect(db: Database.Database): IntrospectResult {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM episodes) as episodic,
      (SELECT COUNT(*) FROM semantics WHERE state != 'rolled_back') as semantic,
      (SELECT COUNT(*) FROM procedures WHERE state != 'rolled_back') as procedural,
      (SELECT COUNT(*) FROM causal_links) as causal_links,
      (SELECT COUNT(*) FROM semantics WHERE state = 'dormant')
        + (SELECT COUNT(*) FROM procedures WHERE state = 'dormant') as dormant
  `).get() as CountsRow;

  const contradictions = db.prepare(`
    SELECT
      SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN state = 'resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN state = 'context_dependent' THEN 1 ELSE 0 END) as context_dependent,
      SUM(CASE WHEN state = 'reopened' THEN 1 ELSE 0 END) as reopened
    FROM contradictions
  `).get() as ContradictionCountsRow | undefined;

  const lastRun = db.prepare(`
    SELECT completed_at FROM consolidation_runs
    WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1
  `).get() as CompletedAtRow | undefined;
  const totalRuns = (db.prepare('SELECT COUNT(*) as count FROM consolidation_runs').get() as CountRow).count;

  return {
    episodic: counts.episodic,
    semantic: counts.semantic,
    procedural: counts.procedural,
    causalLinks: counts.causal_links,
    dormant: counts.dormant,
    contradictions: {
      open: contradictions?.open || 0,
      resolved: contradictions?.resolved || 0,
      context_dependent: contradictions?.context_dependent || 0,
      reopened: contradictions?.reopened || 0,
    },
    lastConsolidation: lastRun?.completed_at || null,
    totalConsolidationRuns: totalRuns,
  };
}
