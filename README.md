<div align="center">
  <img src="docs/assets/audrey-wordmark.png" alt="Audrey wordmark" width="760">

  <p><strong>The local-first memory firewall for AI agents.</strong></p>

  <p>
    Give Codex, Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, JetBrains, Ollama-backed agents,
    and custom agent services one durable memory layer they can check before they touch tools.
  </p>

  <p>
    <a href="https://github.com/Evilander/Audrey/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Evilander/Audrey/actions/workflows/ci.yml/badge.svg?branch=master"></a>
    <a href="https://www.npmjs.com/package/audrey"><img alt="npm version" src="https://img.shields.io/npm/v/audrey.svg"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  </p>
</div>

## Why Audrey Exists

Agents forget the exact mistakes they made yesterday. They repeat broken commands, lose project-specific rules, miss contradictions, and treat every new session like a cold start.

Audrey Guard is the headline loop: record what happened, remember what mattered, check before action, return `allow`, `warn`, or `block` with evidence, then validate whether the memory helped.

Audrey turns those hard-won lessons into a local memory runtime:

- `audrey guard --tool Bash "npm run deploy"` runs memory-before-action from the terminal.
- `memory_recall` finds durable context by semantic similarity.
- `memory_preflight` checks prior failures, risks, rules, and relevant procedures before an action.
- `memory_reflexes` converts remembered evidence into trigger-response guidance agents can follow.
- `memory_validate` closes the loop after the action: `helpful`, `used`, or `wrong` outcomes feed salience and can bind back to the exact preflight event, evidence ids, and Guard action fingerprint.
- `memory_dream` consolidates episodes into principles and applies decay.
- `audrey impact` and `audrey doctor` tell a human or CI system whether the runtime is doing real work and is actually ready.

It is not a hosted vector database, a notes app, or a Claude-only plugin. Audrey is a SQLite-backed continuity layer that can sit under any local or sidecar agent loop.

<div align="center">
  <img src="docs/assets/audrey-feature-grid.jpg" alt="Audrey feature marks: memory continuity, archive signal, recall loop, layered evidence, local node, and remembering before acting" width="760">
</div>

## Quick Start

Requires Node.js 20+.

```bash
npx audrey doctor
npx audrey demo --scenario repeated-failure
npx audrey guard --tool Bash "npm run deploy"
```

`doctor` verifies Node, the MCP entrypoint, provider selection, memory-store health, and host config generation. The repeated-failure demo is no-key, no-host, and no-network: it creates a temporary store, records a failed deploy, teaches Audrey the fix, then shows Audrey Guard blocking the repeat attempt with evidence.

Expected first-run shape:

```text
Audrey Doctor v1.0.0
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
npx audrey hook-config claude-code
```

Claude Code can be registered directly:

```bash
npx audrey install
claude mcp list
```

For memory-before-action hooks, preview with `npx audrey hook-config
claude-code`, then apply with `npx audrey hook-config claude-code --apply
--scope project` for `.claude/settings.local.json` or `--scope user` for
`~/.claude/settings.json`. Audrey merges the hook block into existing settings
and writes a timestamped backup before changing a non-empty file. The generated
`PreToolUse` hook runs `audrey guard --hook --fail-on-warn`; the `PostToolUse`
and `PostToolUseFailure` hooks record redacted tool traces. Verify the active
hook set inside Claude Code with `/hooks`.

All local MCP paths default to local embeddings and one shared SQLite-backed memory directory. **Set a distinct `AUDREY_DATA_DIR` per tenant, agent identity, or concurrent host.** SQLite uses WAL mode without an advisory lock, so two processes sharing a directory will contend on writes. Isolation is a hard requirement for multi-agent setups, not a recommendation.

