import { createAdaptorServer } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createApp } from './routes.js';
import { Audrey } from './audrey.js';
import type { AudreyConfig } from './types.js';

export interface ServerOptions {
  port?: number;
  hostname?: string;
  config: AudreyConfig;
  apiKey?: string;
  sharedScopeEnabled?: boolean;
  /** Total grace period for active requests and queued post-encode work. */
  shutdownTimeoutMs?: number;
}

export async function startServer(options: ServerOptions) {
  // Default bind: loopback only. Exposing the REST sidecar to the LAN by
  // default (the prior 0.0.0.0) means any same-network process could read
  // memories, purge by query, or import poisoned snapshots. Operators that
  // genuinely need network exposure must set AUDREY_HOST explicitly.
  const {
    port = 7437,
    hostname = '127.0.0.1',
    config,
    apiKey,
    sharedScopeEnabled,
    shutdownTimeoutMs = 10_000,
  } = options;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
    throw new Error('shutdownTimeoutMs must be a finite non-negative number');
  }
  // Refuse to start without auth on a non-loopback bind. The escape hatch is
  // explicit so a misconfigured deploy can't silently expose memories.
  const isLoopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
  if (!apiKey && !isLoopback && process.env.AUDREY_ALLOW_NO_AUTH !== '1') {
    throw new Error(
      `[audrey-http] refusing to start on ${hostname} without AUDREY_API_KEY. ` +
        `Set AUDREY_API_KEY=<token> (recommended) or AUDREY_ALLOW_NO_AUTH=1 to override.`,
    );
  }
  if (!apiKey && !isLoopback) {
    console.error(
      `[audrey-http] WARNING: serving on ${hostname} without auth (AUDREY_ALLOW_NO_AUTH=1). ` +
        `Anyone on this network can read and modify memories.`,
    );
  }
  const audrey = new Audrey(config);
  let server: ReturnType<typeof createAdaptorServer> | undefined;
  const sockets = new Set<Socket>();
  try {
    if (typeof audrey.embeddingProvider.ready === 'function') {
      await audrey.embeddingProvider.ready();
    }
    const app = createApp(audrey, { apiKey, sharedScopeEnabled });
    const listener = createAdaptorServer({ fetch: app.fetch });
    server = listener;
    let shuttingDown = false;
    listener.on('connection', (socket: Socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    listener.on('request', (_request: IncomingMessage, response: ServerResponse) => {
      response.once('finish', () => {
        // server.close() reaps sockets already idle at shutdown, but requests
        // active at that point can subsequently enter their keep-alive wait.
        if (shuttingDown && 'closeIdleConnections' in listener) {
          listener.closeIdleConnections();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => {
        listener.removeListener('listening', listening);
        reject(error);
      };
      const listening = (): void => {
        listener.removeListener('error', failed);
        resolve();
      };
      listener.once('error', failed);
      listener.once('listening', listening);
      listener.listen(port, hostname);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind a port');
    console.error(`[audrey-http] listening on ${hostname}:${address.port}`);

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        shuttingDown = true;
        const deadline = Date.now() + shutdownTimeoutMs;
        let shutdownError: Error | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => {
                console.error(
                  '[audrey-http] shutdown grace period expired; closing active connections',
                );
                for (const socket of sockets) socket.destroy();
                reject(new Error('HTTP shutdown grace period expired'));
              },
              Math.max(0, deadline - Date.now()),
            );
            listener.close(error => {
              clearTimeout(timeout);
              if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
                reject(error);
              } else resolve();
            });
          });
        } catch (error) {
          shutdownError = error instanceof Error ? error : new Error(String(error));
        }
        const drained = await audrey.closeAsync(Math.max(0, deadline - Date.now()));
        if (drained && !drained.drained) {
          console.error(
            `[audrey-http] shutdown left pending post-encode work: ${drained.pendingIds.join(', ')}`,
          );
          throw new Error('Post-encode work did not drain before the shutdown deadline');
        }
        if (shutdownError) throw shutdownError;
      })();
      return closing;
    };
    return { port: address.port, hostname, close };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) server.close();
    try {
      await audrey.closeAsync(0);
    } catch (cleanupError) {
      console.error('[audrey-http] startup cleanup failed:', cleanupError);
    }
    throw error;
  }
}
