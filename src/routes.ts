import { Hono } from 'hono';
import type { Audrey } from './audrey.js';
import { VERSION } from '../mcp-server/config.js';

export interface AppOptions {
  apiKey?: string;
}

export function createApp(audrey: Audrey, options: AppOptions = {}): Hono {
  const app = new Hono();

  // Health check — no auth required.
  // Fields kept for backward compatibility across Audrey client surfaces:
  //   status  / healthy — original TS-era field names (tests/http-api.test.js)
  //   ok      / version — Python SDK HealthResponse contract
  //                       (python/audrey_memory/types.py)
  app.get('/health', (c) => {
    try {
      const status = audrey.memoryStatus();
      return c.json({
        status: 'ok',
        ok: true,
        healthy: status.healthy,
        version: VERSION,
      });
    } catch {
      return c.json({
        status: 'error',
        ok: false,
        healthy: false,
        version: VERSION,
      }, 500);
    }
  });

  // API key middleware — only if apiKey is configured
  if (options.apiKey) {
    app.use('/v1/*', async (c, next) => {
      const auth = c.req.header('Authorization');
      if (!auth || auth !== `Bearer ${options.apiKey}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
  }

  // POST /v1/encode
  app.post('/v1/encode', async (c) => {
    try {
      const body = await c.req.json();
      const id = await audrey.encode({
        content: body.content,
        source: body.source,
        tags: body.tags,
        salience: body.salience,
        context: body.context,
        affect: body.affect,
        private: body.private,
      });
      return c.json({ id, content: body.content, source: body.source, private: body.private ?? false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/recall
  app.post('/v1/recall', async (c) => {
    try {
      const body = await c.req.json();
      const { query, ...opts } = body;
      const results = await audrey.recall(query, opts);
      return c.json(results);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/consolidate
  app.post('/v1/consolidate', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await audrey.consolidate(body);
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/dream
  app.post('/v1/dream', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await audrey.dream(body);
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // GET /v1/introspect
  app.get('/v1/introspect', (c) => {
    try {
      const result = audrey.introspect();
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/resolve-truth
  app.post('/v1/resolve-truth', async (c) => {
    try {
      const body = await c.req.json();
      const result = await audrey.resolveTruth(body.contradiction_id);
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // GET /v1/export
  app.get('/v1/export', (c) => {
    try {
      const snapshot = audrey.export();
      return c.json(snapshot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/import
  app.post('/v1/import', async (c) => {
    try {
      const body = await c.req.json();
      await audrey.import(body.snapshot);
      return c.json({ imported: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/forget
  app.post('/v1/forget', async (c) => {
    try {
      const body = await c.req.json();
      const hasId = 'id' in body && body.id;
      const hasQuery = 'query' in body && body.query;

      if (hasId && hasQuery) {
        return c.json({ error: 'Provide exactly one of "id" or "query", not both' }, 400);
      }
      if (!hasId && !hasQuery) {
        return c.json({ error: 'Provide exactly one of "id" or "query"' }, 400);
      }

      if (hasId) {
        const result = audrey.forget(body.id, { purge: body.purge });
        return c.json(result);
      } else {
        const result = await audrey.forgetByQuery(body.query, {
          minSimilarity: body.minSimilarity,
          purge: body.purge,
        });
        if (!result) {
          return c.json({ error: 'No matching memory found' }, 404);
        }
        return c.json(result);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/decay
  app.post('/v1/decay', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = audrey.decay({
        dormantThreshold: (body as Record<string, unknown>).dormantThreshold as number | undefined,
        halfLives: (body as Record<string, unknown>).halfLives as Record<string, number> | undefined,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // GET /v1/status
  app.get('/v1/status', (c) => {
    try {
      const result = audrey.memoryStatus();
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/reflect
  app.post('/v1/reflect', async (c) => {
    try {
      const body = await c.req.json();
      const result = await audrey.reflect(body.turns);
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/greeting
  app.post('/v1/greeting', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await audrey.greeting({ context: (body as Record<string, unknown>).context as string | undefined });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
