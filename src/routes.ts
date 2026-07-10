import { Hono } from 'hono';
import type { Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Audrey } from './audrey.js';
import type { EventOutcome } from './events.js';
import type { PreflightOptions } from './preflight.js';
import type {
  Affect,
  ConsolidationOptions,
  HalfLives,
  MemoryType,
  PublicRetrievalMode,
  RecallOptions,
  RecallResults,
  SourceType,
} from './types.js';
import { VERSION } from '../mcp-server/config.js';
import { requireAgent, resolveMemoryScope } from './utils.js';

class SharedScopeAuthorizationError extends Error {}

// Allowlist of recall option keys safe to accept from untrusted HTTP callers.
// Spreading the request body directly into recall() lets a caller flip
// `includePrivate:true` or swap `confidenceConfig` weights — both bypass
// privacy/integrity controls. Whitelist only, never blacklist.
const SAFE_RECALL_KEYS = new Set([
  'minConfidence',
  'min_confidence',
  'types',
  'limit',
  'includeProvenance',
  'include_provenance',
  'includeDormant',
  'include_dormant',
  'tags',
  'sources',
  'after',
  'before',
  'context',
  'mood',
  'retrieval',
  'scope',
]);

function recallResponse(results: RecallResults): {
  results: Array<RecallResults[number]>;
  partial_failure: boolean;
  errors: RecallResults['errors'];
} {
  return {
    results: Array.from(results),
    partial_failure: results.partialFailure ?? false,
    errors: results.errors ?? [],
  };
}

function sanitizeRecallOptions(raw: unknown): RecallOptions {
  if (!raw || typeof raw !== 'object') return {};
  const opts: RecallOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SAFE_RECALL_KEYS.has(key)) continue;
    if (key === 'minConfidence' || key === 'min_confidence') {
      if (typeof value === 'number') opts.minConfidence = value;
    } else if (key === 'types') {
      if (Array.isArray(value)) opts.types = value as MemoryType[];
    } else if (key === 'limit') {
      if (typeof value === 'number') opts.limit = value;
    } else if (key === 'includeProvenance' || key === 'include_provenance') {
      if (typeof value === 'boolean') opts.includeProvenance = value;
    } else if (key === 'includeDormant' || key === 'include_dormant') {
      if (typeof value === 'boolean') opts.includeDormant = value;
    } else if (key === 'tags' || key === 'sources') {
      if (Array.isArray(value)) (opts as Record<string, unknown>)[key] = value;
    } else if (key === 'after' || key === 'before') {
      if (typeof value === 'string') (opts as Record<string, unknown>)[key] = value;
    } else if (key === 'context') {
      if (value && typeof value === 'object') opts.context = value as Record<string, string>;
    } else if (key === 'mood') {
      if (value && typeof value === 'object') opts.mood = value as RecallOptions['mood'];
    } else if (key === 'retrieval') {
      if (value === 'hybrid' || value === 'vector') opts.retrieval = value as PublicRetrievalMode;
    } else if (key === 'scope') {
      opts.scope = resolveMemoryScope(value, 'agent');
    }
  }
  return opts;
}

export interface AppOptions {
  apiKey?: string;
  adminToolsEnabled?: boolean;
  sharedScopeEnabled?: boolean;
}

