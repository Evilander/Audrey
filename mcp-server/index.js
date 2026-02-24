#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Audrey } from '../src/index.js';
import { readStoredDimensions } from '../src/db.js';
import { VERSION, SERVER_NAME, DEFAULT_DATA_DIR, buildAudreyConfig, buildInstallArgs, resolveEmbeddingProvider } from './config.js';

const VALID_SOURCES = ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'];
const VALID_TYPES = ['episodic', 'semantic', 'procedural'];

const subcommand = process.argv[2];

if (subcommand === 'install') {
  install();
} else if (subcommand === 'uninstall') {
  uninstall();
} else if (subcommand === 'reembed') {
  reembed().catch(err => {
    console.error('[audrey] reembed failed:', err);
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


async function reembed() {
  const dataDir = process.env.AUDREY_DATA_DIR || DEFAULT_DATA_DIR;
  const explicit = process.env.AUDREY_EMBEDDING_PROVIDER;
  const embedding = resolveEmbeddingProvider(process.env, explicit);

  const storedDims = readStoredDimensions(dataDir);
  const dimensionsChanged = storedDims !== null && storedDims !== embedding.dimensions;

  console.log(`Re-embedding with ${embedding.provider} (${embedding.dimensions}d)...`);
  if (dimensionsChanged) {
    console.log(`Dimension change: ${storedDims}d -> ${embedding.dimensions}d (will drop and recreate vec tables)`);
  }

  const audrey = new Audrey({ dataDir, agent: 'reembed', embedding });
  const { reembedAll } = await import('../src/migrate.js');
  const counts = await reembedAll(audrey.db, audrey.embeddingProvider, { dropAndRecreate: dimensionsChanged });
  audrey.close();

  console.log(`Done. Re-embedded: ${counts.episodes} episodes, ${counts.semantics} semantics, ${counts.procedures} procedures`);
}

function install() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('Error: claude CLI not found. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  if (process.env.OPENAI_API_KEY) {
    console.log('Detected OPENAI_API_KEY — using OpenAI embeddings (1536d)');
  } else {
    console.log('No OPENAI_API_KEY found — using mock embeddings (upgrade anytime by re-running with the key set)');
  }

  if (process.env.ANTHROPIC_API_KEY) {
    console.log('Detected ANTHROPIC_API_KEY — enabling LLM-powered consolidation + contradiction detection');
  }

  // Remove existing entry first so re-installs work cleanly
  try {
    execFileSync('claude', ['mcp', 'remove', SERVER_NAME], { stdio: 'ignore' });
  } catch {
    // Not registered yet — that's fine
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

12 tools available in every session:
  memory_encode        — Store observations, facts, preferences
  memory_recall        — Search memories by semantic similarity
  memory_consolidate   — Extract principles from accumulated episodes
  memory_introspect    — Check memory system health
  memory_resolve_truth — Resolve contradictions between claims
  memory_export        — Export all memories as JSON snapshot
  memory_import        — Import a snapshot into a fresh database
  memory_forget        — Forget a specific memory by ID or query
  memory_decay         — Apply forgetting curves, transition low-confidence to dormant
  memory_status        — Check brain health (episode/vec sync, dimensions)
  memory_reflect       — Form lasting memories from a conversation
  memory_greeting      — Wake up as yourself: load identity, context, mood

Data stored in: ${DEFAULT_DATA_DIR}
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

function status() {
  let registered = false;
  const claudeJsonPath = join(homedir(), '.claude.json');
  try {
    const claudeConfig = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
    registered = SERVER_NAME in (claudeConfig.mcpServers || {});
  } catch {
    // claude.json doesn't exist or isn't readable
  }

  console.log(`Registration: ${registered ? 'active' : 'not registered'}`);

  if (existsSync(DEFAULT_DATA_DIR)) {
    try {
      const dimensions = readStoredDimensions(DEFAULT_DATA_DIR) || 8;
      const audrey = new Audrey({
        dataDir: DEFAULT_DATA_DIR,
        agent: 'status-check',
        embedding: { provider: 'mock', dimensions },
      });
      const stats = audrey.introspect();
      audrey.close();
      console.log(`Data directory: ${DEFAULT_DATA_DIR}`);
      console.log(`Memories: ${stats.episodic} episodic, ${stats.semantic} semantic, ${stats.procedural} procedural`);
      console.log(`Dormant: ${stats.dormant}`);
      console.log(`Causal links: ${stats.causalLinks}`);
      console.log(`Contradictions: ${stats.contradictions.open} open, ${stats.contradictions.resolved} resolved`);
      console.log(`Consolidation runs: ${stats.totalConsolidationRuns}`);
    } catch (err) {
      console.log(`Data directory: ${DEFAULT_DATA_DIR} (exists but could not read: ${err.message})`);
    }
  } else {
    console.log(`Data directory: ${DEFAULT_DATA_DIR} (not yet created — will be created on first use)`);
  }
}

function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function toolError(err) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }] };
}

