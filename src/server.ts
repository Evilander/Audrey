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
  const { port = 7437, hostname = '0.0.0.0', config, apiKey } = options;
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
    close: () => {
      server.close();
      audrey.close();
    },
  };
}
