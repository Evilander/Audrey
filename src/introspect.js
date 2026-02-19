export function introspect(db) {
  const episodic = db.prepare('SELECT COUNT(*) as count FROM episodes').get().count;
  const semantic = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state != 'rolled_back'").get().count;
  const procedural = db.prepare("SELECT COUNT(*) as count FROM procedures WHERE state != 'rolled_back'").get().count;
  const causalLinks = db.prepare('SELECT COUNT(*) as count FROM causal_links').get().count;
  const dormant = db.prepare("SELECT COUNT(*) as count FROM semantics WHERE state = 'dormant'").get().count
    + db.prepare("SELECT COUNT(*) as count FROM procedures WHERE state = 'dormant'").get().count;

  const contradictions = {
    open: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'open'").get().count,
    resolved: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'resolved'").get().count,
    context_dependent: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'context_dependent'").get().count,
    reopened: db.prepare("SELECT COUNT(*) as count FROM contradictions WHERE state = 'reopened'").get().count,
  };

  const lastRun = db.prepare(`SELECT completed_at FROM consolidation_runs
    WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`).get();
  const totalRuns = db.prepare('SELECT COUNT(*) as count FROM consolidation_runs').get().count;

  return {
    episodic,
    semantic,
    procedural,
    causalLinks,
    dormant,
    contradictions,
    lastConsolidation: lastRun?.completed_at || null,
    totalConsolidationRuns: totalRuns,
  };
}
