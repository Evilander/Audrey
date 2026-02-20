import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Audrey } from '../src/index.js';

const VALID_SOURCES = ['direct-observation', 'told-by-user', 'tool-result', 'inference', 'model-generated'];
const VALID_TYPES = ['episodic', 'semantic', 'procedural'];

function buildAudreyConfig() {
  const dataDir = process.env.AUDREY_DATA_DIR || join(homedir(), '.audrey', 'data');
  const agent = process.env.AUDREY_AGENT || 'claude-code';
  const embProvider = process.env.AUDREY_EMBEDDING_PROVIDER || 'mock';
  const embDimensions = parseInt(process.env.AUDREY_EMBEDDING_DIMENSIONS || '8', 10);
  const llmProvider = process.env.AUDREY_LLM_PROVIDER;

  const config = {
    dataDir,
    agent,
    embedding: { provider: embProvider, dimensions: embDimensions },
  };

  if (llmProvider === 'anthropic') {
    config.llm = { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY };
  } else if (llmProvider === 'openai') {
    config.llm = { provider: 'openai', apiKey: process.env.OPENAI_API_KEY };
  } else if (llmProvider === 'mock') {
    config.llm = { provider: 'mock' };
  }

  return config;
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
  console.error(`[audrey-mcp] started — agent=${config.agent} dataDir=${config.dataDir}`);

  const server = new McpServer({
    name: 'audrey-memory',
    version: '0.3.0',
  });

  // --- memory_encode ---
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

  // --- memory_recall ---
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

  // --- memory_consolidate ---
  server.tool(
    'memory_consolidate',
    {
      min_cluster_size: z.number().optional().describe('Minimum episodes per cluster'),
      similarity_threshold: z.number().optional().describe('Similarity threshold for clustering'),
    },
    async ({ min_cluster_size, similarity_threshold }) => {
      try {
        const result = await audrey.consolidate({
          minClusterSize: min_cluster_size,
          similarityThreshold: similarity_threshold,
        });
        return toolResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // --- memory_introspect ---
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

  // --- memory_resolve_truth ---
  server.tool(
    'memory_resolve_truth',
    {
      contradiction_id: z.string().describe('ID of the contradiction to resolve'),
    },
    async ({ contradiction_id }) => {
      try {
        const result = await audrey.resolveTruth(contradiction_id);
        return toolResult(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[audrey-mcp] connected via stdio');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.error('[audrey-mcp] shutting down');
    audrey.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[audrey-mcp] fatal:', err);
  process.exit(1);
});
