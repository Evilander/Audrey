#!/usr/bin/env node
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Audrey } from '../src/index.js';
import { readStoredDimensions } from '../src/db.js';
import {
  VERSION,
  SERVER_NAME,
  buildAudreyConfig,
  buildInstallArgs,
  resolveDataDir,
  resolveEmbeddingProvider,
  resolveLLMProvider,
} from './config.js';

const VALID_SOURCES = ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'];
const VALID_TYPES = ['episodic', 'semantic', 'procedural'];

export const MAX_MEMORY_CONTENT_LENGTH = 50_000;

const subcommand = process.argv[2];

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateMemoryContent(content) {
  if (!isNonEmptyText(content)) {
    throw new Error('content must be a non-empty string');
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`content exceeds maximum length of ${MAX_MEMORY_CONTENT_LENGTH} characters`);
  }
}

export function validateForgetSelection(id, query) {
  if ((id && query) || (!id && !query)) {
    throw new Error('Provide exactly one of id or query');
  }
}

export async function initializeEmbeddingProvider(provider) {
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
  context: z.record(z.string()).optional().describe('Situational context as key-value pairs (e.g., {task: "debugging", domain: "payments"})'),
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
  context: z.record(z.string()).optional().describe('Retrieval context - memories encoded in matching context get boosted'),
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
    config: z.record(z.string()).optional(),
  }).passthrough().describe('A snapshot from memory_export'),
};

export const memoryForgetToolSchema = {
  id: z.string().optional().describe('ID of the memory to forget'),
  query: z.string().optional().describe('Semantic query to find and forget the closest matching memory'),
  min_similarity: z.number().min(0).max(1).optional().describe('Minimum similarity for query-based forget (default 0.9)'),
  purge: z.boolean().optional().describe('Hard-delete the memory permanently (default false, soft-delete)'),
};