Installer-generated host config does not include provider API keys by default. Prefer setting `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY` in the host runtime environment; use `npx audrey install --include-secrets` only if you explicitly accept argv/config exposure.

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
| MCP stdio server | 20 tools plus status/recent/principles resources and briefing/recall/reflection prompts |
| CLI | `doctor`, `demo`, `guard`, `install`, `mcp-config`, `hook-config`, `status`, `dream`, `reembed`, `observe-tool`, `promote`, `impact` |
| REST API | Hono server with `/health` and `/v1/*` routes |
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
npm run release:gate
npm run python:release:check
npm run bench:guard:card
npm run bench:guard:validate
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

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `AUDREY_DATA_DIR` | `~/.audrey/data` | SQLite memory store path. Use one per tenant or agent identity for isolation. |
| `AUDREY_AGENT` | `local-agent` | Logical agent identity stamped on writes. |
| `AUDREY_EMBEDDING_PROVIDER` | `local` | `local`, `gemini`, `openai`, or `mock`. Cloud providers require explicit opt-in. |
| `AUDREY_LLM_PROVIDER` | auto | `anthropic`, `openai`, or `mock`. |
| `AUDREY_DEVICE` | `gpu` | Local embedding device (`gpu` or `cpu`). Falls back to CPU if GPU init fails. |
| `AUDREY_PORT` | `7437` | REST sidecar port. |
| `AUDREY_HOST` | `127.0.0.1` | REST sidecar bind address. Set to `0.0.0.0` only with `AUDREY_API_KEY`. |
| `AUDREY_API_KEY` | unset | Bearer token required for non-loopback REST traffic. |
| `AUDREY_ALLOW_NO_AUTH` | `0` | Set to `1` to allow non-loopback bind without an API key. Don't. |
| `AUDREY_ENABLE_ADMIN_TOOLS` | `0` | Set to `1` to enable export, import, and forget routes/tools. Disabled by default. |
| `AUDREY_PROMOTE_ROOTS` | unset | Colon/semicolon-separated extra roots for `audrey promote --yes` writes. By default writes are restricted to `process.cwd()`. |
| `AUDREY_DEBUG` | `0` | Set to `1` to print MCP info logs (server started, warmup completed). Errors always log. |
| `AUDREY_PROFILE` | `0` | Set to `1` to emit per-stage timings via MCP `_meta.diagnostics`. |
| `AUDREY_DISABLE_WARMUP` | `0` | Set to `1` to skip background embedding warmup at MCP boot. |
| `AUDREY_ONNX_VERBOSE` | `0` | Set to `1` to restore ONNX runtime EP-assignment warnings (suppressed by default). |
| `AUDREY_PRAGMA_DEFAULTS` | `1` | Set to `0` to revert SQLite PRAGMA tuning to better-sqlite3 defaults. |
| `AUDREY_CONTEXT_BUDGET_CHARS` | `4000` | Default Memory Capsule character budget. |

## Benchmarks

Audrey ships three benchmark families.

### Performance snapshot

`npm run bench:perf-snapshot` measures encode and hybrid recall latency at multiple corpus sizes against the in-process mock provider. It reports p50/p95/p99 plus machine provenance so the numbers are reproducible and honest about what they cover.

```bash
npm run build
npm run bench:perf-snapshot                                 # default sizes 100, 1000, 5000
node benchmarks/perf-snapshot.js --sizes 1000,10000 --json  # custom shape
```

Sample output from `benchmarks/snapshots/perf-0.22.2.json` (24-core Ryzen 9 7900X3D, Node 25.5.0, mock 64-dim embedding, hybrid recall, limit 5):

| Corpus size | Encode p50 (ms) | Encode p95 (ms) | Recall p50 (ms) | Recall p95 (ms) | Recall p99 (ms) |
|---|---|---|---|---|---|
| 100 | 0.33 | 0.59 | 0.54 | 1.82 | 2.71 |
| 1,000 | 0.31 | 2.15 | 1.57 | 2.36 | 21.18 |
| 5,000 | 0.31 | 1.84 | 2.09 | 3.42 | 16.58 |

These numbers cover Audrey's own pipeline (SQLite + sqlite-vec + hybrid ranking) and exclude embedding-provider cost. Real-world recall p95 with a local 384-dim provider is typically 5-15x higher; with a hosted provider it is dominated by the API round-trip. Run on your own hardware before quoting numbers anywhere.

### Behavioral regression suite

`npm run bench:memory:check` is a release gate. It runs a small set of retrieval and lifecycle scenarios (information extraction, knowledge updates, multi-session reasoning, conflict resolution, privacy boundary, overwrite, delete-and-abstain, semantic/procedural merge) against Audrey and three weak baselines (vector-only, keyword+recency, recent-window) and asserts Audrey doesn't regress. The baseline comparisons exist to catch correctness regressions in retrieval logic, not to make marketing claims.