function adminToolsEnabled(options: AppOptions): boolean {
  if (options.adminToolsEnabled !== undefined) return options.adminToolsEnabled;
  const value = process.env.AUDREY_ENABLE_ADMIN_TOOLS?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

type RouteBody = {
  content?: string;
  source?: SourceType;
  tags?: string[];
  salience?: number;
  context?: Record<string, string>;
  affect?: Affect;
  private?: boolean;
  action?: string;
  query?: string;
  tool?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  files?: string[];
  strict?: boolean;
  scope?: 'agent' | 'shared';
  agent?: string;
  limit?: number;
  budget_chars?: number;
  budgetChars?: number;
  mode?: PreflightOptions['mode'];
  failure_window_hours?: number;
  recent_failure_window_hours?: number;
  recentFailureWindowHours?: number;
  recent_change_window_hours?: number;
  recentChangeWindowHours?: number;
  include_capsule?: boolean;
  includeCapsule?: boolean;
  include_status?: boolean;
  includeStatus?: boolean;
  record_event?: boolean;
  recordEvent?: boolean;
  include_preflight?: boolean;
  includePreflight?: boolean;
  receipt_id?: string;
  receiptId?: string;
  input?: unknown;
  output?: unknown;
  outcome?: string;
  error_summary?: string;
  errorSummary?: string;
  metadata?: Record<string, unknown>;
  retain_details?: boolean;
  retainDetails?: boolean;
  evidence_feedback?: Record<string, 'used' | 'helpful' | 'wrong'>;
  evidenceFeedback?: Record<string, 'used' | 'helpful' | 'wrong'>;
  include_risks?: boolean;
  includeRisks?: boolean;
  include_contradictions?: boolean;
  includeContradictions?: boolean;
  recall?: unknown;
  id?: string;
  preflight_event_id?: string;
  preflightEventId?: string;
  action_key?: string;
  actionKey?: string;
  evidence_ids?: string[];
  evidenceIds?: string[];
  purge?: boolean;
  minSimilarity?: number;
  snapshot?: unknown;
  contradiction_id?: string;
  turns?: { role: string; content: string }[];
};

type DreamRequestBody = {
  minClusterSize?: number;
  similarityThreshold?: number;
  dormantThreshold?: number;
};
type DecayRequestBody = { dormantThreshold?: number; halfLives?: Partial<HalfLives> };
type GreetingRequestBody = { context?: string };

function actionFromBody(body: RouteBody): unknown {
  return body.action ?? body.query;
}

function preflightOptionsFromBody(
  body: RouteBody,
  agent: string,
  scope: NonNullable<RecallOptions['scope']>,
): PreflightOptions {
  return {
    tool: body.tool,
    sessionId: body.session_id ?? body.sessionId,
    cwd: body.cwd,
    files: body.files,
    strict: body.strict,
    scope,
    limit: body.limit,
    budgetChars: body.budget_chars ?? body.budgetChars,
    mode: body.mode,
    recentFailureWindowHours:
      body.failure_window_hours ??
      body.recent_failure_window_hours ??
      body.recentFailureWindowHours,
    recentChangeWindowHours: body.recent_change_window_hours ?? body.recentChangeWindowHours,
    includeCapsule: body.include_capsule ?? body.includeCapsule,
    includeStatus: body.include_status ?? body.includeStatus,
    recordEvent: body.record_event ?? body.recordEvent,
    agent,
  };
}

function requestAgent(c: Context): string | undefined {
  const value = c.req.header('X-Audrey-Agent');
  return value === undefined ? undefined : requireAgent(value);
}

function authorizedRestScope(
  value: unknown,
  enabled: boolean,
): NonNullable<RecallOptions['scope']> {
  const scope = resolveMemoryScope(value, 'agent');
  if (scope === 'shared' && !enabled) {
    throw new SharedScopeAuthorizationError('Shared memory scope is disabled for this server.');
  }
  return scope;
}

function sharedScopeErrorResponse(c: Context, err: unknown): Response | undefined {
  if (!(err instanceof SharedScopeAuthorizationError)) return undefined;
  return c.json({ error: err.message }, 403);
}

export function createApp(audrey: Audrey, options: AppOptions = {}): Hono {
  const app = new Hono();
  const allowAdminTools = adminToolsEnabled(options);
  const allowSharedScope = options.sharedScopeEnabled ?? allowAdminTools;

  function adminDisabledResponse(c: Context) {
    return c.json(
      {
        error:
          'Admin memory routes are disabled. Set AUDREY_ENABLE_ADMIN_TOOLS=1 to enable export, import, and forget.',
      },
      403,
    );
  }

  // Health check - no auth required.
  // Fields kept for backward compatibility across Audrey client surfaces:
  //   status  / healthy - original TS-era field names (tests/http-api.test.js)
  //   ok      / version - Python SDK HealthResponse contract
  //                       (python/audrey_memory/types.py)
  app.get('/health', c => {
    try {
      const status = audrey.memoryStatus();
      return c.json({
        status: 'ok',
        ok: true,
        healthy: status.healthy,
        version: VERSION,
      });
    } catch {
      return c.json(
        {
          status: 'error',
          ok: false,
          healthy: false,
          version: VERSION,
        },
        500,
      );
    }
  });

  // API key middleware - only if apiKey is configured.
  // Pad the expected value and incoming Authorization header to a fixed
  // capacity buffer before timingSafeEqual so the comparison runs in constant
  // time regardless of header length. The previous (length, then compare)
  // shape leaked the expected key length via response timing on local
  // untrusted callers. Capacity is generous enough (1 KiB) to swallow any
  // realistic Bearer header without truncating, while still small enough to
  // keep the compare cheap.
  if (options.apiKey) {
    const COMPARE_CAPACITY = 1024;
    const padToCapacity = (input: Buffer): Buffer => {
      const out = Buffer.alloc(COMPARE_CAPACITY);
      input.copy(out, 0, 0, Math.min(input.length, COMPARE_CAPACITY));
      return out;
    };
    const expectedPadded = padToCapacity(Buffer.from(`Bearer ${options.apiKey}`, 'utf8'));
    app.use('/v1/*', async (c, next) => {
      const auth = c.req.header('Authorization');
      if (!auth) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const providedPadded = padToCapacity(Buffer.from(auth, 'utf8'));
      if (!timingSafeEqual(providedPadded, expectedPadded)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
  }

  // POST /v1/encode
  app.post('/v1/encode', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const id = await audrey.encode({
        content: body.content as string,
        source: body.source as SourceType,
        agent: requestAgent(c),
        tags: body.tags,
        salience: body.salience,
        context: body.context,
        affect: body.affect,
        private: body.private,
      });
      return c.json({
        id,
        content: body.content,
        source: body.source,
        private: body.private ?? false,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/recall
  app.post('/v1/recall', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const { query, ...rest } = body;
      const options = sanitizeRecallOptions(rest);
      options.scope = authorizedRestScope(options.scope, allowSharedScope);
      options.agent = requestAgent(c) ?? audrey.agent;
      const results = await audrey.recall(query as string, options);
      return c.json(recallResponse(results));
    } catch (err: unknown) {
      const denied = sharedScopeErrorResponse(c, err);
      if (denied) return denied;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/validate — closed-loop feedback. Agents tell Audrey how a
  // recalled memory played out (used | helpful | wrong) and Audrey nudges
  // salience + retrieval bookkeeping accordingly.
  app.post('/v1/validate', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const id = typeof body.id === 'string' ? body.id : null;
      if (!id) return c.json({ error: 'id is required' }, 400);
      const outcome =
        body.outcome === 'used' || body.outcome === 'helpful' || body.outcome === 'wrong'
          ? body.outcome
          : 'used';
      const preflightEventId =
        typeof body.preflight_event_id === 'string'
          ? body.preflight_event_id
          : typeof body.preflightEventId === 'string'
            ? body.preflightEventId
            : undefined;
      const actionKey =
        typeof body.action_key === 'string'
          ? body.action_key
          : typeof body.actionKey === 'string'
            ? body.actionKey
            : undefined;
      const evidenceIds = Array.isArray(body.evidence_ids)
        ? body.evidence_ids.filter((value: unknown): value is string => typeof value === 'string')
        : Array.isArray(body.evidenceIds)
          ? body.evidenceIds.filter((value: unknown): value is string => typeof value === 'string')
          : undefined;
      const result = audrey.validate({
        id,
        outcome,
        agent: requestAgent(c) ?? audrey.agent,
        preflightEventId,
        actionKey,
        evidenceIds,
      });
      if (!result) return c.json({ ok: false, error: `no memory with id ${id}` }, 404);
      return c.json({ ok: true, ...result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
          ? (err as { code: string }).code
          : undefined;
      return c.json(code ? { error: message, code } : { error: message }, 400);
    }
  });

  // Legacy alias for the Python client's mark_used() — defaults outcome to "used".
  app.post('/v1/mark-used', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const id = typeof body.id === 'string' ? body.id : null;
      if (!id) return c.json({ error: 'id is required' }, 400);
      const result = audrey.validate({
        id,
        outcome: 'used',
        agent: requestAgent(c) ?? audrey.agent,
      });
      if (!result) return c.json({ ok: false, error: `no memory with id ${id}` }, 404);
      return c.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/capsule
  app.post('/v1/capsule', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      if (typeof body.query !== 'string' || body.query.trim().length === 0) {
        return c.json({ error: 'query must be a non-empty string' }, 400);
      }

      const scope = authorizedRestScope(body.scope, allowSharedScope);
      const result = await audrey.capsule(body.query, {
        limit: body.limit,
        budgetChars: body.budget_chars ?? body.budgetChars,
        mode: body.mode,
        recentChangeWindowHours: body.recent_change_window_hours ?? body.recentChangeWindowHours,
        includeRisks: body.include_risks ?? body.includeRisks,
        includeContradictions: body.include_contradictions ?? body.includeContradictions,
        scope,
        agent: requestAgent(c) ?? audrey.agent,
        recall: sanitizeRecallOptions(body.recall),
      });
      return c.json(result);
    } catch (err: unknown) {
      const denied = sharedScopeErrorResponse(c, err);
      if (denied) return denied;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/preflight
  app.post('/v1/preflight', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const action = actionFromBody(body);
      if (typeof action !== 'string' || action.trim().length === 0) {
        return c.json({ error: 'action must be a non-empty string' }, 400);
      }

      const scope = authorizedRestScope(body.scope, allowSharedScope);
      const result = await audrey.preflight(
        action,
        preflightOptionsFromBody(body, requestAgent(c) ?? audrey.agent, scope),
      );
      return c.json(result);
    } catch (err: unknown) {
      const denied = sharedScopeErrorResponse(c, err);
      if (denied) return denied;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/reflexes
  app.post('/v1/reflexes', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const action = actionFromBody(body);
      if (typeof action !== 'string' || action.trim().length === 0) {
        return c.json({ error: 'action must be a non-empty string' }, 400);
      }

      const scope = authorizedRestScope(body.scope, allowSharedScope);
      const result = await audrey.reflexes(action, {
        ...preflightOptionsFromBody(body, requestAgent(c) ?? audrey.agent, scope),
        includePreflight: body.include_preflight ?? body.includePreflight,
      });
      return c.json(result);
    } catch (err: unknown) {
      const denied = sharedScopeErrorResponse(c, err);
      if (denied) return denied;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/guard/before
  app.post('/v1/guard/before', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const action = actionFromBody(body);
      if (typeof action !== 'string' || action.trim().length === 0) {
        return c.json({ error: 'action must be a non-empty string' }, 400);
      }

      const scope = authorizedRestScope(body.scope, allowSharedScope);
      const result = await audrey.beforeAction(action, {
        ...preflightOptionsFromBody(body, requestAgent(c) ?? audrey.agent, scope),
        recordEvent: true,
      });
      return c.json(result);
    } catch (err: unknown) {
      const denied = sharedScopeErrorResponse(c, err);
      if (denied) return denied;
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/guard/after
  app.post('/v1/guard/after', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const receiptId = body.receipt_id ?? body.receiptId;
      if (typeof receiptId !== 'string' || receiptId.trim().length === 0) {
        return c.json({ error: 'receiptId is required' }, 400);
      }

      const result = audrey.afterAction({
        receiptId,
        tool: body.tool,
        sessionId: body.session_id ?? body.sessionId,
        input: body.input,
        output: body.output,
        outcome: body.outcome as EventOutcome | undefined,
        errorSummary: body.error_summary ?? body.errorSummary,
        cwd: body.cwd,
        files: body.files,
        metadata: body.metadata,
        retainDetails: body.retain_details ?? body.retainDetails,
        evidenceFeedback: body.evidence_feedback ?? body.evidenceFeedback,
        actorAgent: requestAgent(c),
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/guard receipt not found/i.test(message)) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/consolidate
  app.post('/v1/consolidate', async c => {
    try {
      const body = await c.req
        .json<Partial<ConsolidationOptions>>()
        .catch((): Partial<ConsolidationOptions> => ({}));
      const result = await audrey.consolidate({ ...body, agent: requestAgent(c) ?? audrey.agent });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/dream
  app.post('/v1/dream', async c => {
    try {
      const body = await c.req.json<DreamRequestBody>().catch((): DreamRequestBody => ({}));
      const result = await audrey.dream({ ...body, agent: requestAgent(c) ?? audrey.agent });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/v1/introspect', c => {
    try {
      const result = audrey.introspect();
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // GET /v1/impact — closed-loop visibility surface. Mirrors `audrey impact`
  // and Audrey.impact(). Bounds windowDays (1..365) and limit (1..100) so
  // unbounded inputs can't drag the report into a multi-second SQL scan.
  app.get('/v1/impact', c => {
    try {
      const windowRaw = c.req.query('windowDays') ?? c.req.query('window_days');
      const limitRaw = c.req.query('limit');
      const windowDays = windowRaw ? Number.parseInt(windowRaw, 10) : 7;
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 5;
      if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 365) {
        return c.json({ error: 'windowDays must be between 1 and 365' }, 400);
      }
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
        return c.json({ error: 'limit must be between 1 and 100' }, 400);
      }
      return c.json(audrey.impact({ windowDays, limit, agent: requestAgent(c) ?? audrey.agent }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/resolve-truth
  app.post('/v1/resolve-truth', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const result = await audrey.resolveTruth(body.contradiction_id as string, {
        agent: requestAgent(c) ?? audrey.agent,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.get('/v1/export', c => {
    if (!allowAdminTools) return adminDisabledResponse(c);
    try {
      const snapshot = audrey.export();
      return c.json(snapshot);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/import
  app.post('/v1/import', async c => {
    if (!allowAdminTools) return adminDisabledResponse(c);
    try {
      const body = await c.req.json<RouteBody>();
      await audrey.import(body.snapshot);
      return c.json({ imported: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/forget
  app.post('/v1/forget', async c => {
    if (!allowAdminTools) return adminDisabledResponse(c);
    try {
      const body = await c.req.json<RouteBody>();
      const hasId = 'id' in body && body.id;
      const hasQuery = 'query' in body && body.query;

      if (hasId && hasQuery) {
        return c.json({ error: 'Provide exactly one of "id" or "query", not both' }, 400);
      }
      if (!hasId && !hasQuery) {
        return c.json({ error: 'Provide exactly one of "id" or "query"' }, 400);
      }

      if (hasId) {
        const result = audrey.forget(body.id as string, { purge: body.purge });
        return c.json(result);
      } else {
        const result = await audrey.forgetByQuery(body.query as string, {
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
  app.post('/v1/decay', async c => {
    try {
      const body = await c.req.json<DecayRequestBody>().catch((): DecayRequestBody => ({}));
      const result = audrey.decay({
        dormantThreshold: body.dormantThreshold,
        halfLives: body.halfLives,
        agent: requestAgent(c) ?? audrey.agent,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get('/v1/status', c => {
    try {
      const result = audrey.memoryStatus();
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // POST /v1/reflect
  app.post('/v1/reflect', async c => {
    try {
      const body = await c.req.json<RouteBody>();
      const result = await audrey.reflect(body.turns as { role: string; content: string }[]);
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // POST /v1/greeting
  app.post('/v1/greeting', async c => {
    try {
      const body = await c.req.json<GreetingRequestBody>().catch((): GreetingRequestBody => ({}));
      const result = await audrey.greeting({
        context: body.context,
        agent: requestAgent(c) ?? audrey.agent,
      });
      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
