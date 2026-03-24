import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { Audrey } from '../src/index.js';
import { buildAudreyConfig } from './config.js';
import { VERSION } from './config.js';

const DEFAULT_PORT = 3487;
const MAX_BODY = 10 * 1024 * 1024; // 10 MB

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
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
    const auth = req.headers.authorization;
    if (auth === `Bearer ${apiKey}`) return true;
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

        case 'POST /encode': {
          const body = await parseBody(req);
          if (!body.content) {
            json(res, 400, { error: 'content is required' });
            return;
          }
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
          const results = await ctx.audrey.recall(query, opts);
          json(res, 200, { results });
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
          ctx.audrey.close();
          const dbPath = ctx.audrey.db?.name;
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
            'POST /forget',
            'POST /snapshot',
            'POST /restore',
          ]});
        }
      }
    } catch (err) {
      const status = err.message.includes('too large') ? 413
        : err.message.includes('Invalid JSON') ? 400
        : 500;
      json(res, status, { error: err.message });
    }
  });

  return server;
}

export async function startServer(options = {}) {
  const port = options.port || parseInt(process.env.AUDREY_PORT, 10) || DEFAULT_PORT;
  const apiKey = options.apiKey || process.env.AUDREY_API_KEY || null;

  const config = buildAudreyConfig();
  const audrey = new Audrey(config);
  const audreyFactory = () => new Audrey(config);

  const server = createAudreyServer(audrey, { apiKey, audreyFactory });

  server.listen(port, () => {
    console.log(`[audrey] REST API server listening on http://localhost:${port}`);
    console.log(`[audrey] Data: ${config.dataDir}`);
    console.log(`[audrey] Embedding: ${config.embedding.provider}`);
    if (apiKey) console.log('[audrey] Auth: Bearer token required');
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
    audrey.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, audrey };
}
