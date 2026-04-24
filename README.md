<div align="center">
  <img src="docs/assets/audrey-wordmark.png" alt="Audrey wordmark" width="760">

  <p><strong>The local-first memory control plane for AI agents.</strong></p>

  <p>
    Give Codex, Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, JetBrains, Ollama-backed agents,
    and custom agent services one durable memory layer they can check before they act.
  </p>

  <p>
    <a href="https://github.com/Evilander/Audrey/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Evilander/Audrey/actions/workflows/ci.yml/badge.svg?branch=master"></a>
    <a href="https://www.npmjs.com/package/audrey"><img alt="npm version" src="https://img.shields.io/npm/v/audrey.svg"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  </p>
</div>

## Why Audrey Exists

Agents forget the exact mistakes they made yesterday. They repeat broken commands, lose project-specific rules, miss contradictions, and treat every new session like a cold start.

Audrey turns those hard-won lessons into a local memory runtime:

- `memory_recall` finds durable context by semantic similarity.
- `memory_preflight` checks prior failures, risks, rules, and relevant procedures before an action.
- `memory_reflexes` converts remembered evidence into trigger-response guidance agents can follow.
- `memory_dream` consolidates episodes into principles and applies decay.
- `audrey doctor` tells a human or CI system whether the runtime is actually ready.

It is not a hosted vector database, a notes app, or a Claude-only plugin. Audrey is a SQLite-backed continuity layer that can sit under any local or sidecar agent loop.

<div align="center">
  <img src="docs/assets/audrey-feature-grid.jpg" alt="Audrey feature marks: memory continuity, archive signal, recall loop, layered evidence, local node, and remembering before acting" width="760">
</div>

## Quick Start

Requires Node.js 20+.

```bash
npx audrey doctor
npx audrey demo
```

`doctor` verifies Node, the MCP entrypoint, provider selection, memory-store health, and host config generation. `demo` runs a no-key, no-host, no-network proof: it creates temporary memories, records a redacted failed tool trace, generates a Memory Capsule, proves recall, prints Memory Reflexes, and deletes the demo store.

Expected first-run shape:

```text
Audrey Doctor v0.21.0
Store health: not initialized
Verdict: ready
```

After the first real memory write, `doctor` should report the store as healthy.

## Install Into Agent Hosts

Preview host setup without editing config files:

```bash
npx audrey install --host codex --dry-run
npx audrey install --host claude-code --dry-run
npx audrey install --host generic --dry-run
```

Generate raw config blocks:

```bash
npx audrey mcp-config codex
npx audrey mcp-config generic
npx audrey mcp-config vscode
```

Claude Code can be registered directly:

```bash
npx audrey install
claude mcp list
```

All local MCP paths default to local embeddings and one shared SQLite-backed memory directory. Use `AUDREY_DATA_DIR` to isolate projects, tenants, or host identities.

## Use With Ollama And Local Agents

Ollama runs models; Audrey supplies memory. Start Audrey as a local REST sidecar and expose its routes as tools in your agent loop:

```bash
AUDREY_AGENT=ollama-local-agent npx audrey serve
curl http://localhost:7437/health
curl http://localhost:7437/v1/status
```

Runnable example:

```bash
AUDREY_AGENT=ollama-local-agent npx audrey serve
OLLAMA_MODEL=qwen3 node examples/ollama-memory-agent.js "What should you remember about Audrey?"
```

Core sidecar tools:

| Agent Need | REST Route |
|---|---|
| Check memory before acting | `POST /v1/preflight` |
| Get reflex rules for an action | `POST /v1/reflexes` |
| Store a useful observation | `POST /v1/encode` |
| Recall relevant context | `POST /v1/recall` |
| Get a turn-sized memory packet | `POST /v1/capsule` |
| Check health | `GET /v1/status` |

## What Ships

| Surface | Status |
|---|---|
| MCP stdio server | 19 tools, resources, and prompt templates |
| CLI | `doctor`, `demo`, `install`, `mcp-config`, `status`, `dream`, `reembed`, `observe-tool`, `promote` |
| REST API | Hono server with `/health`, `/openapi.json`, `/docs`, and `/v1/*` routes |
| JavaScript SDK | Direct TypeScript/Node import from `audrey` |
| Python client | `pip install audrey-memory`, calls the REST sidecar |
| Storage | Local SQLite plus `sqlite-vec`, no hosted database required |
| Deployment | npm package, Docker, Compose, host-specific MCP config generation |
| Safety loop | preflight warnings, reflexes, redacted tool traces, contradiction handling |

