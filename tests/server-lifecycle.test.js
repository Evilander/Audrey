import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../dist/src/server.js';
import { Audrey } from '../dist/src/audrey.js';
import { MockEmbeddingProvider } from '../dist/src/embedding.js';

const stores = [];
const servers = [];
function config() {
  const dataDir = mkdtempSync(join(tmpdir(), 'audrey-http-lifecycle-'));
  stores.push(dataDir);
  return { dataDir, agent: 'lifecycle-test', embedding: { provider: 'mock', dimensions: 8 } };
}
async function start(options = {}) {
  const server = await startServer({
    port: 0,
    config: config(),
    shutdownTimeoutMs: 1000,
    ...options,
  });
  servers.push(server);
  return server;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close().catch(() => {})));
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) rmSync(store, { recursive: true, force: true });
});

describe('HTTP server lifecycle', () => {
  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'])(
    'the serve CLI closes cleanly on %s',
    async signal => {
      const fixture = config();
      const child = spawn(process.execPath, [resolve('dist/mcp-server/index.js'), 'serve'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8000,
        env: {
          ...process.env,
          AUDREY_DATA_DIR: fixture.dataDir,
          AUDREY_EMBEDDING_PROVIDER: 'mock',
          AUDREY_LLM_PROVIDER: 'mock',
          AUDREY_PORT: '0',
          AUDREY_HOST: '127.0.0.1',
          AUDREY_API_KEY: '',
        },
      });
      let stderr = '';
      const listening = new Promise((resolvePort, reject) => {
        child.stderr.on('data', chunk => {
          stderr += chunk;
          const match = stderr.match(/serving on 127\.0\.0\.1:(\d+)/);
          if (match) resolvePort(Number(match[1]));
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`CLI exited before listening: ${stderr}`)));
      });
      const exited = once(child, 'exit');
      try {
        const port = await listening;
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(200);
        await response.text();
        child.kill(signal);
        expect(await exited).toEqual([0, null]);
        expect(stderr).toContain('[audrey-http] shutting down');
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    },
  );

  it('returns an already-listening ephemeral port and closes idempotently', async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    await response.text();
    const closing = server.close();
    expect(server.close()).toBe(closing);
    await closing;
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('rejects a bind failure and closes the newly opened store', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const close = vi.spyOn(Audrey.prototype, 'closeAsync');
    try {
      await expect(start({ port: occupied.address().port })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      expect(close).toHaveBeenCalledOnce();
      expect(close.mock.contexts[0].db.open).toBe(false);
    } finally {
      await new Promise(resolve => occupied.close(resolve));
    }
  });

  it('cleans up after embedding readiness rejects', async () => {
    Object.defineProperty(MockEmbeddingProvider.prototype, 'ready', {
      configurable: true,
      value: async () => {
        throw new Error('fixture readiness failure');
      },
    });
    const close = vi.spyOn(Audrey.prototype, 'closeAsync');
    try {
      await expect(start()).rejects.toThrow('fixture readiness failure');
      expect(close).toHaveBeenCalledOnce();
      expect(close.mock.contexts[0].db.open).toBe(false);
    } finally {
      delete MockEmbeddingProvider.prototype.ready;
    }
  });

  it('finishes an active encode and its queued work before closing the store', async () => {
    const embeddingStarted = deferred();
    const allowEmbedding = deferred();
    const queueStarted = deferred();
    const allowQueue = deferred();
    const embed = MockEmbeddingProvider.prototype.embed;
    vi.spyOn(MockEmbeddingProvider.prototype, 'embed').mockImplementation(async function (text) {
      embeddingStarted.resolve();
      await allowEmbedding.promise;
      return embed.call(this, text);
    });
    vi.spyOn(Audrey.prototype, '_runPostEncode').mockImplementation(async () => {
      queueStarted.resolve();
      await allowQueue.promise;
    });
    const close = vi.spyOn(Audrey.prototype, 'closeAsync');
    const server = await start({ shutdownTimeoutMs: 2000 });
    const response = fetch(`http://127.0.0.1:${server.port}/v1/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Complete this write before shutdown',
        source: 'told-by-user',
      }),
      signal: AbortSignal.timeout(3000),
    });
    await embeddingStarted.promise;
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    try {
      expect(closed).toBe(false);
      allowEmbedding.resolve();
      const result = await response;
      expect(result.status).toBe(200);
      await result.text();
      await queueStarted.promise;
      expect(closed).toBe(false);
      allowQueue.resolve();
      await closing;
      expect(close.mock.contexts[0].db.open).toBe(false);
    } finally {
      allowEmbedding.resolve();
      allowQueue.resolve();
    }
  });

  it('bounds shutdown when a client never finishes its request body', async () => {
    const server = await start({ shutdownTimeoutMs: 50 });
    const socket = connect(server.port, '127.0.0.1');
    socket.on('error', () => {});
    try {
      await once(socket, 'connect', { signal: AbortSignal.timeout(2000) });
      const accepted = once(socket, 'data', { signal: AbortSignal.timeout(2000) });
      socket.write(
        'POST /v1/encode HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 100\r\n\r\n{',
      );
      expect(String((await accepted)[0])).toContain('100 Continue');
      // Consume the peer's final bytes so its FIN can become an observable close.
      socket.resume();
      const disconnected = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
      await expect(server.close()).rejects.toThrow(/shutdown grace period expired/);
      await disconnected;
    } finally {
      socket.destroy();
    }
  });
});