```bash
npm run bench:memory          # full regression suite (writes JSON + report)
npm run bench:memory:check    # release gate, exits non-zero on regression
```

### GuardBench comparative suite

`npm run bench:guard:check` runs Audrey's local GuardBench comparative suite:
ten pre-action scenarios across Audrey Guard, no-memory, recent-window,
vector-only, and FTS-only adapters. The scenarios cover exact repeated
failures, required procedures, changed file scopes, changed commands,
recovered failures, recall degradation, redaction safety, conflicting
instructions, and noisy stores. It writes
`benchmarks/output/guardbench-summary.json`,
`benchmarks/output/guardbench-manifest.json`, and
`benchmarks/output/guardbench-raw.json`. The emitted manifest, summary, and raw
output shapes are validated by JSON schemas under `benchmarks/schemas/`.

Latest local result in this checkout: 10/10 scenarios passed, 100% prevention
rate (5 of 10 scenarios expect a `block`), 0% false-block rate, 0 raw secret
leaks, 0 published artifact leaks in the raw-secret sweep, and 3.214ms /
21.395ms p50/p95 guard latency. **Methodology caveats, on purpose**: all
numbers are produced against the in-process mock 64-dim embedding provider
documented in the run's `provenance` block — they characterize Audrey's
controller and SQLite path, not real-provider end-to-end latency or
production false-positive rates. Local baseline decision accuracy was:
no-memory 10%, recent-window 60%, vector-only 40%, and FTS-only 10%; none of
the local baselines passed the GuardBench decision-plus-evidence contract,
which since v1.0.1 requires the correct decision plus at least one returned
evidence id for `block`/`warn` scenarios (no longer Audrey-specific lineage
phrasing — see `CHANGELOG.md#101---2026-05-15`). External-system numbers for
Mem0 and Zep are explicitly out of scope for this paper; live credentialed
runs land in a v2 paper after raw evidence bundles publish.

```bash
npm run bench:guard
npm run bench:guard:check
npm run bench:guard:manifest
npm run bench:guard:validate
npm run bench:guard:card
npm run bench:guard:bundle
npm run bench:guard:bundle:verify
npm run bench:guard:leaderboard
npm run bench:guard:adapter-registry:validate
npm run bench:guard:adapter-module:validate
npm run bench:guard:adapter-self-test
npm run bench:guard:adapter-self-test:validate
npm run bench:guard:publication:verify
npm run bench:guard:adapter-smoke
npm run bench:guard:adapter-conformance
npm run bench:guard:external:dry-run
npm run bench:guard:mem0 -- --dry-run
npm run bench:guard:zep -- --dry-run
node benchmarks/adapter-self-test.mjs --adapter ./path/to/adapter.mjs
node benchmarks/guardbench.js --adapter ./path/to/adapter.mjs --check
```

External GuardBench adapters are ESM modules that export either `default`,
`adapter`, or `createGuardBenchAdapter()`. The adapter receives scenario seed
data and the proposed action, but the harness withholds `expectedDecision` and
`requiredEvidence` until scoring. Start from
`benchmarks/adapters/example-allow.mjs` when wiring a new system. Adapter
authors can import `defineGuardBenchAdapter()` and `defineGuardBenchResult()`
from `benchmarks/adapter-kit.mjs` to validate module shape and decision output
while developing.

The published adapter registry lives at `benchmarks/adapters/registry.json`.
Run `npm run bench:guard:adapter-registry:validate` to verify registry shape,
adapter paths, and credential-free module loading.

Before running the full self-test, validate the ESM module shape quickly:

```bash
npm run bench:guard:adapter-module:validate -- --adapter ./path/to/adapter.mjs
```

Before publishing a new adapter, run `npm run bench:guard:adapter-self-test --
--adapter ./path/to/adapter.mjs`. The self-test validates the external adapter
contract and row conformance while explicitly allowing low benchmark scores, so
authors can separate "valid submission shape" from "competitive GuardBench
performance." The generated self-test report is validated against
`benchmarks/schemas/guardbench-adapter-self-test.schema.json`. Reviewers can
validate a submitted report without rerunning an adapter through `npm run
bench:guard:adapter-self-test:validate -- --report ./guardbench-adapter-self-test.json`.

