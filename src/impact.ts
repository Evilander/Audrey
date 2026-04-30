import Database from 'better-sqlite3';

export interface ImpactRow {
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  content: string;
  salience: number;
  usage_count: number;
  last_used_at: string | null;
}

export interface ImpactReport {
  generatedAt: string;
  windowDays: number;
  totals: {
    episodic: number;
    semantic: number;
    procedural: number;
  };
  validatedTotal: number;
  validatedInWindow: number;
  byType: {
    episodic: { validated: number; recent: number };
    semantic: { validated: number; recent: number; challenged: number };
    procedural: { validated: number; recent: number };
  };
  /** Per-outcome breakdown over the configured window, sourced from memory_events. */
  outcomeBreakdownInWindow: {
    helpful: number;
    wrong: number;
    used: number;
  };
  topUsed: ImpactRow[];
  weakest: ImpactRow[];
  recentActivity: ImpactRow[];
}

interface CountRow { c: number }
interface ChallengedRow { c: number | null }

function rowsFromTable(
  db: Database.Database,
  table: 'episodes' | 'semantics' | 'procedures',
  type: ImpactRow['type'],
  orderBy: string,
  whereClause: string,
  limit: number,
): ImpactRow[] {
  const sql = `
    SELECT id, content, salience, usage_count, last_used_at
    FROM ${table}
    WHERE ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(limit) as Array<{
    id: string;
    content: string;
    salience: number | null;
    usage_count: number | null;
    last_used_at: string | null;
  }>;
  return rows.map(r => ({
    id: r.id,
    type,
    content: r.content,
    salience: r.salience ?? 0.5,
    usage_count: r.usage_count ?? 0,
    last_used_at: r.last_used_at,
  }));
}

function topAcrossTables(
  db: Database.Database,
  orderBy: string,
  whereClause: string,
  limit: number,
): ImpactRow[] {
  const all: ImpactRow[] = [
    ...rowsFromTable(db, 'episodes', 'episodic', orderBy, whereClause, limit),
    ...rowsFromTable(db, 'semantics', 'semantic', orderBy, whereClause + " AND state != 'rolled_back'", limit),
    ...rowsFromTable(db, 'procedures', 'procedural', orderBy, whereClause + " AND state != 'rolled_back'", limit),
  ];
  // Re-sort the merged list and trim. The ORDER BY clause is the same across
  // all three queries so a stable lexical secondary on id keeps merges deterministic.
  if (orderBy.startsWith('usage_count DESC')) {
    all.sort((a, b) => (b.usage_count - a.usage_count) || a.id.localeCompare(b.id));
  } else if (orderBy.startsWith('salience ASC')) {
    all.sort((a, b) => (a.salience - b.salience) || a.id.localeCompare(b.id));
  } else if (orderBy.startsWith('last_used_at DESC')) {
    all.sort((a, b) => {
      const aT = a.last_used_at ?? '';
      const bT = b.last_used_at ?? '';
      return bT.localeCompare(aT);
    });
  }
  return all.slice(0, limit);
}

export function buildImpactReport(db: Database.Database, windowDays = 7, limit = 5): ImpactReport {
  const now = new Date();
  const sinceISO = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const totalEp = (db.prepare('SELECT COUNT(*) as c FROM episodes').get() as CountRow).c;
  const totalSem = (db.prepare("SELECT COUNT(*) as c FROM semantics WHERE state != 'rolled_back'").get() as CountRow).c;
  const totalProc = (db.prepare("SELECT COUNT(*) as c FROM procedures WHERE state != 'rolled_back'").get() as CountRow).c;

  const validatedEp = (db.prepare('SELECT COUNT(*) as c FROM episodes WHERE usage_count > 0').get() as CountRow).c;
  const validatedSem = (db.prepare("SELECT COUNT(*) as c FROM semantics WHERE usage_count > 0 AND state != 'rolled_back'").get() as CountRow).c;
  const validatedProc = (db.prepare("SELECT COUNT(*) as c FROM procedures WHERE usage_count > 0 AND state != 'rolled_back'").get() as CountRow).c;

  const recentEp = (db.prepare('SELECT COUNT(*) as c FROM episodes WHERE last_used_at >= ?').get(sinceISO) as CountRow).c;
  const recentSem = (db.prepare("SELECT COUNT(*) as c FROM semantics WHERE last_used_at >= ? AND state != 'rolled_back'").get(sinceISO) as CountRow).c;
  const recentProc = (db.prepare("SELECT COUNT(*) as c FROM procedures WHERE last_used_at >= ? AND state != 'rolled_back'").get(sinceISO) as CountRow).c;

  const challenged = ((db.prepare("SELECT SUM(challenge_count) as c FROM semantics WHERE state != 'rolled_back'").get()) as ChallengedRow).c ?? 0;

  // Per-outcome breakdown comes from the memory_events audit trail. Each
  // memory_validate call writes a row with metadata.outcome = used|helpful|wrong.
  // Cumulative counters on the memories tables can't distinguish outcomes,
  // hence the audit trail.
  const validateEvents = db.prepare(
    "SELECT metadata FROM memory_events WHERE event_type = 'Validate' AND created_at >= ?"
  ).all(sinceISO) as Array<{ metadata: string | null }>;
  const outcomeBreakdownInWindow = { helpful: 0, wrong: 0, used: 0 };
  for (const evt of validateEvents) {
    if (!evt.metadata) continue;
    try {
      const meta = JSON.parse(evt.metadata) as { outcome?: string };
      if (meta.outcome === 'helpful') outcomeBreakdownInWindow.helpful++;
      else if (meta.outcome === 'wrong') outcomeBreakdownInWindow.wrong++;
      else if (meta.outcome === 'used') outcomeBreakdownInWindow.used++;
    } catch {
      // Skip malformed metadata silently — audit reports shouldn't fail on bad rows.
    }
  }

  return {
    generatedAt: now.toISOString(),
    windowDays,
    totals: {
      episodic: totalEp,
      semantic: totalSem,
      procedural: totalProc,
    },
    validatedTotal: validatedEp + validatedSem + validatedProc,
    validatedInWindow: recentEp + recentSem + recentProc,
    byType: {
      episodic: { validated: validatedEp, recent: recentEp },
      semantic: { validated: validatedSem, recent: recentSem, challenged },
      procedural: { validated: validatedProc, recent: recentProc },
    },
    outcomeBreakdownInWindow,
    topUsed: topAcrossTables(db, 'usage_count DESC, id', 'usage_count > 0', limit),
    weakest: topAcrossTables(db, 'salience ASC, id', 'salience IS NOT NULL', limit),
    recentActivity: topAcrossTables(db, 'last_used_at DESC, id', 'last_used_at IS NOT NULL', limit),
  };
}

function truncateContent(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = [];
  lines.push(`Audrey Impact (${report.windowDays}-day window)`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  const totalMemories = report.totals.episodic + report.totals.semantic + report.totals.procedural;
  lines.push(`Memories: ${totalMemories} total (${report.totals.episodic} episodic, ${report.totals.semantic} semantic, ${report.totals.procedural} procedural)`);
  lines.push(`Validated: ${report.validatedTotal} all-time, ${report.validatedInWindow} in last ${report.windowDays} days`);
  const o = report.outcomeBreakdownInWindow;
  if (o.helpful + o.wrong + o.used > 0) {
    lines.push(`Outcomes (last ${report.windowDays} days): ${o.helpful} helpful, ${o.wrong} wrong, ${o.used} used`);
  }
  lines.push('');

  lines.push('By type:');
  lines.push(`  Episodic:   ${report.byType.episodic.validated} validated, ${report.byType.episodic.recent} recent`);
  lines.push(`  Semantic:   ${report.byType.semantic.validated} validated, ${report.byType.semantic.recent} recent, ${report.byType.semantic.challenged} challenges recorded`);
  lines.push(`  Procedural: ${report.byType.procedural.validated} validated, ${report.byType.procedural.recent} recent`);
  lines.push('');

  if (report.topUsed.length > 0) {
    lines.push('Top validated:');
    for (const r of report.topUsed) {
      lines.push(`  ${r.usage_count}x [${r.type}] ${truncateContent(r.content)}`);
    }
    lines.push('');
  }

  if (report.weakest.length > 0) {
    lines.push('Weakest (lowest salience — candidates to review or forget):');
    for (const r of report.weakest) {
      lines.push(`  salience=${r.salience.toFixed(2)} [${r.type}] ${truncateContent(r.content)}`);
    }
    lines.push('');
  }

  if (report.recentActivity.length > 0) {
    lines.push(`Recent activity (last ${report.windowDays} days):`);
    for (const r of report.recentActivity) {
      const when = r.last_used_at ? r.last_used_at.replace('T', ' ').slice(0, 19) : '—';
      lines.push(`  ${when}  [${r.type}] ${truncateContent(r.content)}`);
    }
  }

  return lines.join('\n');
}