## Memory Model

Audrey is built around the parts of memory that matter for agents:

- Episodic memory: specific observations, tool results, preferences, and session facts.
- Semantic memory: consolidated principles extracted from repeated evidence.
- Procedural memory: remembered ways to act, avoid, retry, or verify.
- Affect and salience: emotional weight and importance influence recall.
- Interference and decay: stale, conflicting, or low-confidence memories lose authority over time.
- Contradiction handling: competing claims are tracked instead of silently overwritten.
- Tool-trace learning: failed commands and risky actions become future preflight warnings.

The product bet is simple: the next generation of useful agents will not just retrieve facts. They will remember what happened, decide whether a memory is still trustworthy, and use that memory before touching tools.

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

brain = Audrey(base_url="http://127.0.0.1:7437", agent="support-agent")
memory_id = brain.encode("Stripe returns HTTP 429 above 100 req/s", source="direct-observation")
results = brain.recall("stripe rate limit", limit=5)
brain.close()
```

## Production Readiness

Audrey is close to a 1.0-ready local memory runtime, but production depends on how it is embedded. Treat it like stateful infrastructure.

Release gates used for this package:

```bash
npm run build
npm run typecheck
npm run bench:memory:check
npm pack --dry-run
npx audrey doctor
npx audrey demo
```

Recommended runtime checks:

```bash
npx audrey doctor --json
npx audrey status --json --fail-on-unhealthy
npx audrey install --host codex --dry-run
```

Production controls you still own:

- Set one `AUDREY_DATA_DIR` per tenant, environment, or isolation boundary.
- Pin `AUDREY_EMBEDDING_PROVIDER` and `AUDREY_LLM_PROVIDER` explicitly.
- Back up the SQLite data directory before provider or dimension changes.
- Keep API keys and raw credentials out of encoded memory content.
- Use `AUDREY_API_KEY` if the REST sidecar is reachable beyond the local process boundary.
- Run `npx audrey dream` on a schedule so consolidation and decay stay current.
- Add application-level encryption, retention, access control, and audit logging for regulated environments.

Read the full guide: [docs/production-readiness.md](docs/production-readiness.md).

## Benchmarks

Audrey ships with a benchmark harness and release gate:

```bash
npm run bench:memory
npm run bench:memory:check
```

Current repo snapshot:

![Audrey local benchmark](docs/assets/benchmarks/local-benchmark.svg)

The benchmark suite covers retrieval behavior, overwrite behavior, delete/abstain behavior, and semantic/procedural merge behavior. For methodology and comparison anchors, see [docs/benchmarking.md](docs/benchmarking.md).

## Command Reference

```bash
# First contact
npx audrey doctor
npx audrey demo

# MCP setup
npx audrey install --host codex --dry-run
npx audrey mcp-config codex
npx audrey mcp-config generic
npx audrey install
npx audrey uninstall

# Health and maintenance
npx audrey status
npx audrey status --json --fail-on-unhealthy
npx audrey dream
npx audrey reembed

# Tool-trace learning
npx audrey observe-tool --event PostToolUse --tool Bash --outcome failed
npx audrey promote --dry-run

# REST sidecar
npx audrey serve
docker compose up -d --build
```

## Documentation

- [Audrey for Dummies](docs/audrey-for-dummies.md)
- [MCP host guide](docs/mcp-hosts.md)
- [Ollama and local agents](docs/ollama-local-agents.md)
- [Production readiness](docs/production-readiness.md)
- [Future of LLM memory](docs/future-of-llm-memory.md)
- [Benchmarking](docs/benchmarking.md)
- [Security policy](SECURITY.md)

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run bench:memory:check
npm run pack:check
python -m unittest discover -s python/tests -v
python -m build --no-isolation python
```

On some locked-down Windows hosts, Vitest/Vite can fail before tests start with `spawn EPERM`. That is an environment process-spawn blocker, not an Audrey runtime failure. Use build, typecheck, benchmark, pack dry-run, direct `dist/` smokes, and GitHub Actions as the release evidence path.

## License

MIT. See [LICENSE](LICENSE).
