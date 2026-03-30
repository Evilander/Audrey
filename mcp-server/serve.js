import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { Audrey } from '../src/index.js';
import { buildAudreyConfig } from './config.js';
import { VERSION } from './config.js';

const DEFAULT_PORT = 3487;
const MAX_BODY = 10 * 1024 * 1024; // 10 MB

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audrey Memory Dashboard</title>
<style>
  :root { --bg: #0f0f0f; --card: #1a1a1a; --border: #2a2a2a; --text: #e0e0e0; --dim: #888; --accent: #6c9; --warn: #e94; --err: #e55; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; background: var(--bg); color: var(--text); padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.4em; margin-bottom: 4px; color: var(--accent); }
  .subtitle { color: var(--dim); font-size: 0.85em; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h3 { font-size: 0.8em; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .stat { font-size: 2em; font-weight: bold; color: var(--accent); }
  .stat.warn { color: var(--warn); }
  .stat.err { color: var(--err); }
  .stat-label { font-size: 0.75em; color: var(--dim); }
  table { width: 100%; border-collapse: collapse; font-size: 0.8em; }
  th { text-align: left; color: var(--dim); font-weight: normal; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--border); max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; }
  .badge-active, .badge-completed { background: #1a3a2a; color: var(--accent); }
  .badge-dormant { background: #3a2a1a; color: var(--warn); }
  .badge-open, .badge-failed { background: #3a1a1a; color: var(--err); }
  .refresh { position: fixed; top: 16px; right: 16px; background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .refresh:hover { border-color: var(--accent); }
</style>
</head>
<body>
<h1>Audrey</h1>
<p class="subtitle">Memory Health Dashboard</p>
<button class="refresh" onclick="load()">Refresh</button>
<div id="content"><p style="color:#888">Loading...</p></div>
<script>
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function truncate(s, n) { return s.length > n ? esc(s.slice(0, n)) + '...' : esc(s); }

async function load() {
  try {
    const [s, a] = await Promise.all([
      fetch('/status').then(r => r.json()),
      fetch('/analytics').then(r => r.json()),
    ]);
    render(s, a);
  } catch (e) {
    document.getElementById('content').textContent = 'Failed to load: ' + e.message;
  }
}

function render(s, a) {
  const ct = s.contradictions;
  const el = document.getElementById('content');
  el.innerHTML = '';

  // Stats grid
  const grid = document.createElement('div');
  grid.className = 'grid';
  const cards = [
    ['Episodic', s.episodic, 'raw events'],
    ['Semantic', s.semantic, 'consolidated principles'],
    ['Procedural', s.procedural, 'learned workflows'],
    ['Causal Links', s.causalLinks, 'cause-effect pairs'],
    ['Dormant', s.dormant, 'below threshold', s.dormant > 0 ? 'warn' : ''],
    ['Contradictions', ct.open + ' open', (ct.open+ct.resolved+ct.context_dependent+ct.reopened) + ' total', ct.open > 0 ? 'err' : ''],
    ['Consolidations', s.totalConsolidationRuns, s.lastConsolidation ? 'Last: ' + new Date(s.lastConsolidation).toLocaleString() : 'Never'],
  ];
  for (const [title, value, label, cls] of cards) {
    const c = document.createElement('div');
    c.className = 'card';
    c.innerHTML = '<h3>' + esc(title) + '</h3><div class="stat ' + (cls||'') + '">' + esc(String(value)) + '</div><div class="stat-label">' + esc(label) + '</div>';
    grid.appendChild(c);
  }
  el.appendChild(grid);

  // Agent activity
  if (a.agents && a.agents.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '16px';
    let html = '<h3>Agent Activity</h3><table><tr><th>Agent</th><th>Memories</th></tr>';
    for (const ag of a.agents) html += '<tr><td>' + esc(ag.agent) + '</td><td>' + ag.count + '</td></tr>';
    html += '</table>';
    card.innerHTML = html;
    el.appendChild(card);
  }

  // Top semantics
  if (a.topSemantics && a.topSemantics.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '16px';
    let html = '<h3>Top Semantic Principles</h3><table><tr><th>Content</th><th>Retrieved</th><th>Used</th><th>State</th></tr>';
    for (const sem of a.topSemantics) {
      html += '<tr><td title="' + esc(sem.content) + '">' + truncate(sem.content, 80) + '</td><td>' + sem.retrieval_count + '</td><td>' + (sem.usage_count||0) + '</td><td><span class="badge badge-' + esc(sem.state) + '">' + esc(sem.state) + '</span></td></tr>';
    }
    html += '</table>';
    card.innerHTML = html;
    el.appendChild(card);
  }

  // Recent episodes
  if (a.topEpisodes && a.topEpisodes.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '16px';
    let html = '<h3>Recent Episodes</h3><table><tr><th>Content</th><th>Used</th><th>Created</th></tr>';
    for (const ep of a.topEpisodes.slice(0, 10)) {
      html += '<tr><td title="' + esc(ep.content) + '">' + truncate(ep.content, 80) + '</td><td>' + (ep.usage_count||0) + '</td><td>' + new Date(ep.created_at).toLocaleDateString() + '</td></tr>';
    }
    html += '</table>';
    card.innerHTML = html;
    el.appendChild(card);
  }

  // Consolidation history
  if (a.recentRuns && a.recentRuns.length > 0) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '16px';
    let html = '<h3>Consolidation History</h3><table><tr><th>Started</th><th>Status</th><th>Duration</th></tr>';
    for (const run of a.recentRuns.slice(0, 10)) {
      const dur = run.completed_at && run.started_at ? ((new Date(run.completed_at) - new Date(run.started_at)) / 1000).toFixed(1) + 's' : '-';
      html += '<tr><td>' + new Date(run.started_at).toLocaleString() + '</td><td><span class="badge badge-' + esc(run.status) + '">' + esc(run.status) + '</span></td><td>' + dur + '</td></tr>';
    }
    html += '</table>';
    card.innerHTML = html;
    el.appendChild(card);
  }

  const footer = document.createElement('p');
  footer.style.cssText = 'color:#888;font-size:0.75em;margin-top:24px';
  footer.textContent = 'Audrey v${VERSION} — refreshed ' + new Date().toLocaleTimeString();
  el.appendChild(footer);
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const succeed = (val) => { if (!settled) { settled = true; resolve(val); } };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        fail(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return succeed({});
      try {
        succeed(JSON.parse(raw));
      } catch {
        fail(new Error('Invalid JSON'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function cors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function route(method, pathname) {
  return `${method} ${pathname}`;
}

async function drainAndCloseAudrey(audrey) {
  if (audrey && typeof audrey.waitForIdle === 'function') {
    await audrey.waitForIdle();
  }
  audrey?.close();
}

/**
 * Creates an HTTP server wrapping an Audrey instance.
 * @param {Audrey} audrey - The Audrey instance to serve
 * @param {{ apiKey?: string, audreyFactory?: () => Audrey }} options
 */
export function createAudreyServer(audrey, options = {}) {
  const apiKey = options.apiKey || null;
  const audreyFactory = options.audreyFactory || null;

  // Mutable holder so restore can swap the instance
  const ctx = { audrey };

  function authenticate(req, res) {
    if (!apiKey) return true;
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${apiKey}`;
    if (auth.length === expected.length &&
        timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return true;
    }
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = route(req.method, url.pathname);

    if (req.method === 'OPTIONS') {
      cors(res);
      return;
    }

    if (!authenticate(req, res)) return;

    const requestAgent = req.headers['x-audrey-agent'] || null;

    try {
      switch (key) {
        case 'GET /health': {
          json(res, 200, { ok: true, version: VERSION });
          break;
        }

        case 'GET /status': {
          const stats = ctx.audrey.introspect();
          json(res, 200, stats);
          break;
        }

        case 'GET /analytics': {
          const db = ctx.audrey.db;
          const topEpisodes = db.prepare(
            'SELECT id, content, usage_count, created_at FROM episodes ORDER BY usage_count DESC LIMIT 10'
          ).all();
          const topSemantics = db.prepare(
            "SELECT id, content, retrieval_count, usage_count, state FROM semantics WHERE state != 'rolled_back' ORDER BY retrieval_count DESC LIMIT 10"
          ).all();
          const recentRuns = db.prepare(
            'SELECT * FROM consolidation_runs ORDER BY started_at DESC LIMIT 20'
          ).all();
          const metrics = db.prepare(
            'SELECT * FROM consolidation_metrics ORDER BY completed_at DESC LIMIT 20'
          ).all();
          const agents = db.prepare(
            "SELECT agent, COUNT(*) as count FROM episodes GROUP BY agent ORDER BY count DESC"
          ).all();
          json(res, 200, { topEpisodes, topSemantics, recentRuns, metrics, agents });
          break;
        }

        case 'GET /dashboard': {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
          res.end(getDashboardHTML());
          break;
        }

        case 'POST /encode': {
          const body = await parseBody(req);
          if (!body.content) {
            json(res, 400, { error: 'content is required' });
            return;
          }
          if (requestAgent) body.agent = requestAgent;
          const id = await ctx.audrey.encode(body);
          json(res, 201, { id });
          break;
        }

        case 'POST /recall': {
          const body = await parseBody(req);
          if (!body.query) {
            json(res, 400, { error: 'query is required' });
            return;
          }
          const { query, ...opts } = body;
          if (requestAgent) opts.agent = requestAgent;
          const results = await ctx.audrey.recall(query, opts);
          json(res, 200, {
            results,
            partialFailure: Boolean(results.partialFailure),
            errors: results.errors ?? [],
          });
          break;
        }

        case 'POST /dream': {
          const body = await parseBody(req);
          const result = await ctx.audrey.dream(body);
          json(res, 200, result);
          break;
        }

        case 'POST /consolidate': {
          const body = await parseBody(req);
          const result = await ctx.audrey.consolidate(body);
          json(res, 200, result);
          break;
        }

        case 'POST /mark-used': {
          const body = await parseBody(req);
          if (!body.id) {
            json(res, 400, { error: 'id is required' });
            return;
          }
          ctx.audrey.markUsed(body.id);
          json(res, 200, { ok: true });
          break;
        }

        case 'POST /forget': {
          const body = await parseBody(req);
          if (body.query) {
            const result = await ctx.audrey.forgetByQuery(body.query, body);
            json(res, 200, result);
          } else if (body.id) {
            const result = ctx.audrey.forget(body.id, body);
            json(res, 200, result);
          } else {
            json(res, 400, { error: 'id or query is required' });
          }
          break;
        }

        case 'POST /snapshot': {
          const data = ctx.audrey.export();
          json(res, 200, data);
          break;
        }

        case 'POST /restore': {
          const body = await parseBody(req);
          if (!body.version) {
            json(res, 400, { error: 'Invalid snapshot: missing version field' });
            return;
          }
          if (!audreyFactory) {
            json(res, 501, { error: 'Restore not available: no audreyFactory configured' });
            return;
          }
          const dbPath = ctx.audrey.db?.name;
          await drainAndCloseAudrey(ctx.audrey);
          if (dbPath) {
            const dir = dirname(dbPath);
            for (const f of ['audrey.db', 'audrey.db-wal', 'audrey.db-shm']) {
              try { unlinkSync(join(dir, f)); } catch {}
            }
          }
          ctx.audrey = audreyFactory();
          await ctx.audrey.import(body);
          const stats = ctx.audrey.introspect();
          json(res, 200, { ok: true, ...stats });
          break;
        }

        default: {
          json(res, 404, { error: 'Not found', endpoints: [
            'GET  /health',
            'GET  /status',
            'POST /encode',
            'POST /recall',
            'POST /dream',
            'POST /consolidate',
            'POST /mark-used',
            'POST /forget',
            'POST /snapshot',
            'POST /restore',
          ]});
        }
      }
    } catch (err) {
      if (err.message.includes('too large')) {
        json(res, 413, { error: 'Request body too large' });
      } else if (err.message.includes('Invalid JSON')) {
        json(res, 400, { error: 'Invalid JSON in request body' });
      } else if (err.message.includes('source type')) {
        json(res, 400, { error: err.message });
      } else {
        console.error('[audrey] Internal error:', err.message);
        json(res, 500, { error: 'Internal server error' });
      }
    }
  });

  server._ctx = ctx;
  return server;
}

export async function startServer(options = {}) {
  const port = options.port || parseInt(process.env.AUDREY_PORT, 10) || DEFAULT_PORT;
  const host = options.host || process.env.AUDREY_HOST || '127.0.0.1';
  const apiKey = options.apiKey || process.env.AUDREY_API_KEY || null;

  const config = buildAudreyConfig();
  const audrey = new Audrey(config);
  const audreyFactory = () => new Audrey(config);

  const server = createAudreyServer(audrey, { apiKey, audreyFactory });

  server.listen(port, host, () => {
    console.log(`[audrey] REST API server listening on http://${host}:${port}`);
    console.log(`[audrey] Data: ${config.dataDir}`);
    console.log(`[audrey] Embedding: ${config.embedding.provider}`);
    if (apiKey) {
      console.log('[audrey] Auth: Bearer token required');
    } else {
      console.warn('[audrey] WARNING: No API key configured. Set AUDREY_API_KEY for production use.');
    }
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health       - Liveness probe');
    console.log('  GET  /status       - Memory stats (introspect)');
    console.log('  POST /encode       - Store a memory');
    console.log('  POST /recall       - Semantic search');
    console.log('  POST /dream        - Consolidation + decay cycle');
    console.log('  POST /consolidate  - Run consolidation only');
    console.log('  POST /forget       - Forget by id or query');
    console.log('  POST /snapshot     - Export all memories as JSON');
    console.log('  POST /restore      - Import snapshot (wipes + reimports)');
    console.log('');
    console.log('Press Ctrl+C to stop.');
  });

  const shutdown = () => {
    console.log('\n[audrey] Shutting down...');
    void drainAndCloseAudrey(server._ctx.audrey)
      .catch(err => {
        console.error('[audrey] Shutdown drain failed:', err.message);
      })
      .finally(() => {
        server.close(() => process.exit(0));
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, audrey };
}
