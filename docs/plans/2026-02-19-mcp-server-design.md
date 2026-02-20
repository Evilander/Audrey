# Audrey MCP Server Design

**Date:** 2026-02-19
**Status:** Approved
**Author:** Tyler Eveland + Claude

---

## Goal

Wrap Audrey's core API as an MCP (Model Context Protocol) tool server so Claude Code and other MCP clients can encode, recall, consolidate, introspect, and resolve contradictions in persistent biological memory.

## Architecture

- **Transport:** stdio (Claude Code spawns as child process)
- **Entry point:** `mcp-server/index.js`
- **SDK:** `@modelcontextprotocol/sdk` + `zod` for input schemas
- **Instance:** Single `Audrey` instance created at startup from env vars
- **Logging:** All to stderr (stdout reserved for JSON-RPC protocol)
- **Errors:** Returned as tool results with `isError: true`, never thrown

## Configuration

Environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `AUDREY_DATA_DIR` | `~/.audrey/data` | SQLite database directory |
| `AUDREY_AGENT` | `claude-code` | Agent identifier |
| `AUDREY_EMBEDDING_PROVIDER` | `mock` | `mock` or `openai` |
| `AUDREY_EMBEDDING_DIMENSIONS` | `8` (mock) / `1536` (openai) | Vector dimensions |
| `OPENAI_API_KEY` | — | Required when embedding provider is `openai` |
| `AUDREY_LLM_PROVIDER` | — | `mock`, `anthropic`, or `openai` (optional) |
| `ANTHROPIC_API_KEY` | — | Required when LLM provider is `anthropic` |

## Tools

### 1. `memory_encode`

Store a new episodic memory.

**Input:**
```json
{
  "content": "string (required) — the observation or fact",
  "source": "string (required) — one of: direct-observation, told-by-user, tool-result, inference, model-generated",
  "tags": "string[] (optional) — categorization tags",
  "salience": "number (optional, 0-1) — importance weight"
}
```

**Output:** `{ id, content, source }`

**When LLM calls it:** User shares a fact, preference, experience, or observation worth remembering across sessions.

### 2. `memory_recall`

Retrieve memories relevant to a query, ranked by confidence-weighted similarity with Ebbinghaus decay applied.

**Input:**
```json
{
  "query": "string (required) — what to search for",
  "limit": "number (optional, default 10) — max results",
  "types": "string[] (optional) — filter to episodic, semantic, procedural",
  "min_confidence": "number (optional, 0-1) — minimum confidence threshold"
}
```

**Output:** Array of `{ id, content, type, confidence, score, source, createdAt }`

**When LLM calls it:** Before answering questions to check what's already known. Proactive memory retrieval.

### 3. `memory_consolidate`

Extract generalized principles from accumulated episodic memories. Like sleeping on it.

**Input:**
```json
{
  "min_cluster_size": "number (optional, default 3) — minimum episodes to form a principle",
  "similarity_threshold": "number (optional, default 0.80) — clustering threshold"
}
```

**Output:** `{ runId, episodesEvaluated, clustersFound, principlesExtracted, status }`

**When LLM calls it:** Periodically, or when enough new episodes have accumulated.

### 4. `memory_introspect`

Check memory system health — counts, contradiction stats, consolidation history.

**Input:** None

**Output:**
```json
{
  "episodic": 42,
  "semantic": 5,
  "procedural": 0,
  "causalLinks": 3,
  "dormant": 1,
  "contradictions": { "open": 0, "resolved": 2, "context_dependent": 1, "reopened": 0 },
  "lastConsolidation": "2026-02-19T...",
  "totalConsolidationRuns": 3
}
```

**When LLM calls it:** To understand current memory state, diagnose issues, decide if consolidation is needed.

### 5. `memory_resolve_truth`

Resolve an open contradiction between two claims via LLM reasoning.

**Input:**
```json
{
  "contradiction_id": "string (required) — the contradiction to resolve"
}
```

**Output:** `{ resolution, conditions, explanation }`

**When LLM calls it:** When introspect reveals open contradictions, or after a contradiction event during encoding.

**Requires:** LLM provider configured (AUDREY_LLM_PROVIDER).

## Registration

```bash
claude mcp add --transport stdio --scope user \
  --env AUDREY_DATA_DIR=~/.audrey/data \
  --env AUDREY_EMBEDDING_PROVIDER=mock \
  audrey-memory -- node A:/ai/claude/audrey/mcp-server/index.js
```

For production with real embeddings:
```bash
claude mcp add --transport stdio --scope user \
  --env AUDREY_DATA_DIR=~/.audrey/data \
  --env AUDREY_EMBEDDING_PROVIDER=openai \
  --env OPENAI_API_KEY=$OPENAI_API_KEY \
  --env AUDREY_LLM_PROVIDER=anthropic \
  --env ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  audrey-memory -- node A:/ai/claude/audrey/mcp-server/index.js
```

## Testing

- MCP Inspector: `npx @modelcontextprotocol/inspector node mcp-server/index.js`
- Unit tests: `tests/mcp-server.test.js` — test tool handlers directly (mock Audrey)
- Integration tests: Spin up server, call tools via SDK client

## File Changes

| File | Change |
|------|--------|
| `mcp-server/index.js` | **NEW** — MCP server entry point |
| `package.json` | Add `@modelcontextprotocol/sdk`, `zod` to dependencies |
| `tests/mcp-server.test.js` | **NEW** — tool handler tests |

## Dependencies

```
@modelcontextprotocol/sdk ^1.26.0
zod ^3.25
```