async function reembed() {
  const dataDir = resolveDataDir(process.env);
  const explicit = process.env.AUDREY_EMBEDDING_PROVIDER;
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

async function dream() {
  const dataDir = resolveDataDir(process.env);
  const explicit = process.env.AUDREY_EMBEDDING_PROVIDER;
  const embedding = resolveEmbeddingProvider(process.env, explicit);
  const storedDims = readStoredDimensions(dataDir);

  const config = {
    dataDir,
    agent: 'dream',
    embedding,
  };

  const llm = resolveLLMProvider(process.env, process.env.AUDREY_LLM_PROVIDER);
  if (llm) config.llm = llm;

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

async function greeting() {
  const dataDir = resolveDataDir(process.env);
  const contextArg = process.argv[3] || undefined;

  if (!existsSync(dataDir)) {
    console.log('[audrey] No data yet - fresh start.');
    return;
  }

  const storedDimensions = readStoredDimensions(dataDir);
  const resolvedEmbedding = resolveEmbeddingProvider(process.env, process.env.AUDREY_EMBEDDING_PROVIDER);
  const canUseResolvedEmbedding = Boolean(contextArg)
    && storedDimensions !== null
    && storedDimensions === resolvedEmbedding.dimensions;
  const dimensions = storedDimensions || resolvedEmbedding.dimensions || 8;
  const audrey = new Audrey({
    dataDir,
    agent: 'greeting',
    embedding: canUseResolvedEmbedding
      ? resolvedEmbedding
      : { provider: 'mock', dimensions },
  });

  try {
    if (canUseResolvedEmbedding) {
      await initializeEmbeddingProvider(audrey.embeddingProvider);
    }
    const result = await audrey.greeting({ context: canUseResolvedEmbedding ? contextArg : undefined });
    const health = audrey.memoryStatus();

    const lines = [];
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
    if (result.contextual?.length > 0) {
      lines.push(`Context-relevant memories (query: "${contextArg}"):`);
      for (const c of result.contextual) {
        lines.push(`  - [${c.type}] ${c.content.slice(0, 200)}`);
      }
      lines.push('');
    }

    console.log(lines.join('\n'));
  } finally {
    audrey.close();
  }
}

function timeSince(isoDate) {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function reflect() {
  const dataDir = resolveDataDir(process.env);
  const explicit = process.env.AUDREY_EMBEDDING_PROVIDER;
  const embedding = resolveEmbeddingProvider(process.env, explicit);

  const config = {
    dataDir,
    agent: 'reflect',
    embedding,
  };

  const llm = resolveLLMProvider(process.env, process.env.AUDREY_LLM_PROVIDER);
  if (llm) config.llm = llm;

  const audrey = new Audrey(config);
  try {
    await initializeEmbeddingProvider(audrey.embeddingProvider);

    // Read conversation turns from stdin if available
    let turns = null;
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw) {
        try {
          turns = JSON.parse(raw);
        } catch {
          console.error('[audrey] Could not parse stdin as JSON turns, skipping reflect.');
        }
      }
    }

    if (turns && Array.isArray(turns) && turns.length > 0) {
      console.log(`[audrey] Reflecting on ${turns.length} conversation turns...`);
      const reflectResult = await audrey.reflect(turns);
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

async function recall() {
  const dataDir = resolveDataDir(process.env);

  if (!existsSync(dataDir)) {
    // No data yet — nothing to recall
    process.exit(0);
  }

  // Read hook JSON from stdin
  let hookInput = null;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw) {
      try {
        hookInput = JSON.parse(raw);
      } catch {
        console.error('[audrey] Could not parse stdin as JSON');
        process.exit(0);
      }
    }
  }

  // Extract query from hook input or CLI arg
  const query = hookInput?.prompt        // UserPromptSubmit hook
    || hookInput?.query                  // direct query field
    || process.argv[3];                  // CLI argument

  if (!query || typeof query !== 'string' || !query.trim()) {
    process.exit(0);
  }

  const storedDimensions = readStoredDimensions(dataDir);
  const resolvedEmbedding = resolveEmbeddingProvider(process.env, process.env.AUDREY_EMBEDDING_PROVIDER);
  const canEmbed = storedDimensions !== null && storedDimensions === resolvedEmbedding.dimensions;

  if (!canEmbed) {
    // Dimension mismatch — skip recall silently
    process.exit(0);
  }

  const audrey = new Audrey({
    dataDir,
    agent: 'recall-hook',
    embedding: resolvedEmbedding,
  });

  try {
    await initializeEmbeddingProvider(audrey.embeddingProvider);

    const limit = parseInt(process.argv[4], 10) || 5;
    const results = await audrey.recall(query.trim(), {
      limit,
      includePrivate: false,
    });

    if (!results || results.length === 0) {
      process.exit(0);
    }

    const lines = results.map(r => {
      const type = r.type === 'semantic' ? 'principle' : r.type === 'procedural' ? 'procedure' : 'memory';
      return `[${type}] ${r.content}`;
    });

    const output = {
      additionalContext: `Relevant memories from Audrey:\n\n${lines.join('\n\n')}`,
    };

    console.log(JSON.stringify(output));
  } finally {
    audrey.close();
  }
}

export function buildHooksConfig({ scope = 'user' } = {}) {
  const audreyBin = 'npx audrey';

  return {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [
          {
            type: 'command',
            command: `${audreyBin} greeting`,
            timeout: 30,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${audreyBin} recall`,
            timeout: 15,
          },
        ],
      },
    ],
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${audreyBin} reflect`,
            timeout: 120,
          },
        ],
      },
    ],
    PostCompact: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${audreyBin} greeting`,
            timeout: 30,
          },
        ],
      },
    ],
  };
}

function hooksInstall() {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  const settingsDir = join(homedir(), '.claude');

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error(`[audrey] Could not parse ${settingsPath}. Please fix it manually.`);
      process.exit(1);
    }
  }

  const audreyHooks = buildHooksConfig();

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Merge Audrey hooks with existing hooks, preserving user's existing hooks
  for (const [event, audreyEntries] of Object.entries(audreyHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove any previously-installed Audrey hooks (by command match)
    settings.hooks[event] = settings.hooks[event].filter(entry => {
      if (!entry.hooks) return true;
      return !entry.hooks.some(h => h.command && h.command.includes('npx audrey'));
    });

    // Add Audrey hooks
    settings.hooks[event].push(...audreyEntries);
  }

  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  console.log(`[audrey] Hooks installed in ${settingsPath}

Hooks configured:
  SessionStart  → npx audrey greeting   (load identity, principles, mood)
  UserPromptSubmit → npx audrey recall   (semantic memory search per prompt)
  Stop          → npx audrey reflect     (consolidate learnings + dream cycle)
  PostCompact   → npx audrey greeting    (re-inject memories after compaction)

Verify: Open ${settingsPath} or run claude /hooks
`);
}

function hooksUninstall() {
  const settingsPath = join(homedir(), '.claude', 'settings.json');

  if (!existsSync(settingsPath)) {
    console.log('[audrey] No settings.json found. Nothing to remove.');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    console.error(`[audrey] Could not parse ${settingsPath}.`);
    process.exit(1);
  }

  if (!settings.hooks) {
    console.log('[audrey] No hooks configured. Nothing to remove.');
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(entry => {
      if (!entry.hooks) return true;
      return !entry.hooks.some(h => h.command && h.command.includes('npx audrey'));
    });
    removed += before - settings.hooks[event].length;

    // Clean up empty arrays
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`[audrey] Removed ${removed} hook(s) from ${settingsPath}`);
}

export function resolveSnapshotPath(outputArg, dataDir) {
  if (outputArg) return resolve(outputArg);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return resolve(dataDir, '..', `audrey-snapshot-${timestamp}.json`);
}

async function snapshot() {
  const dataDir = resolveDataDir(process.env);

  if (!existsSync(dataDir)) {
    console.error('[audrey] No data directory found. Nothing to snapshot.');
    process.exit(1);
  }

  const storedDimensions = readStoredDimensions(dataDir);
  const dimensions = storedDimensions || 8;
  const audrey = new Audrey({
    dataDir,
    agent: 'snapshot',
    embedding: { provider: 'mock', dimensions },
  });

  try {
    const data = audrey.export();
    const stats = audrey.introspect();

    const outputPath = resolveSnapshotPath(process.argv[3], dataDir);

    writeFileSync(outputPath, JSON.stringify(data, null, 2) + '\n');

    console.log(`[audrey] Snapshot saved to ${outputPath}`);
    console.log(`  ${stats.episodic} episodes, ${stats.semantic} semantics, ${stats.procedural} procedures`);
    console.log(`  ${data.contradictions?.length || 0} contradictions, ${data.causalLinks?.length || 0} causal links`);
    console.log(`  Version: ${data.version}, exported at: ${data.exportedAt}`);
    console.log('');
    console.log('To restore: npx audrey restore ' + outputPath);
  } finally {
    audrey.close();
  }
}

async function restore() {
  const snapshotPath = process.argv[3];
  if (!snapshotPath) {
    console.error('Usage: npx audrey restore <snapshot-file>');
    console.error('  e.g.: npx audrey restore audrey-snapshot-2026-03-24.json');
    process.exit(1);
  }

  const resolvedPath = resolve(snapshotPath);
  if (!existsSync(resolvedPath)) {
    console.error(`[audrey] Snapshot file not found: ${resolvedPath}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  } catch {
    console.error(`[audrey] Could not parse snapshot file: ${resolvedPath}`);
    process.exit(1);
  }

  if (!data.version || !data.episodes) {
    console.error('[audrey] Invalid snapshot: missing version or episodes field.');
    process.exit(1);
  }

  const dataDir = resolveDataDir(process.env);
  const explicit = process.env.AUDREY_EMBEDDING_PROVIDER;
  const embedding = resolveEmbeddingProvider(process.env, explicit);

  const audrey = new Audrey({ dataDir, agent: 'restore', embedding });

  try {
    await initializeEmbeddingProvider(audrey.embeddingProvider);

    const stats = audrey.introspect();
    const isEmpty = stats.episodic === 0 && stats.semantic === 0 && stats.procedural === 0;

    if (!isEmpty) {
      const force = process.argv.includes('--force');
      if (!force) {
        console.error('[audrey] Database is not empty. Use --force to purge and restore.');
        console.error(`  Current: ${stats.episodic} episodes, ${stats.semantic} semantics, ${stats.procedural} procedures`);
        process.exit(1);
      }
      console.log('[audrey] --force: purging existing memories before restore...');
      audrey.purge();
    }

    console.log(`[audrey] Restoring from snapshot v${data.version} (${data.exportedAt || 'unknown date'})...`);
    console.log(`[audrey] Re-embedding with ${embedding.provider} (${embedding.dimensions}d)...`);

    await audrey.import(data);

    const restored = audrey.introspect();
    console.log(`[audrey] Restored: ${restored.episodic} episodes, ${restored.semantic} semantics, ${restored.procedural} procedures`);
    console.log('[audrey] Restore complete.');
  } finally {
    audrey.close();
  }
}