Audrey ships external adapters for Mem0 Platform and Zep Cloud. Run them only
with runtime API keys:

```bash
set MEM0_API_KEY=...
npm run bench:guard:mem0

set ZEP_API_KEY=...
npm run bench:guard:zep
```

The Zep adapter uses the current REST surface for users, sessions, `memory.add`,
`graph.search`, and benchmark-user cleanup. If Zep graph ingestion needs more
time in a live account, set `ZEP_GUARDBENCH_INGEST_DELAY_MS` before the run.

Run `npm run bench:guard:external:dry-run` before coordinating credentialed
runs. It walks the runtime-env adapter registry, writes non-secret
`external-run-metadata.json` files for each adapter, and reports which runtime
environment variables are still missing. The external dry-run matrix report is schema-bound by
`benchmarks/schemas/guardbench-external-dry-run.schema.json` and written to
`benchmarks/output/external/guardbench-external-dry-run.json`.

Run `npm run bench:guard:external:evidence` after dry-runs or live runs to
write `benchmarks/output/external/guardbench-external-evidence.json`. This
external evidence verification report is schema-bound by
`benchmarks/schemas/guardbench-external-evidence.schema.json`, treats dry-run
or missing-key rows as pending in normal release gates, and checks that saved
metadata does not contain runtime credential values. Use
`npm run bench:guard:external:evidence:strict` when Mem0/Zep keys have been
provided; strict mode fails until every runtime-env adapter has a passed live
bundle.

External runs write `external-run-metadata.json` alongside the GuardBench
summary, manifest, and raw output bundle under
`benchmarks/output/external/<adapter>/`. The external runner validates the
emitted bundle with `benchmarks/validate-guardbench-artifacts.mjs` before
marking the run passed, and separately records adapter conformance so a valid
low-scoring adapter is distinguished from a malformed adapter. When
`external-run-metadata.json` is present, the validator also checks it against
`benchmarks/schemas/guardbench-external-run.schema.json` and verifies any
recorded SHA-256 artifact hashes against the bundle on disk.

For a shareable submission artifact, run `npm run bench:guard:card -- --dir
<output-dir>`. This writes `guardbench-conformance-card.json` with the subject
name, run status, score, conformance result, artifact hashes, optional
external-run metadata hash, and machine provenance. The standalone validator
checks the card when it is present.

For a portable submission directory, run `npm run bench:guard:bundle -- --dir
<output-dir>`. This creates `submission-bundle/` with the raw GuardBench
artifacts, conformance card, JSON schemas, validation report, and
`submission-manifest.json` with SHA-256 hashes for every bundled file.
Reviewers can run `npm run bench:guard:bundle:verify -- --dir
<submission-bundle>` to check manifest hashes, bundled schemas, and artifact
validation from the bundle alone.

For benchmark aggregation, run `npm run bench:guard:leaderboard -- --bundle
<submission-bundle>`. The leaderboard builder verifies each bundle before
ranking and writes JSON plus Markdown reports under `benchmarks/output/leaderboard/`.

Before publishing benchmark artifacts, run `npm run
bench:guard:publication:verify`. This single benchmark-focused verifier checks
the adapter registry, default adapter module, adapter self-test report,
GuardBench manifest/summary/raw artifacts, submission bundle, external dry-run
matrix, external evidence verification report, leaderboard, and a local
absolute-path sweep over the public artifact set.
The verifier validates its own machine-readable report against
`benchmarks/schemas/guardbench-publication-verification.schema.json` before it
exits.

