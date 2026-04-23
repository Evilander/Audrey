#!/usr/bin/env node
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Audrey } from '../src/index.js';
import { readStoredDimensions } from '../src/db.js';
import type { AudreyConfig, EmbeddingProvider, IntrospectResult, MemoryStatusResult } from '../src/types.js';
import {
  VERSION,
  SERVER_NAME,
  buildAudreyConfig,
  buildInstallArgs,
  resolveDataDir,
  resolveEmbeddingProvider,
  resolveLLMProvider,
} from './config.js';

const VALID_SOURCES = {
  'direct-observation': 'direct-observation',
  'told-by-user': 'told-by-user',
  'tool-result': 'tool-result',
  'inference': 'inference',
  'model-generated': 'model-generated',
} as const;

const VALID_TYPES = {
  'episodic': 'episodic',
  'semantic': 'semantic',
  'procedural': 'procedural',
} as const;

export const MAX_MEMORY_CONTENT_LENGTH = 50_000;

const subcommand = process.argv[2];

function isNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateMemoryContent(content: string): void {
  if (!isNonEmptyText(content)) {
    throw new Error('content must be a non-empty string');
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`content exceeds maximum length of ${MAX_MEMORY_CONTENT_LENGTH} characters`);
  }
}

export function validateForgetSelection(id?: string, query?: string): void {
  if ((id && query) || (!id && !query)) {
    throw new Error('Provide exactly one of id or query');
  }
}

export async function initializeEmbeddingProvider(provider: EmbeddingProvider): Promise<void> {
  if (provider && typeof provider.ready === 'function') {
    await provider.ready();
  }
}

export const memoryEncodeToolSchema = {
  content: z.string()
    .max(MAX_MEMORY_CONTENT_LENGTH)
    .refine(isNonEmptyText, 'Content must not be empty')
    .describe('The memory content to encode'),
  source: z.enum(VALID_SOURCES).describe('Source type of the memory'),
  tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
  salience: z.number().min(0).max(1).optional().describe('Importance weight 0-1'),
  context: z.record(z.string(), z.string()).optional().describe('Situational context as key-value pairs (e.g., {task: "debugging", domain: "payments"})'),
  affect: z.object({
    valence: z.number().min(-1).max(1).describe('Emotional valence: -1 (very negative) to 1 (very positive)'),
    arousal: z.number().min(0).max(1).optional().describe('Emotional arousal: 0 (calm) to 1 (highly activated)'),
    label: z.string().optional().describe('Human-readable emotion label (e.g., "curiosity", "frustration", "relief")'),
  }).optional().describe('Emotional affect - how this memory feels'),
  private: z.boolean().optional().describe('If true, memory is only visible to the AI and excluded from public recall results'),
};

export const memoryRecallToolSchema = {
  query: z.string().describe('Search query to match against memories'),
  limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
  types: z.array(z.enum(VALID_TYPES)).optional().describe('Memory types to search'),
  min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
  tags: z.array(z.string()).optional().describe('Only return episodic memories with these tags'),
  sources: z.array(z.enum(VALID_SOURCES)).optional().describe('Only return episodic memories from these sources'),
  after: z.string().optional().describe('Only return memories created after this ISO date'),
  before: z.string().optional().describe('Only return memories created before this ISO date'),
  context: z.record(z.string(), z.string()).optional().describe('Retrieval context - memories encoded in matching context get boosted'),
  mood: z.object({
    valence: z.number().min(-1).max(1).describe('Current emotional valence: -1 (negative) to 1 (positive)'),
    arousal: z.number().min(0).max(1).optional().describe('Current arousal: 0 (calm) to 1 (activated)'),
  }).optional().describe('Current mood - boosts recall of memories encoded in similar emotional state'),
};

export const memoryImportToolSchema = {
  snapshot: z.object({
    version: z.string(),
    episodes: z.array(z.any()),
    semantics: z.array(z.any()).optional(),
    procedures: z.array(z.any()).optional(),
    causalLinks: z.array(z.any()).optional(),
    contradictions: z.array(z.any()).optional(),
    consolidationRuns: z.array(z.any()).optional(),
    consolidationMetrics: z.array(z.any()).optional(),
    config: z.record(z.string(), z.string()).optional(),
  }).passthrough().describe('A snapshot from memory_export'),
};

