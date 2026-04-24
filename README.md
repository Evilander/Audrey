# Audrey

[![CI](https://github.com/Evilander/Audrey/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Evilander/Audrey/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/audrey.svg)](https://www.npmjs.com/package/audrey)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Audrey is a local-first memory runtime and continuity engine for AI agents.

It gives Codex, Claude Code, Claude Desktop, Cursor, local Ollama-backed agents, and custom agent services a shared local memory store, durable recall, consolidation, contradiction handling, a REST sidecar, MCP tools, and benchmark gates without adding external infrastructure.

Audrey also checks memory before an agent acts. Known failures, project rules, and local quirks become preflight warnings and Memory Reflexes instead of repeated mistakes.

Requires Node.js 20+.

## Quick Start

### 60-Second Proof

```bash
npx audrey demo
```

This runs a self-contained local demo with no API keys, no host setup, and no external model. It writes temporary memories, records a redacted tool failure, asks Audrey for a Memory Capsule, proves recall, then deletes the demo store.

### MCP Hosts

```bash
npx audrey mcp-config codex
npx audrey mcp-config generic
```

`mcp-config codex` prints a ready-to-paste Codex TOML block. `mcp-config generic` prints JSON for local stdio MCP hosts such as Claude Desktop, Cursor, Windsurf, and JetBrains.

Claude Code also has a direct installer:

```bash
npx audrey install
claude mcp list
```

All MCP paths use local embeddings by default and store memory in one SQLite-backed data directory.

### Ollama and Local Agents

Ollama is a local model runtime, not a memory store. Use Audrey as the sidecar memory tool layer for any Ollama-backed agent:

```bash
AUDREY_AGENT=ollama-local-agent npx audrey serve
curl http://localhost:7437/health
```

Then expose Audrey's `/v1/preflight`, `/v1/reflexes`, `/v1/encode`, `/v1/recall`, `/v1/capsule`, and `/v1/status` routes as tools in the local agent loop.

Runnable example:

```bash
AUDREY_AGENT=ollama-local-agent npx audrey serve
OLLAMA_MODEL=qwen3 node examples/ollama-memory-agent.js "What should you remember about Audrey?"
```

### REST or Docker Sidecar

```bash
docker compose up -d --build
```

Then verify:

```bash
npx audrey status
curl http://localhost:3487/health
```

## Why Audrey

- Local-first: memory lives in SQLite with `sqlite-vec`, not a hosted vector database.
- Host-neutral: Audrey is a memory runtime for agent hosts, not a Claude-only extension.
- Practical: MCP, CLI, REST, JavaScript, Python, and Docker are all first-class.
- Durable: export/import, health checks, benchmark gates, and graceful shutdown are built in.
- Structured: Audrey does more than save notes. It consolidates, decays, tracks contradictions, and supports procedural memory.

## What Ships

- Local stdio MCP server with 19 memory tools
- Ready-to-paste config generation for Codex and generic MCP hosts
- Hook-compatible CLI helpers for recall, reflection, and tool trace capture
- JavaScript SDK
- Python SDK packaged as `audrey-memory`
- REST API for sidecar deployment and Ollama/local-agent tool bridges
- Memory Preflight for checking prior failures, risks, rules, and procedures before an agent acts
- Memory Reflexes that convert preflight evidence into trigger-response guidance agents can automate
- Docker and Compose deployment path
- Export/import for portable memory state
- Machine-readable health and benchmark gates
- Local benchmark harness with retrieval and lifecycle-operation tracks

## Integration Modes

| Mode | Best For | Entry Point |
|---|---|---|
| MCP stdio | Codex, Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, JetBrains | `npx audrey mcp-config <host>` or `npx audrey install` for Claude Code |
| REST sidecar | Ollama-backed local agents, internal agent services, Docker | `npx audrey serve` or `docker compose up -d --build` |
| SDK direct | Node.js and TypeScript agents inside one process | `import { Audrey } from 'audrey'` |
| Python client | Python agents calling the REST sidecar | `pip install audrey-memory` |

Useful checks:

```bash
npx audrey status
npx audrey status --json --fail-on-unhealthy
```

## Use Audrey From Code

### JavaScript

```js
import { Audrey } from 'audrey';

const brain = new Audrey({
  dataDir: './audrey-data',
  agent: 'support-agent',
  embedding: { provider: 'local', dimensions: 384 },
});

await brain.encode({
  content: 'Stripe returns HTTP 429 above 100 req/s',
  source: 'direct-observation',
  tags: ['stripe', 'rate-limit'],
});

const memories = await brain.recall('stripe rate limit');

await brain.waitForIdle();
brain.close();
```

### Python

```bash
pip install audrey-memory
```

```python
from audrey_memory import Audrey

brain = Audrey(
    base_url="http://127.0.0.1:3487",
    api_key="secret",
    agent="support-agent",
)

memory_id = brain.encode(
    "Stripe returns HTTP 429 above 100 req/s",
    source="direct-observation",
)
results = brain.recall("stripe rate limit", limit=5)
brain.close()
```

## Key Commands

```bash
# Setup
npx audrey demo
npx audrey mcp-config codex
npx audrey mcp-config generic

# MCP integration
npx audrey install
npx audrey uninstall

# Health and maintenance
npx audrey status
npx audrey dream
npx audrey reembed
npx audrey observe-tool --event PostToolUse --tool Bash --outcome failed

# Sidecar
npx audrey serve
node examples/ollama-memory-agent.js "Use Audrey memory before answering"
docker compose up -d --build
```

Before risky actions, hosts can call `memory_preflight` or `memory_reflexes` over MCP, or `POST /v1/preflight` / `POST /v1/reflexes` over REST. Preflight returns the risk briefing. Reflexes return trigger-response rules such as "Before using npm test, review the prior EPERM failure path."

## Benchmarks

Audrey ships with a benchmark harness and release gate:

```bash
npm run bench:memory
npm run bench:memory:check
```

The benchmark suite measures:

- retrieval behavior
- update and overwrite behavior
- delete and abstain behavior
- semantic and procedural merge behavior

Current repo snapshot:

![Audrey local benchmark](docs/assets/benchmarks/local-benchmark.svg)

For detailed methodology, published comparison anchors, and generated reports, see [docs/benchmarking.md](docs/benchmarking.md).

## Production

Audrey is strongest in workflows where memory must stay local, reviewable, and durable. It already fits well as a sidecar for internal agents in operational domains like financial services and healthcare operations, but it is a memory layer, not a compliance boundary.

Production guide: [docs/production-readiness.md](docs/production-readiness.md)

Examples:

- [examples/fintech-ops-demo.js](examples/fintech-ops-demo.js)
- [examples/healthcare-ops-demo.js](examples/healthcare-ops-demo.js)
- [examples/stripe-demo.js](examples/stripe-demo.js)

## Environment

Starter config:

- [.env.example](.env.example)
- [.env.docker.example](.env.docker.example)

Key environment variables:

- `AUDREY_DATA_DIR`
- `AUDREY_EMBEDDING_PROVIDER`
- `AUDREY_LLM_PROVIDER`
- `AUDREY_DEVICE`
- `AUDREY_API_KEY`
- `AUDREY_HOST`
- `AUDREY_PORT`

## Documentation

- [docs/benchmarking.md](docs/benchmarking.md)
- [docs/audrey-for-dummies.md](docs/audrey-for-dummies.md)
- [docs/future-of-llm-memory.md](docs/future-of-llm-memory.md)
- [docs/production-readiness.md](docs/production-readiness.md)
- [docs/mcp-hosts.md](docs/mcp-hosts.md)
- [docs/ollama-local-agents.md](docs/ollama-local-agents.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)

## Development

```bash
npm ci
npm test
npm run bench:memory:check
npm run pack:check
python -m unittest discover -s python/tests -v
python -m build --no-isolation python
```

## License

MIT. See [LICENSE](LICENSE).