Before turning the paper into public posts or submissions, run `npm run
paper:claims`. It validates `docs/paper/claim-register.json` against the
current paper, README, GuardBench artifacts, publication verifier, and external
evidence status so pending Mem0/Zep live-score claims cannot slip into public
copy.
Run `npm run paper:publication-pack` to verify the ready-to-use arXiv, Hacker
News, Reddit, X, and LinkedIn drafts in `docs/paper/publication-pack.json`
before browser-based submission. The X URL reserve is explicit: the first X
post carries `reservedUrlChars: 24`, and submitted artifact-url targets in
`browser-launch-results.json` must record the final `artifactUrl`.
Run `npm run paper:arxiv` to generate a deterministic TeX source package under
`docs/paper/output/arxiv/`, and `npm run paper:arxiv:verify` to check hashes,
citation conversion, bibliography coverage, seeded-secret redaction, and local
absolute-path leakage before arXiv upload.
Run `npm run paper:arxiv:compile` to record a schema-bound compile report at
`docs/paper/output/arxiv-compile-report.json`. It attempts `tectonic`,
`latexmk`, `pdflatex`/`bibtex`, or `uvx tecto` with a local bundle proxy when
available; `npm run paper:arxiv:compile:strict` stays blocked on hosts without
supported TeX tooling.
Run `npm run paper:launch-plan` to verify
`docs/paper/browser-launch-plan.json`, which maps those drafts to manual
browser targets, login/captcha expectations, platform-rule checks, source
URLs, and post-submit URL capture.
Run `npm run paper:launch-results` to validate
`docs/paper/browser-launch-results.json`, the post-submit ledger for arXiv,
Hacker News, Reddit, X, and LinkedIn targets. The normal verifier allows
pending rows with explicit blockers; `npm run paper:launch-results:strict`
fails until every target has a submitted, operator-verified public URL.
Run `npm run paper:bundle` to generate
`docs/paper/output/submission-bundle/`, a hash-manifested package containing
paper sources, claim and publication registers, GuardBench outputs, schemas,
and package metadata. `npm run paper:bundle:verify` checks the manifest and
file hashes before browser upload.
Run `npm run release:readiness` for the pending-aware Audrey 1.0 checklist.
It keeps code/paper readiness separate from publish blockers; `npm run
release:readiness:strict` fails until the 1.0 version surfaces,
source-control state, live remote-head verification, Python artifacts, npm
registry/auth readiness, PyPI publish readiness, arXiv compile proof, browser
publication URLs, and live Mem0/Zep evidence are complete.
Run `npm run release:cut:plan` to preview the exact 1.0 version/changelog
edits across npm, lockfile, MCP, and Python surfaces. `npm run
release:cut:apply -- --target-version 1.0.0` writes those edits only when the
final cut is intentional. The generated changelog section is release-note copy,
not a TODO scaffold; `release:readiness:strict` rejects placeholder changelog
markers before publication.
Run `npm run security:audit` before packaging or publishing; the release gates
call it after artifact verification so production dependency advisories cannot
slip past the final package check.

## Command Reference

```bash
# First contact
npx audrey doctor
npx audrey demo

# MCP setup
npx audrey install --host codex --dry-run
npx audrey mcp-config codex
npx audrey mcp-config generic
npx audrey hook-config claude-code
npx audrey install
npx audrey uninstall

# Health and maintenance
npx audrey status
npx audrey status --json --fail-on-unhealthy
npx audrey dream
npx audrey reembed

# Closed-loop visibility
npx audrey impact
npx audrey impact --json --window 7 --limit 5

# Tool-trace learning
npx audrey observe-tool --event PostToolUse --tool Bash --outcome failed
npx audrey promote --dry-run

# REST sidecar
npx audrey serve
copy .env.docker.example .env
# edit AUDREY_API_KEY in .env
docker compose up -d --build
```

The Node sidecar defaults to `127.0.0.1:7437`. The Docker image intentionally binds inside the container on `3487`, so Compose requires `AUDREY_API_KEY` in `.env` before startup. Override the published host port with `AUDREY_PUBLISHED_PORT` when using Compose.

## Documentation

- [Security policy](SECURITY.md)
- [Audrey paper outline](docs/AUDREY_PAPER_OUTLINE.md)
- Public setup, runtime, benchmark, and command guidance is maintained in this README.

## Development

Developer setup runs from source, not from the published tarball, so `npm run build` is required before any CLI subcommand resolves:

```bash
npm ci
npm run build
npm test
```

Once built, the `Quick Start` commands work against the local `dist/` output. The full release gate runs everything CI runs:

```bash
npm run release:gate
python -m unittest discover -s python/tests -v
npm run python:release:check
```

`npm test` uses a repo-local Vitest launcher so locked-down Windows temp
directories do not block test startup. `npm run release:gate:sandbox` remains
available for hosts that block child-process spawning entirely.

## License

MIT. See [LICENSE](LICENSE).
