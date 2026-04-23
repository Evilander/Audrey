# Audrey

[![CI](https://github.com/Evilander/Audrey/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Evilander/Audrey/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/audrey.svg)](https://www.npmjs.com/package/audrey)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Audrey is a persistent memory and continuity engine for Claude Code and AI agents.

It gives an agent a local memory store, durable recall, consolidation, contradiction handling, a REST sidecar, MCP tools, and benchmark gates without adding external infrastructure.

Requires Node.js 20+.

## Quick Start

### Claude Code

```bash
npx audrey init
npx audrey doctor
```

This uses the default `local-offline` preset:

- registers Audrey with Claude Code
- installs hooks for automatic recall and reflection
- uses local embeddings by default
- stores memory in one local SQLite-backed data directory

### REST or Docker Sidecar

```bash
npx audrey init sidecar-prod
docker compose up -d --build
```

Then verify:

```bash
npx audrey doctor
curl http://localhost:3487/health
```

## Why Audrey

- Local-first: memory lives in SQLite with `sqlite-vec`, not a hosted vector database.
- Practical: MCP, CLI, REST, JavaScript, Python, and Docker are all first-class.
- Durable: snapshot, restore, health checks, benchmark gates, and graceful shutdown are built in.
- Structured: Audrey does more than save notes. It consolidates, decays, tracks contradictions, and supports procedural memory.

## What Ships

- Claude Code MCP server with 13 memory tools
- Automatic hook-based recall and reflection for Claude Code sessions
- JavaScript SDK
- Python SDK packaged as `audrey-memory`
- REST API for sidecar deployment
- Docker and Compose deployment path
- Snapshot and restore for portable memory state
- Machine-readable health and benchmark gates
- Local benchmark harness with retrieval and lifecycle-operation tracks

## Setup Presets

`npx audrey init` supports four named presets:

| Preset | Best For | Behavior |
|---|---|---|
| `local-offline` | Claude Code on one machine | Local embeddings, MCP install, hooks install |
| `hosted-fast` | Claude Code with provider keys already present | Auto-picks hosted providers from env, MCP install, hooks install |
| `ci-mock` | CI and smoke tests | Mock embedding + LLM providers, no Claude-specific setup |
| `sidecar-prod` | REST API and Docker deployment | Sidecar-oriented defaults, no Claude-specific setup |

Useful checks:

```bash
npx audrey doctor
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
npx audrey init
npx audrey init hosted-fast
npx audrey init ci-mock
npx audrey init sidecar-prod

# Claude Code integration
npx audrey install
npx audrey hooks install
npx audrey hooks uninstall
npx audrey uninstall

# Health and maintenance
npx audrey doctor
npx audrey status
npx audrey dream
npx audrey reembed

# Versioning
npx audrey snapshot
npx audrey restore backup.json --force

# Sidecar
npx audrey serve
docker compose up -d --build
```

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
- [docs/production-readiness.md](docs/production-readiness.md)
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