function install() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('Error: claude CLI not found. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  const dataDir = resolveDataDir(process.env);
  const resolvedEmbedding = resolveEmbeddingProvider(process.env, process.env.AUDREY_EMBEDDING_PROVIDER);
  const resolvedLlm = resolveLLMProvider(process.env, process.env.AUDREY_LLM_PROVIDER);
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
  npx audrey recall    - Semantic recall for hook context injection
  npx audrey reflect   - Reflect on conversation + dream cycle (for hooks)
  npx audrey dream     - Run consolidation + decay cycle
  npx audrey reembed   - Re-embed all memories with current provider

Versioning (git-friendly memory snapshots):
  npx audrey snapshot [file] - Export memories to a JSON snapshot file
  npx audrey restore <file>  - Restore memories from a snapshot (--force to overwrite)

Hooks integration (automatic memory in every session):
  npx audrey hooks install   - Add Audrey hooks to ~/.claude/settings.json
  npx audrey hooks uninstall - Remove Audrey hooks from settings

Data stored in: ${dataDir}
Verify: claude mcp list
`);
}

function uninstall() {
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

function cliHasFlag(flag, argv = process.argv) {
  return Array.isArray(argv) && argv.includes(flag);
}

export function buildStatusReport({
  dataDir = resolveDataDir(process.env),
  claudeJsonPath = join(homedir(), '.claude.json'),
} = {}) {
  let registered = false;
  try {
    const claudeConfig = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    registered = SERVER_NAME in (claudeConfig.mcpServers || {});
  } catch {
    // Ignore unreadable config.
  }

  const report = {
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
    report.lastConsolidation = audrey.db.prepare(`
      SELECT completed_at FROM consolidation_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `).get()?.completed_at || 'never';
    audrey.close();
  } catch (err) {
    report.error = err.message || String(err);
  }

  return report;
}

export function formatStatusReport(report) {
  const lines = [];
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
    `Memories: ${report.stats.episodic} episodic, ${report.stats.semantic} semantic, ${report.stats.procedural} procedural`
  );
  lines.push(
    `Index sync: ${report.health.vec_episodes}/${report.health.searchable_episodes} episodic, `
    + `${report.health.vec_semantics}/${report.health.searchable_semantics} semantic, `
    + `${report.health.vec_procedures}/${report.health.searchable_procedures} procedural`
  );
  lines.push(
    `Health: ${report.health.healthy ? 'healthy' : 'unhealthy'}`
    + `${report.health.reembed_recommended ? ' (re-embed recommended)' : ''}`
  );
  lines.push(`Dormant: ${report.stats.dormant}`);
  lines.push(`Causal links: ${report.stats.causalLinks}`);
  lines.push(`Contradictions: ${report.stats.contradictions.open} open, ${report.stats.contradictions.resolved} resolved`);
  lines.push(`Consolidation runs: ${report.stats.totalConsolidationRuns}`);
  lines.push(`Last consolidation: ${report.lastConsolidation}`);

  return lines.join('\n');
}

export function runStatusCommand({
  argv = process.argv,
  dataDir = resolveDataDir(process.env),
  claudeJsonPath = join(homedir(), '.claude.json'),
  out = console.log,
} = {}) {
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

function status() {
  const { exitCode } = runStatusCommand();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function toolError(err) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }] };
}

export function registerShutdownHandlers(processRef, audrey, logger = console.error) {
  let closed = false;

  const shutdown = (message, exitCode = 0) => {
    if (message) {
      logger(message);
    }
    if (!closed) {
      closed = true;
      try {
        audrey.close();
      } catch (err) {
        logger(`[audrey-mcp] shutdown error: ${err.message || String(err)}`);
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
  processRef.once('uncaughtException', err => {
    logger('[audrey-mcp] uncaught exception:', err);
    shutdown(null, 1);
  });
  processRef.once('unhandledRejection', reason => {
    logger('[audrey-mcp] unhandled rejection:', reason);
    shutdown(null, 1);
  });

  return shutdown;
}

export function registerDreamTool(server, audrey) {
  server.tool(
    'memory_dream',
    {
      min_cluster_size: z.number().optional().describe('Minimum episodes per cluster (default 3)'),
      similarity_threshold: z.number().optional().describe('Similarity threshold for clustering (default 0.85)'),
      dormant_threshold: z.number().min(0).max(1).optional().describe('Confidence below which memories go dormant (default 0.1)'),
    },
    async ({ min_cluster_size, similarity_threshold, dormant_threshold }) => {
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

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const config = buildAudreyConfig();
  const audrey = new Audrey(config);

  const embLabel = config.embedding.provider === 'mock'
    ? 'mock embeddings - set OPENAI_API_KEY for real semantic search'
    : `${config.embedding.provider} embeddings (${config.embedding.dimensions}d)`;
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
      await audrey.import(snapshot);
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
        result = await audrey.forgetByQuery(query, {
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[audrey-mcp] connected via stdio');
  registerShutdownHandlers(process, audrey);
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
  } else if (subcommand === 'recall') {
    recall().catch(err => {
      console.error('[audrey] recall failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'hooks') {
    const hooksAction = process.argv[3];
    if (hooksAction === 'install') {
      hooksInstall();
    } else if (hooksAction === 'uninstall') {
      hooksUninstall();
    } else {
      console.error('Usage: npx audrey hooks [install|uninstall]');
      process.exit(1);
    }
  } else if (subcommand === 'snapshot') {
    snapshot().catch(err => {
      console.error('[audrey] snapshot failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'restore') {
    restore().catch(err => {
      console.error('[audrey] restore failed:', err);
      process.exit(1);
    });
  } else if (subcommand === 'status') {
    status();
  } else {
    main().catch(err => {
      console.error('[audrey-mcp] fatal:', err);
      process.exit(1);
    });
  }
}