export const memoryForgetToolSchema = {
  id: z.string().optional().describe('ID of the memory to forget'),
  query: z.string().optional().describe('Semantic query to find and forget the closest matching memory'),
  min_similarity: z.number().min(0).max(1).optional().describe('Minimum similarity for query-based forget (default 0.9)'),
  purge: z.boolean().optional().describe('Hard-delete the memory permanently (default false, soft-delete)'),
};

// ---------------------------------------------------------------------------
// Local interface for status reporting
// ---------------------------------------------------------------------------

interface StatusReport {
  generatedAt: string;
  registered: boolean;
  dataDir: string;
  exists: boolean;
  storedDimensions: number | null;
  stats: IntrospectResult | null;
  health: MemoryStatusResult | null;
  lastConsolidation: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// CLI subcommands
// ---------------------------------------------------------------------------

async function serveHttp(): Promise<void> {
  const { startServer } = await import('../src/server.js');
  const config = buildAudreyConfig();
  const port = parseInt(process.env.AUDREY_PORT || '7437', 10);
  const apiKey = process.env.AUDREY_API_KEY;

  const server = await startServer({ port, config, apiKey });
  console.error(`[audrey-http] v${VERSION} serving on port ${server.port}`);
  if (apiKey) {
    console.error('[audrey-http] API key authentication enabled');
  }
}

async function reembed(): Promise<void> {
  const dataDir = resolveDataDir(process.env);
  const explicit = process.env['AUDREY_EMBEDDING_PROVIDER'];
  const embedding = resolveEmbeddingProvider(process.env, explicit);
  const storedDims = readStoredDimensions(dataDir);
  const dimensionsChanged = storedDims !== null && storedDims !== embedding.dimensions;

  console.log(`Re-embedding with ${embedding.provider} (${embedding.dimensions}d)...`);
  if (dimensionsChanged) {
    console.log(`Dimension change: ${storedDims}d -> ${embedding.dimensions}d (will drop and recreate vec tables)`);
  }

  const audrey = new Audrey({ dataDir, agent: 'reembed', embedding });
  try {
    await initializeEmbeddingProvider(audrey.embeddingProvider);
    const { reembedAll } = await import('../src/migrate.js');
    const counts = await reembedAll(audrey.db, audrey.embeddingProvider, { dropAndRecreate: dimensionsChanged });
    console.log(`Done. Re-embedded: ${counts.episodes} episodes, ${counts.semantics} semantics, ${counts.procedures} procedures`);
  } finally {
    audrey.close();
  }
}

async function dream(): Promise<void> {
  const dataDir = resolveDataDir(process.env);
  const explicit = process.env['AUDREY_EMBEDDING_PROVIDER'];
  const embedding = resolveEmbeddingProvider(process.env, explicit);
  const storedDims = readStoredDimensions(dataDir);

  const config: AudreyConfig = {
    dataDir,
    agent: 'dream',
    embedding,
  };

  const llm = resolveLLMProvider(process.env, process.env['AUDREY_LLM_PROVIDER']);
  if (llm) config.llm = llm as AudreyConfig['llm'];

  const audrey = new Audrey(config);
  try {
    await initializeEmbeddingProvider(audrey.embeddingProvider);

    const embeddingLabel = storedDims !== null && storedDims !== embedding.dimensions
      ? `${embedding.provider} (${embedding.dimensions}d; stored ${storedDims}d)`
      : `${embedding.provider} (${embedding.dimensions}d)`;

    console.log('[audrey] Starting dream cycle...');
    console.log(`[audrey] Embedding: ${embeddingLabel}`);

    const result = await audrey.dream();
    const health = audrey.memoryStatus();

    console.log(
      `[audrey] Consolidation: evaluated ${result.consolidation.episodesEvaluated} episodes, `
      + `found ${result.consolidation.clustersFound} clusters, extracted ${result.consolidation.principlesExtracted} principles `
      + `(${result.consolidation.semanticsCreated ?? 0} semantic, ${result.consolidation.proceduresCreated ?? 0} procedural)`
    );
    console.log(
      `[audrey] Decay: evaluated ${result.decay.totalEvaluated} memories, `
      + `${result.decay.transitionedToDormant} transitioned to dormant`
    );
    console.log(
      `[audrey] Final: ${result.stats.episodic} episodic, ${result.stats.semantic} semantic, ${result.stats.procedural} procedural `
      + `| ${health.healthy ? 'healthy' : 'unhealthy'}`
    );
    console.log('[audrey] Dream complete.');
  } finally {
    audrey.close();
  }
}

async function greeting(): Promise<void> {
  const dataDir = resolveDataDir(process.env);
  const contextArg = process.argv[3] || undefined;

  if (!existsSync(dataDir)) {
    console.log('[audrey] No data yet - fresh start.');
    return;
  }

  const storedDimensions = readStoredDimensions(dataDir);
  const resolvedEmbedding = resolveEmbeddingProvider(process.env, process.env['AUDREY_EMBEDDING_PROVIDER']);
  const canUseResolvedEmbedding = Boolean(contextArg)
    && storedDimensions !== null
    && storedDimensions === resolvedEmbedding.dimensions;
  const dimensions = storedDimensions || resolvedEmbedding.dimensions || 8;
  const audrey = new Audrey({
    dataDir,
    agent: 'greeting',
    embedding: canUseResolvedEmbedding
      ? resolvedEmbedding
      : { provider: 'mock' as const, dimensions },
  });

  try {
    if (canUseResolvedEmbedding) {
      await initializeEmbeddingProvider(audrey.embeddingProvider);
    }
    const result = await audrey.greeting({ context: canUseResolvedEmbedding ? contextArg : undefined });
    const health = audrey.memoryStatus();

    const lines: string[] = [];
    lines.push(`[Audrey v${VERSION}] Memory briefing`);
    lines.push('');

    if (contextArg && !canUseResolvedEmbedding) {
      lines.push(
        `Context recall skipped: stored index is ${storedDimensions ?? 'unknown'}d `
        + `but current embedding config resolves to ${resolvedEmbedding.dimensions}d.`
      );
      lines.push('');
    }

    // Mood
    if (result.mood && result.mood.samples > 0) {
      const v = result.mood.valence;
      const moodWord = v > 0.3 ? 'positive' : v < -0.3 ? 'negative' : 'neutral';
      lines.push(`Mood: ${moodWord} (valence=${v.toFixed(2)}, arousal=${result.mood.arousal.toFixed(2)}, from ${result.mood.samples} recent memories)`);
    }

    // Health
    const stats = audrey.introspect();
    lines.push(`Memory: ${stats.episodic} episodic, ${stats.semantic} semantic, ${stats.procedural} procedural | ${health.healthy ? 'healthy' : 'needs attention'}`);
    lines.push('');

    // Principles (semantic memories)
    if (result.principles?.length > 0) {
      lines.push('Learned principles:');
      for (const p of result.principles) {
        lines.push(`  - ${p.content}`);
      }
      lines.push('');
    }

    // Identity (private memories)
    if (result.identity?.length > 0) {
      lines.push('Identity:');
      for (const m of result.identity) {
        lines.push(`  - ${m.content}`);
      }
      lines.push('');
    }

    // Recent memories
    if (result.recent?.length > 0) {
      lines.push('Recent memories:');
      for (const r of result.recent) {
        const age = timeSince(r.created_at);
        lines.push(`  - [${age}] ${r.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    // Unresolved
    if (result.unresolved?.length > 0) {
      lines.push('Unresolved threads:');
      for (const u of result.unresolved) {
        lines.push(`  - ${u.content.slice(0, 150)}`);
      }
      lines.push('');
    }

    // Contextual recall
    if ((result.contextual?.length ?? 0) > 0) {
      lines.push(`Context-relevant memories (query: "${contextArg}"):`);
      for (const c of result.contextual!) {
        lines.push(`  - [${c.type}] ${c.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    console.log(lines.join('\n'));
  } finally {
    audrey.close();
  }
}

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function reflect(): Promise<void> {
  const dataDir = resolveDataDir(process.env);
  const explicit = process.env['AUDREY_EMBEDDING_PROVIDER'];
  const embedding = resolveEmbeddingProvider(process.env, explicit);

  const config: AudreyConfig = {
    dataDir,
    agent: 'reflect',
    embedding,
  };

  const llm = resolveLLMProvider(process.env, process.env['AUDREY_LLM_PROVIDER']);
  if (llm) config.llm = llm as AudreyConfig['llm'];

  const audrey = new Audrey(config);
  try {
    await initializeEmbeddingProvider(audrey.embeddingProvider);

    // Read conversation turns from stdin if available
    let turns: unknown[] | null = null;
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw) {
        try {
          turns = JSON.parse(raw) as unknown[];
        } catch {
          console.error('[audrey] Could not parse stdin as JSON turns, skipping reflect.');
        }
      }
    }

    if (turns && Array.isArray(turns) && turns.length > 0) {
      console.log(`[audrey] Reflecting on ${turns.length} conversation turns...`);
      const reflectResult = await audrey.reflect(turns as Array<{ role: string; content: string }>);
      if (reflectResult.skipped) {
        console.log(`[audrey] Reflect skipped: ${reflectResult.skipped}`);
      } else {
        console.log(`[audrey] Reflected: encoded ${reflectResult.encoded} lasting memories.`);
      }
    }

    // Always run dream cycle after reflect
    console.log('[audrey] Starting dream cycle...');
    const result = await audrey.dream();
    console.log(
      `[audrey] Consolidation: ${result.consolidation.episodesEvaluated} episodes evaluated, `
      + `${result.consolidation.clustersFound} clusters, ${result.consolidation.principlesExtracted} principles`
    );
    console.log(
      `[audrey] Decay: ${result.decay.totalEvaluated} evaluated, `
      + `${result.decay.transitionedToDormant} dormant`
    );
    console.log(
      `[audrey] Status: ${result.stats.episodic} episodic, ${result.stats.semantic} semantic, `
      + `${result.stats.procedural} procedural`
    );
    console.log('[audrey] Dream complete.');
  } finally {
    audrey.close();
  }
}

function install(): void {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('Error: claude CLI not found. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  const dataDir = resolveDataDir(process.env);
  const resolvedEmbedding = resolveEmbeddingProvider(process.env, process.env['AUDREY_EMBEDDING_PROVIDER']);
  const resolvedLlm = resolveLLMProvider(process.env, process.env['AUDREY_LLM_PROVIDER']);
  if (resolvedEmbedding.provider === 'gemini') {
    console.log('Using Gemini embeddings (3072d)');
  } else if (resolvedEmbedding.provider === 'local') {
    console.log(`Using local embeddings (384d, device=${resolvedEmbedding.device || 'gpu'})`);
  } else if (resolvedEmbedding.provider === 'openai') {
    console.log('Using OpenAI embeddings (1536d)');
  } else if (resolvedEmbedding.provider === 'mock') {
    console.log('Using mock embeddings');
  }

  if (resolvedLlm?.provider === 'anthropic') {
    console.log('Using Anthropic for LLM-powered consolidation, contradiction detection, and reflection');
  } else if (resolvedLlm?.provider === 'openai') {
    console.log('Using OpenAI for LLM-powered consolidation, contradiction detection, and reflection');
  } else if (resolvedLlm?.provider === 'mock') {
    console.log('Using mock LLM provider');
  } else {
    console.log('No LLM provider configured - consolidation and contradiction detection will use heuristics');
  }

  try {
    execFileSync('claude', ['mcp', 'remove', SERVER_NAME], { stdio: 'ignore' });
  } catch {
    // Not registered yet.
  }

  const args = buildInstallArgs(process.env);
  try {
    execFileSync('claude', args, { stdio: 'inherit' });
  } catch {
    console.error('Failed to register MCP server. Is Claude Code installed and on your PATH?');
    process.exit(1);
  }

  console.log(`
Audrey registered as "${SERVER_NAME}" with Claude Code.

13 MCP tools available in every session:
  memory_encode        - Store observations, facts, preferences
  memory_recall        - Search memories by semantic similarity
  memory_consolidate   - Extract principles from accumulated episodes
  memory_dream         - Full sleep cycle: consolidate + decay + stats
  memory_introspect    - Check memory system health
  memory_resolve_truth - Resolve contradictions between claims
  memory_export        - Export all memories as JSON snapshot
  memory_import        - Import a snapshot into a fresh database
  memory_forget        - Forget a specific memory by ID or query
  memory_decay         - Apply forgetting curves, transition low-confidence to dormant
  memory_status        - Check brain health (episode/vec sync, dimensions)
  memory_reflect       - Form lasting memories from a conversation
  memory_greeting      - Wake up as yourself: load identity, context, mood

CLI subcommands:
  npx audrey install   - Register MCP server with Claude Code
  npx audrey uninstall - Remove MCP server registration
  npx audrey status    - Show memory store health and stats
  npx audrey status --json - Emit machine-readable health output
  npx audrey status --json --fail-on-unhealthy - Exit non-zero on unhealthy status
  npx audrey greeting  - Output session briefing (for hooks)
  npx audrey reflect   - Reflect on conversation + dream cycle (for hooks)
  npx audrey dream     - Run consolidation + decay cycle
  npx audrey reembed   - Re-embed all memories with current provider

Data stored in: ${dataDir}
Verify: claude mcp list
`);
}

function uninstall(): void {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('Error: claude CLI not found.');
    process.exit(1);
  }

  try {
    execFileSync('claude', ['mcp', 'remove', SERVER_NAME], { stdio: 'inherit' });
    console.log(`Removed "${SERVER_NAME}" from Claude Code.`);
  } catch {
    console.error(`Failed to remove "${SERVER_NAME}". It may not be registered.`);
    process.exit(1);
  }
}

function cliHasFlag(flag: string, argv: string[] = process.argv): boolean {
  return Array.isArray(argv) && argv.includes(flag);
}

export function buildStatusReport({
  dataDir = resolveDataDir(process.env),
  claudeJsonPath = join(homedir(), '.claude.json'),
}: { dataDir?: string; claudeJsonPath?: string } = {}): StatusReport {
  let registered = false;
  try {
    const claudeConfig = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    registered = SERVER_NAME in (claudeConfig.mcpServers || {});
  } catch {
    // Ignore unreadable config.
  }

  const report: StatusReport = {
    generatedAt: new Date().toISOString(),
    registered,
    dataDir,
    exists: existsSync(dataDir),
    storedDimensions: null,
    stats: null,
    health: null,
    lastConsolidation: null,
    error: null,
  };

  if (!report.exists) {
    return report;
  }

  try {
    report.storedDimensions = readStoredDimensions(dataDir);
    const dimensions = report.storedDimensions || 8;
    const audrey = new Audrey({
      dataDir,
      agent: 'status-check',
      embedding: { provider: 'mock', dimensions },
    });
    report.stats = audrey.introspect();
    report.health = audrey.memoryStatus();
    report.lastConsolidation = (audrey.db.prepare(`
      SELECT completed_at FROM consolidation_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `).get() as { completed_at?: string } | undefined)?.completed_at ?? 'never';
    audrey.close();
  } catch (err) {
    report.error = (err as Error).message || String(err);
  }

  return report;
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Registration: ${report.registered ? 'active' : 'not registered'}`);

  if (!report.exists) {
    lines.push(`Data directory: ${report.dataDir} (not yet created - will be created on first use)`);
    return lines.join('\n');
  }

  if (report.error) {
    lines.push(`Data directory: ${report.dataDir} (exists but could not read: ${report.error})`);
    return lines.join('\n');
  }

  lines.push(`Data directory: ${report.dataDir}`);
  lines.push(`Stored dimensions: ${report.storedDimensions ?? 'unknown'}`);
  lines.push(
    `Memories: ${report.stats!.episodic} episodic, ${report.stats!.semantic} semantic, ${report.stats!.procedural} procedural`
  );
  lines.push(
    `Index sync: ${report.health!.vec_episodes}/${report.health!.searchable_episodes} episodic, `
    + `${report.health!.vec_semantics}/${report.health!.searchable_semantics} semantic, `
    + `${report.health!.vec_procedures}/${report.health!.searchable_procedures} procedural`
  );
  lines.push(
    `Health: ${report.health!.healthy ? 'healthy' : 'unhealthy'}`
    + `${report.health!.reembed_recommended ? ' (re-embed recommended)' : ''}`
  );
  lines.push(`Dormant: ${report.stats!.dormant}`);
  lines.push(`Causal links: ${report.stats!.causalLinks}`);
  lines.push(`Contradictions: ${report.stats!.contradictions.open} open, ${report.stats!.contradictions.resolved} resolved`);
  lines.push(`Consolidation runs: ${report.stats!.totalConsolidationRuns}`);
  lines.push(`Last consolidation: ${report.lastConsolidation}`);

  return lines.join('\n');
}

export function runStatusCommand({
  argv = process.argv,
  dataDir = resolveDataDir(process.env),
  claudeJsonPath = join(homedir(), '.claude.json'),
  out = console.log,
}: {
  argv?: string[];
  dataDir?: string;
  claudeJsonPath?: string;
  out?: (...args: unknown[]) => void;
} = {}): { report: StatusReport; exitCode: number } {
  const report = buildStatusReport({ dataDir, claudeJsonPath });
  if (cliHasFlag('--json', argv)) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(formatStatusReport(report));
  }

  const exitCode = report.error
    || (cliHasFlag('--fail-on-unhealthy', argv) && report.exists && report.health && !report.health.healthy)
    ? 1
    : 0;

  return { report, exitCode };
}

function status(): void {
  const { exitCode } = runStatusCommand();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function toolError(err: unknown): { isError: boolean; content: Array<{ type: 'text'; text: string }> } {
  return { isError: true, content: [{ type: 'text' as const, text: `Error: ${(err as Error).message || String(err)}` }] };
}

export function registerShutdownHandlers(
  processRef: NodeJS.Process,
  audrey: Audrey,
  logger: (...args: unknown[]) => void = console.error,
): (message?: string, exitCode?: number) => void {
  let closed = false;

  const shutdown = (message?: string, exitCode = 0): void => {
    if (message) {
      logger(message);
    }
    if (!closed) {
      closed = true;
      try {
        audrey.close();
      } catch (err) {
        logger(`[audrey-mcp] shutdown error: ${(err as Error).message || String(err)}`);
        exitCode = exitCode === 0 ? 1 : exitCode;
      }
    }
    if (typeof processRef.exit === 'function') {
      processRef.exit(exitCode);
    }
  };

  processRef.once('SIGINT', () => shutdown('[audrey-mcp] received SIGINT, shutting down'));
  processRef.once('SIGTERM', () => shutdown('[audrey-mcp] received SIGTERM, shutting down'));
  processRef.once('SIGHUP', () => shutdown('[audrey-mcp] received SIGHUP, shutting down'));
  processRef.once('uncaughtException', (err: Error) => {
    logger('[audrey-mcp] uncaught exception:', err);
    shutdown(undefined, 1);
  });
  processRef.once('unhandledRejection', (reason: unknown) => {
    logger('[audrey-mcp] unhandled rejection:', reason);
    shutdown(undefined, 1);
  });

  return shutdown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerDreamTool(server: any, audrey: Audrey): void {
  server.tool(
    'memory_dream',
    {
      min_cluster_size: z.number().optional().describe('Minimum episodes per cluster (default 3)'),
      similarity_threshold: z.number().optional().describe('Similarity threshold for clustering (default 0.85)'),
      dormant_threshold: z.number().min(0).max(1).optional().describe('Confidence below which memories go dormant (default 0.1)'),
    },
    async ({ min_cluster_size, similarity_threshold, dormant_threshold }: {
      min_cluster_size?: number;
      similarity_threshold?: number;
      dormant_threshold?: number;
    }) => {
      try {
        const result = await audrey.dream({
          minClusterSize: min_cluster_size,
          similarityThreshold: similarity_threshold,
          dormantThreshold: dormant_threshold,
        });
        return toolResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

async function main(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const config = buildAudreyConfig();
  const audrey = new Audrey(config);

  const embLabel = config.embedding?.provider === 'mock'
    ? 'mock embeddings - set OPENAI_API_KEY for real semantic search'
    : `${config.embedding?.provider} embeddings (${config.embedding?.dimensions}d)`;
  console.error(`[audrey-mcp] v${VERSION} started - agent=${config.agent} dataDir=${config.dataDir} (${embLabel})`);

  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });

  server.tool('memory_encode', memoryEncodeToolSchema, async ({ content, source, tags, salience, private: isPrivate, context, affect }) => {
    try {
      validateMemoryContent(content);
      const id = await audrey.encode({ content, source, tags, salience, private: isPrivate, context, affect });
      return toolResult({ id, content, source, private: isPrivate ?? false });
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_recall', memoryRecallToolSchema, async ({ query, limit, types, min_confidence, tags, sources, after, before, context, mood }) => {
    try {
      const results = await audrey.recall(query, {
        limit: limit ?? 10,
        types,
        minConfidence: min_confidence,
        tags,
        sources,
        after,
        before,
        context,
        mood,
      });
      return toolResult(results);
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_consolidate', {
    min_cluster_size: z.number().optional().describe('Minimum episodes per cluster'),
    similarity_threshold: z.number().optional().describe('Similarity threshold for clustering'),
  }, async ({ min_cluster_size, similarity_threshold }) => {
    try {
      const consolidation = await audrey.consolidate({
        minClusterSize: min_cluster_size,
        similarityThreshold: similarity_threshold,
      });
      return toolResult(consolidation);
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_introspect', {}, async () => {
    try {
      return toolResult(audrey.introspect());
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_resolve_truth', {
    contradiction_id: z.string().describe('ID of the contradiction to resolve'),
  }, async ({ contradiction_id }) => {
    try {
      return toolResult(await audrey.resolveTruth(contradiction_id));
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_export', {}, async () => {
    try {
      return toolResult(audrey.export());
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_import', memoryImportToolSchema, async ({ snapshot }) => {
    try {
      await audrey.import(snapshot as Parameters<typeof audrey.import>[0]);
      return toolResult({ imported: true, stats: audrey.introspect() });
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_forget', memoryForgetToolSchema, async ({ id, query, min_similarity, purge }) => {
    try {
      validateForgetSelection(id, query);
      let result;
      if (id) {
        result = audrey.forget(id, { purge: purge ?? false });
      } else {
        result = await audrey.forgetByQuery(query!, {
          minSimilarity: min_similarity ?? 0.9,
          purge: purge ?? false,
        });
        if (!result) {
          return toolResult({ forgotten: false, reason: 'No memory found above similarity threshold' });
        }
      }
      return toolResult({ forgotten: true, ...result });
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_decay', {
    dormant_threshold: z.number().min(0).max(1).optional().describe('Confidence below which memories go dormant (default 0.1)'),
  }, async ({ dormant_threshold }) => {
    try {
      return toolResult(audrey.decay({ dormantThreshold: dormant_threshold }));
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_status', {}, async () => {
    try {
      return toolResult(audrey.memoryStatus());
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_reflect', {
    turns: z.array(z.object({
      role: z.string().describe('Message role: user or assistant'),
      content: z.string().describe('Message content'),
    })).describe('Conversation turns to reflect on. Call at end of meaningful conversations to form lasting memories.'),
  }, async ({ turns }) => {
    try {
      return toolResult(await audrey.reflect(turns));
    } catch (err) {
      return toolError(err);
    }
  });

  registerDreamTool(server, audrey);

  server.tool('memory_greeting', {
    context: z.string().optional().describe('Optional hint about this session (e.g. "working on authentication feature"). If provided, also returns semantically relevant memories.'),
  }, async ({ context }) => {
    try {
      return toolResult(await audrey.greeting({ context }));
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_observe_tool', {
    event: z.string().describe('Hook event name (PreToolUse, PostToolUse, PostToolUseFailure, PreCompact, PostCompact, etc.)'),
    tool: z.string().describe('Tool name being observed (Bash, Edit, Write, etc.)'),
    session_id: z.string().optional().describe('Session identifier for grouping related events'),
    input: z.unknown().optional().describe('Tool input. Hashed and never stored raw; redacted + summarized into metadata only when retain_details is true.'),
    output: z.unknown().optional().describe('Tool output. Same redaction and storage policy as input.'),
    outcome: z.enum(['succeeded', 'failed', 'blocked', 'skipped', 'unknown']).optional().describe('Outcome classification'),
    error_summary: z.string().optional().describe('Short error description if the tool failed. Redacted and truncated to 2 KB.'),
    cwd: z.string().optional().describe('Working directory at the time of the tool call'),
    files: z.array(z.string()).optional().describe('File paths to fingerprint (size + mtime + content hash)'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary structured metadata (redacted before storage)'),
    retain_details: z.boolean().optional().describe('If true, redacted input and output payloads are stored alongside hashes. Defaults to false.'),
  }, async ({ event, tool, session_id, input, output, outcome, error_summary, cwd, files, metadata, retain_details }) => {
    try {
      const result = audrey.observeTool({
        event,
        tool,
        sessionId: session_id,
        input,
        output,
        outcome,
        errorSummary: error_summary,
        cwd,
        files,
        metadata,
        retainDetails: retain_details,
      });
      return toolResult({
        id: result.event.id,
        event_type: result.event.event_type,
        tool_name: result.event.tool_name,
        outcome: result.event.outcome,
        redaction_state: result.event.redaction_state,
        redactions: result.redactions,
        created_at: result.event.created_at,
      });
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool('memory_recent_failures', {
    since: z.string().optional().describe('ISO timestamp lower bound (defaults to 7 days ago)'),
    limit: z.number().int().min(1).max(200).optional().describe('Max rows to return (defaults to 20)'),
  }, async ({ since, limit }) => {
    try {
      return toolResult(audrey.recentFailures({ since, limit }));
    } catch (err) {
      return toolError(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[audrey-mcp] connected via stdio');
  registerShutdownHandlers(process, audrey);
}

function parseObserveToolArgs(argv: string[]): {
  event?: string;
  tool?: string;
  sessionId?: string;
  outcome?: string;
  cwd?: string;
  errorSummary?: string;
  files?: string[];
  inputJson?: string;
  outputJson?: string;
  metadataJson?: string;
  retainDetails?: boolean;
} {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--event') out.event = next();
    else if (token === '--tool') out.tool = next();
    else if (token === '--session-id') out.sessionId = next();
    else if (token === '--outcome') out.outcome = next();
    else if (token === '--cwd') out.cwd = next();
    else if (token === '--error-summary') out.errorSummary = next();
    else if (token === '--files') {
      const list = next();
      if (list) out.files = list.split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (token === '--input-json') out.inputJson = next();
    else if (token === '--output-json') out.outputJson = next();
    else if (token === '--metadata-json') out.metadataJson = next();
    else if (token === '--retain-details') out.retainDetails = true;
  }
  return out as ReturnType<typeof parseObserveToolArgs>;
}

async function observeToolCli(): Promise<void> {
  const args = parseObserveToolArgs(process.argv.slice(3));

  if (!args.event) {
    console.error('[audrey] observe-tool: --event is required (e.g. PreToolUse, PostToolUse)');
    process.exit(2);
  }
  if (!args.tool) {
    console.error('[audrey] observe-tool: --tool is required (e.g. Bash, Edit, Write)');
    process.exit(2);
  }

  let stdinPayload: Record<string, unknown> | null = null;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) {
      try { stdinPayload = JSON.parse(raw) as Record<string, unknown>; }
      catch { console.error('[audrey] observe-tool: stdin was not valid JSON, ignoring.'); }
    }
  }

  const parseMaybeJson = (text: string | undefined): unknown => {
    if (text == null) return undefined;
    try { return JSON.parse(text); }
    catch { return text; }
  };

  const inputPayload = args.inputJson !== undefined
    ? parseMaybeJson(args.inputJson)
    : stdinPayload?.tool_input ?? stdinPayload?.input ?? stdinPayload;
  const outputPayload = args.outputJson !== undefined
    ? parseMaybeJson(args.outputJson)
    : stdinPayload?.tool_output ?? stdinPayload?.output;
  const metadataPayload = args.metadataJson !== undefined
    ? parseMaybeJson(args.metadataJson)
    : stdinPayload?.metadata;

  const dataDir = resolveDataDir(process.env);
  const embedding = resolveEmbeddingProvider(process.env, process.env['AUDREY_EMBEDDING_PROVIDER']);
  const audrey = new Audrey({
    dataDir,
    agent: process.env['AUDREY_AGENT'] ?? 'observe-tool',
    embedding,
  });

  try {
    const result = audrey.observeTool({
      event: args.event,
      tool: args.tool,
      sessionId: args.sessionId,
      input: inputPayload,
      output: outputPayload,
      outcome: args.outcome as 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'unknown' | undefined,
      errorSummary: args.errorSummary ?? (stdinPayload?.error_summary as string | undefined),
      cwd: args.cwd ?? (stdinPayload?.cwd as string | undefined),
      files: args.files,
      metadata: (metadataPayload ?? undefined) as Record<string, unknown> | undefined,
      retainDetails: args.retainDetails,
    });
    const summary = {
      id: result.event.id,
      event_type: result.event.event_type,
      tool_name: result.event.tool_name,
      outcome: result.event.outcome,
      redaction_state: result.event.redaction_state,
      redactions: result.redactions,
    };
    console.log(JSON.stringify(summary));
  } finally {
    audrey.close();
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  if (subcommand === 'install') {
    install();
  } else if (subcommand === 'uninstall') {
    uninstall();
  } else if (subcommand === 'reembed') {
    reembed().catch(err => {
      console.error('[audrey] reembed failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'dream') {
    dream().catch(err => {
      console.error('[audrey] dream failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'greeting') {
    greeting().catch(err => {
      console.error('[audrey] greeting failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'reflect') {
    reflect().catch(err => {
      console.error('[audrey] reflect failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'serve') {
    serveHttp().catch(err => {
      console.error('[audrey] serve failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'status') {
    status();
  } else if (subcommand === 'observe-tool') {
    observeToolCli().catch(err => {
      console.error('[audrey] observe-tool failed:', err);
      process.exit(1);
    });
  } else {
    main().catch(err => {
      console.error('[audrey-mcp] fatal:', err);
      process.exit(1);
    });
  }
}
