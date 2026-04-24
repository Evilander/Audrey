# Audrey With Ollama Local Agents

Ollama provides local model inference. Audrey provides long-term memory. Treat Audrey as the memory sidecar that your Ollama-backed agent calls through tools.

This is intentionally host-neutral: the same Audrey data directory can be shared by Codex, Claude Code, Claude Desktop, and a local Ollama agent, or isolated per project.

## Start Audrey

```bash
AUDREY_AGENT=ollama-local-agent AUDREY_EMBEDDING_PROVIDER=local npx audrey serve
```

Health check:

```bash
curl http://localhost:7437/health
curl http://localhost:7437/v1/status
```

Use `AUDREY_API_KEY` if the sidecar is reachable beyond your local process boundary:

```bash
AUDREY_API_KEY=secret AUDREY_AGENT=ollama-local-agent npx audrey serve
```

## Memory Tools To Expose

Expose these Audrey routes as function tools in your local agent loop:

| Tool | Audrey route | Purpose |
|---|---|---|
| `memory_preflight` | `POST /v1/preflight` | Check known risks, rules, procedures, and prior failures before tool use |
| `memory_reflexes` | `POST /v1/reflexes` | Convert preflight evidence into trigger-response rules the agent can automate |
| `memory_capsule` | `POST /v1/capsule` | Build a compact, ranked context packet for the current task |
| `memory_recall` | `POST /v1/recall` | Search durable memories |
| `memory_encode` | `POST /v1/encode` | Store useful observations, decisions, procedures, and preferences |
| `memory_status` | `GET /v1/status` | Check memory/index health |

Minimum useful loop:

1. Before tool use, call `memory_reflexes` or `memory_preflight` for the proposed action.
2. If a reflex says `block`, stop and ask for repair or approval.
3. Before calling Ollama, ask Audrey for a capsule using the user task as the query.
4. Add the capsule to the model instructions or context.
5. Let the model call `memory_recall` for details when needed.
6. After the task, call `memory_encode` for durable facts, decisions, mistakes, procedures, and preferences.
7. Run `npx audrey dream` on a schedule to consolidate and decay memory.

## Native Ollama Tool Shape

Ollama supports function tools on `/api/chat`. Your agent owns the loop that executes a tool call and sends the result back to the model.

Audrey ships a complete example loop:

```bash
OLLAMA_MODEL=qwen3 node examples/ollama-memory-agent.js "What should you remember about this project?"
```

```json
{
  "type": "function",
  "function": {
    "name": "memory_recall",
    "description": "Recall Audrey memories relevant to a query.",
    "parameters": {
      "type": "object",
      "required": ["query"],
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query for durable memory."
        },
        "limit": {
          "type": "number",
          "description": "Maximum results to return."
        }
      }
    }
  }
}
```

Tool executor:

```js
export async function memoryRecall({ query, limit = 5 }) {
  const response = await fetch('http://localhost:7437/v1/recall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  if (!response.ok) {
    throw new Error(`Audrey recall failed: ${response.status}`);
  }
  return response.json();
}
```

## OpenAI-Compatible Ollama Mode

Ollama also exposes an OpenAI-compatible API at `http://localhost:11434/v1/`. If your local agent framework already knows how to call OpenAI-style tools, point the model client at Ollama and keep Audrey as the tool executor.

The important separation is:

- Ollama answers with local models.
- Audrey remembers, recalls, reconciles, and consolidates.
- The agent loop decides when a model tool call should hit Audrey.

Official Ollama references:

- Native tool calling: <https://docs.ollama.com/capabilities/tool-calling>
- OpenAI-compatible API: <https://docs.ollama.com/openai>

## Data Layout

For shared memory across hosts:

```bash
AUDREY_DATA_DIR=$HOME/.audrey/data
```

For project-local memory:

```bash
AUDREY_DATA_DIR=.audrey-data
```

Shared memory is better for personal continuity across Codex, Claude, and local agents. Project-local memory is better when clients, repositories, or experiments must not bleed into each other.