async function main() {
  const config = buildAudreyConfig();
  const audrey = new Audrey(config);

  const embLabel = config.embedding.provider === 'mock'
    ? 'mock embeddings — set OPENAI_API_KEY for real semantic search'
    : `${config.embedding.provider} embeddings (${config.embedding.dimensions}d)`;
  console.error(`[audrey-mcp] v${VERSION} started — agent=${config.agent} dataDir=${config.dataDir} (${embLabel})`);

  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });

  server.tool(
    'memory_encode',
    {
      content: z.string().describe('The memory content to encode'),
      source: z.enum(VALID_SOURCES).describe('Source type of the memory'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
      salience: z.number().min(0).max(1).optional().describe('Importance weight 0-1'),
      context: z.record(z.string()).optional().describe('Situational context as key-value pairs (e.g., {task: "debugging", domain: "payments"})'),
      affect: z.object({
        valence: z.number().min(-1).max(1).describe('Emotional valence: -1 (very negative) to 1 (very positive)'),
        arousal: z.number().min(0).max(1).optional().describe('Emotional arousal: 0 (calm) to 1 (highly activated)'),
        label: z.string().optional().describe('Human-readable emotion label (e.g., "curiosity", "frustration", "relief")'),
      }).optional().describe('Emotional affect — how this memory feels'),
      private: z.boolean().optional().describe('If true, memory is only visible to the AI � excluded from public recall results'),
    },
    async ({ content, source, tags, salience, private: isPrivate, context, affect }) => {
      try {
        const id = await audrey.encode({ content, source, tags, salience, private: isPrivate, context, affect });
        return toolResult({ id, content, source, private: isPrivate ?? false });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_recall',
    {
      query: z.string().describe('Search query to match against memories'),
      limit: z.number().min(1).max(50).optional().describe('Max results (default 10)'),
      types: z.array(z.enum(VALID_TYPES)).optional().describe('Memory types to search'),
      min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold'),
      tags: z.array(z.string()).optional().describe('Only return episodic memories with these tags'),
      sources: z.array(z.enum(VALID_SOURCES)).optional().describe('Only return episodic memories from these sources'),
      after: z.string().optional().describe('Only return memories created after this ISO date'),
      before: z.string().optional().describe('Only return memories created before this ISO date'),
      context: z.record(z.string()).optional().describe('Retrieval context — memories encoded in matching context get boosted'),
      mood: z.object({
        valence: z.number().min(-1).max(1).describe('Current emotional valence: -1 (negative) to 1 (positive)'),
        arousal: z.number().min(0).max(1).optional().describe('Current arousal: 0 (calm) to 1 (activated)'),
      }).optional().describe('Current mood — boosts recall of memories encoded in similar emotional state'),
    },
    async ({ query, limit, types, min_confidence, tags, sources, after, before, context, mood }) => {
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
    },
  );

  server.tool(
    'memory_consolidate',
    {
      min_cluster_size: z.number().optional().describe('Minimum episodes per cluster'),
      similarity_threshold: z.number().optional().describe('Similarity threshold for clustering'),
    },
    async ({ min_cluster_size, similarity_threshold }) => {
      try {
        const consolidation = await audrey.consolidate({
          minClusterSize: min_cluster_size,
          similarityThreshold: similarity_threshold,
        });
        return toolResult(consolidation);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_introspect',
    {},
    async () => {
      try {
        const stats = audrey.introspect();
        return toolResult(stats);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_resolve_truth',
    {
      contradiction_id: z.string().describe('ID of the contradiction to resolve'),
    },
    async ({ contradiction_id }) => {
      try {
        const resolution = await audrey.resolveTruth(contradiction_id);
        return toolResult(resolution);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_export',
    {},
    async () => {
      try {
        const snapshot = audrey.export();
        return toolResult(snapshot);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_import',
    {
      snapshot: z.object({
        version: z.string(),
        episodes: z.array(z.any()),
        semantics: z.array(z.any()).optional(),
        procedures: z.array(z.any()).optional(),
        causalLinks: z.array(z.any()).optional(),
        contradictions: z.array(z.any()).optional(),
        consolidationRuns: z.array(z.any()).optional(),
        config: z.record(z.string()).optional(),
      }).passthrough().describe('A snapshot from memory_export'),
    },
    async ({ snapshot }) => {
      try {
        await audrey.import(snapshot);
        const stats = audrey.introspect();
        return toolResult({ imported: true, stats });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_forget',
    {
      id: z.string().optional().describe('ID of the memory to forget'),
      query: z.string().optional().describe('Semantic query to find and forget the closest matching memory'),
      min_similarity: z.number().min(0).max(1).optional().describe('Minimum similarity for query-based forget (default 0.9)'),
      purge: z.boolean().optional().describe('Hard-delete the memory permanently (default false, soft-delete)'),
    },
    async ({ id, query, min_similarity, purge }) => {
      try {
        if (!id && !query) {
          return toolError(new Error('Provide either id or query'));
        }
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
    },
  );

  server.tool(
    'memory_decay',
    {
      dormant_threshold: z.number().min(0).max(1).optional().describe('Confidence below which memories go dormant (default 0.1)'),
    },
    async ({ dormant_threshold }) => {
      try {
        const result = audrey.decay({ dormantThreshold: dormant_threshold });
        return toolResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_status',
    {},
    async () => {
      try {
        const status = audrey.memoryStatus();
        return toolResult(status);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_reflect',
    {
      turns: z.array(z.object({
        role: z.string().describe('Message role: user or assistant'),
        content: z.string().describe('Message content'),
      })).describe('Conversation turns to reflect on. Call at end of meaningful conversations to form lasting memories.'),
    },
    async ({ turns }) => {
      try {
        const result = await audrey.reflect(turns);
        return toolResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    'memory_greeting',
    {
      context: z.string().optional().describe('Optional hint about this session (e.g. "working on authentication feature"). If provided, also returns semantically relevant memories.'),
    },
    async ({ context }) => {
      try {
        const briefing = await audrey.greeting({ context });
        return toolResult(briefing);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[audrey-mcp] connected via stdio');

  process.on('SIGINT', () => {
    console.error('[audrey-mcp] shutting down');
    audrey.close();
    process.exit(0);
  });
}
