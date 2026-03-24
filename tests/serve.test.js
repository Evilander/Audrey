import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAudreyServer } from '../mcp-server/serve.js';
import { Audrey } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestWithAuth(server, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers,
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Audrey REST API Server', () => {
  let server;
  let audrey;
  let dataDir;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-serve-test-'));
    audrey = new Audrey({
      dataDir,
      agent: 'test-server',
      embedding: { provider: 'mock', dimensions: 64 },
    });
    const audreyFactory = () => new Audrey({
      dataDir,
      agent: 'test-server',
      embedding: { provider: 'mock', dimensions: 64 },
    });
    server = createAudreyServer(audrey, { audreyFactory });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    server.close();
    try { audrey.close(); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('GET /health returns ok', async () => {
    const res = await request(server, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.version).toBeDefined();
  });

  it('GET /status returns introspection data', async () => {
    const res = await request(server, 'GET', '/status');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('episodic');
    expect(res.data).toHaveProperty('semantic');
  });

  it('POST /encode stores a memory and returns id', async () => {
    const res = await request(server, 'POST', '/encode', {
      content: 'The server test encodes a memory',
      source: 'direct-observation',
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toBeDefined();
    expect(typeof res.data.id).toBe('string');
  });

  it('POST /encode rejects missing content', async () => {
    const res = await request(server, 'POST', '/encode', { source: 'test' });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('content');
  });

  it('POST /recall searches memories', async () => {
    const res = await request(server, 'POST', '/recall', {
      query: 'server test memory',
    });
    expect(res.status).toBe(200);
    expect(res.data.results).toBeDefined();
    expect(Array.isArray(res.data.results)).toBe(true);
  });

  it('POST /recall rejects missing query', async () => {
    const res = await request(server, 'POST', '/recall', {});
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('query');
  });

  it('POST /dream runs consolidation cycle', async () => {
    const res = await request(server, 'POST', '/dream', {});
    expect(res.status).toBe(200);
  });

  it('POST /consolidate runs consolidation', async () => {
    const res = await request(server, 'POST', '/consolidate', {});
    expect(res.status).toBe(200);
  });

  it('POST /snapshot exports memory data', async () => {
    const res = await request(server, 'POST', '/snapshot');
    expect(res.status).toBe(200);
    expect(res.data.version).toBeDefined();
    expect(res.data.episodes).toBeDefined();
  });

  it('POST /forget by id removes a memory', async () => {
    const enc = await request(server, 'POST', '/encode', {
      content: 'Memory to forget via server',
      source: 'direct-observation',
    });
    const res = await request(server, 'POST', '/forget', { id: enc.data.id });
    expect(res.status).toBe(200);
  });

  it('POST /forget rejects missing id and query', async () => {
    const res = await request(server, 'POST', '/forget', {});
    expect(res.status).toBe(400);
  });

  it('POST /forget by query works', async () => {
    await request(server, 'POST', '/encode', {
      content: 'Unique forget query target xyz123',
      source: 'direct-observation',
    });
    const res = await request(server, 'POST', '/forget', {
      query: 'xyz123',
      limit: 1,
    });
    expect(res.status).toBe(200);
  });

  it('POST /restore imports a snapshot', async () => {
    const snap = await request(server, 'POST', '/snapshot');
    const res = await request(server, 'POST', '/restore', snap.data);
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });

  it('POST /restore rejects invalid snapshot', async () => {
    const res = await request(server, 'POST', '/restore', { bad: true });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('version');
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(server, 'GET', '/nonexistent');
    expect(res.status).toBe(404);
    expect(res.data.endpoints).toBeDefined();
  });

  it('sets CORS headers', async () => {
    const res = await request(server, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('Audrey REST API with auth', () => {
  let server;
  let audrey;
  let dataDir;
  const API_KEY = 'test-secret-key-12345';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'audrey-serve-auth-'));
    audrey = new Audrey({
      dataDir,
      agent: 'test-auth',
      embedding: { provider: 'mock', dimensions: 64 },
    });
    server = createAudreyServer(audrey, { apiKey: API_KEY });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    server.close();
    audrey.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await requestWithAuth(server, 'GET', '/health', null, null);
    expect(res.status).toBe(401);
  });

  it('rejects wrong token', async () => {
    const res = await requestWithAuth(server, 'GET', '/health', null, 'wrong');
    expect(res.status).toBe(401);
  });

  it('accepts correct token', async () => {
    const res = await requestWithAuth(server, 'GET', '/health', null, API_KEY);
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });
});
