import { serve } from '@hono/node-server';
import { createApp } from './routes.js';
import { Audrey } from './audrey.js';
import type { AudreyConfig } from './types.js';

export interface ServerOptions {
  port?: number;
  hostname?: string;
  config: AudreyConfig;
  apiKey?: string;
}

export async function startServer(options: ServerOptions) {
  // Default bind: loopback only. Exposing the REST sidecar to the LAN by
  // default (the prior 0.0.0.0) means any same-network process could read
  // memories, purge by query, or import poisoned snapshots. Operators that
  // genuinely need network exposure must set AUDREY_HOST explicitly.
  const { port = 7437, hostname = '127.0.0.1', config, apiKey } = options;
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

  if (audrey.embeddingProvider && typeof audrey.embeddingProvider.ready === 'function') {
    await audrey.embeddingProvider.ready();
  }

  const app = createApp(audrey, { apiKey });

  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.error(`[audrey-http] listening on ${hostname}:${info.port}`);
  });

  return {
    port,
    hostname,
    close: async () => {
      server.close();
      await audrey.closeAsync().catch(() => {});
    },
  };
}
