#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Audrey } from '../src/index.js';
import { VERSION, SERVER_NAME, DEFAULT_DATA_DIR, buildAudreyConfig, buildInstallArgs } from './config.js';

const VALID_SOURCES = ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'];
const VALID_TYPES = ['episodic', 'semantic', 'procedural'];

const subcommand = process.argv[2];

if (subcommand === 'install') {
  install();
} else if (subcommand === 'uninstall') {
  uninstall();
} else if (subcommand === 'status') {
  status();
} else {
  main().catch(err => {
    console.error('[audrey-mcp] fatal:', err);
    process.exit(1);
  });
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

  const args = buildInstallArgs(process.env);

  try {
    execFileSync('claude', args, { stdio: 'inherit' });
  } catch {
    console.error('Failed to register MCP server. Is Claude Code installed and on your PATH?');
    process.exit(1);
  }

  console.log(`
Audrey registered as "${SERVER_NAME}" with Claude Code.

5 tools available in every session:
  memory_encode        — Store observations, facts, preferences
  memory_recall        — Search memories by semantic similarity
  memory_consolidate   — Extract principles from accumulated episodes
  memory_introspect    — Check memory system health
  memory_resolve_truth — Resolve contradictions between claims

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
      const audrey = new Audrey({
        dataDir: DEFAULT_DATA_DIR,
        agent: 'status-check',
        embedding: { provider: 'mock', dimensions: 8 },
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
    },
    async ({ content, source, tags, salience }) => {
      try {
        const id = await audrey.encode({ content, source, tags, salience });
        return toolResult({ id, content, source });
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
    },
    async ({ query, limit, types, min_confidence }) => {
      try {
        const results = await audrey.recall(query, {
          limit: limit ?? 10,
          types,
          minConfidence: min_confidence,
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[audrey-mcp] connected via stdio');

  process.on('SIGINT', () => {
    console.error('[audrey-mcp] shutting down');
    audrey.close();
    process.exit(0);
  });
}
