# Audrey Industry Standard Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Author:** Tyler Eveland + Claude
**Current Version:** 0.17.0 (npm latest)
**Target:** 1.0 release as the industry-standard memory layer for AI agents

---

## Executive Summary

Audrey is the only AI memory system that models memory as a living biological process: encoding, consolidation, interference, decay, affect, and dreaming. This spec defines the path from v0.17.0 to v1.0 and industry-standard status across three staged goals:

1. **Developer gravity** (v0.18–0.22): TypeScript, HTTP API, Python SDK, benchmarks, MCP expansion
2. **Ecosystem reach** (v0.23–0.28): Framework integrations, encryption, multi-agent, observability, dashboard
3. **Enterprise & research** (v0.29–1.0): Paper, Docker, RBAC, audit logging, launch

Execution model: solo developer, layered releases every 2-3 weeks, ~30 weeks total.

---

## Vision & Positioning

**One-liner:** Audrey is to AI agent memory what PostgreSQL is to databases — the thoughtful, production-grade choice that gets the fundamentals right.

**Core thesis:** Every other memory system is a storage layer pretending to be memory. Mem0 is a key-value store with a graph bolted on. Letta is an editable context buffer. MIRIX is a research prototype with no production story. Audrey is the only system that models memory as a living biological process and ships it as production-grade infrastructure.

### Competitive Positioning

| Competitor | LoCoMo Score | What They Are | Audrey's Edge |
|---|---|---|---|
| Mem0 | 66.9 | Key-value store + graph layer | 6-signal confidence, consolidation, contradiction tracking, affect, dreaming |
| Letta | 74.0 | Context engineering (editable blocks) | Automatic memory management vs. manual. Scales without human intervention. |
| MIRIX | 85.4 | Research-grade typed multimodal | Zero-infrastructure production deployment. No npm, no CLI, no community. |
| MemOS | N/A | Memory-as-OS abstraction (academic) | Shipping code: 14 npm releases, 468+ tests, CI, benchmarks. |
| OpenAI Memory | 52.9 | Black-box hosted memory | Open source, inspectable, local, customizable. You own your data. |

### Narrative

"Most AI memory tools save everything and forget nothing. That's not memory — it's a filing cabinet. Real memory consolidates, forgets, contradicts, and dreams. Audrey brings that to production."

---

## Current State (v0.17.0)

### Strengths

- 24 focused source modules with clean architecture
- Biological fidelity: episodic, semantic, procedural, causal memory types
- 6-signal confidence scoring: source reliability, evidence agreement, recency decay, retrieval reinforcement, interference, context matching
- Affect system: valence/arousal encoding, Yerkes-Dodson curve, mood-congruent recall, emotional resonance
- Dream cycle: consolidation + decay + stats
- Contradiction detection and truth resolution
- 13 MCP tools registered as audrey-memory
- Full CLI: install, uninstall, status, greeting, reflect, dream, reembed
- Benchmark harness with SVG/HTML reports and CI regression gates
- 4 embedding providers: Mock, Local (MiniLM 384d), OpenAI (1536d), Gemini (3072d)
- 3 LLM providers: Mock, Anthropic, OpenAI
- Zero-infrastructure: SQLite + sqlite-vec, single file
- 468+ passing tests across 30 test files
- CI: GitHub Actions with Node 18/20/22 on Ubuntu + Windows smoke
- Production readiness docs for fintech and healthcare ops
- Published on npm with 14 versions since Feb 20, 2026

### Gaps

- No TypeScript (JSDoc only)
- No Python SDK
- JavaScript-only, MCP-only — no REST API, no framework integrations
- No direct LoCoMo/LongMemEval benchmark reproduction
- No multi-tenant/multi-agent shared memory
- No web dashboard or visual exploration
- No Docker image, no managed service option
- No encryption at rest, no RBAC
- Limited community presence

---

## Stage 1: Developer Gravity (v0.18 – v0.22)

### v0.18: TypeScript Conversion

The single highest-leverage credibility move.

**Scope:**

- Convert all 24 `src/` modules from `.js` to `.ts`
- Convert `mcp-server/` to TypeScript
- Publish `.d.ts` declarations in the npm package
- Ship strict types for all public APIs: `EncodeParams`, `RecallOptions`, `RecallResult`, `AudreyConfig`, `EmbeddingProvider`, `LLMProvider`
- Zero breaking API changes — same surface, typed
- Update all 30 test files (keep vitest, add type checking)
- Add `tsconfig.json` with strict mode
- Build step: `tsc` compiles to `dist/`, npm package ships compiled JS + declarations
- Update `package.json` exports to point at `dist/` paths. The public API (`import { Audrey } from 'audrey'`) stays identical — only the internal file layout changes. Treat this as non-breaking since consumers use the package name, not file paths.

**Acceptance criteria:**

- `npm install audrey` provides full autocomplete in VS Code and JetBrains
- All existing tests pass
- `npm run bench:memory:check` passes
- No breaking changes to any public API

**Estimated effort:** 2 weeks

### v0.19: HTTP API Server Mode

Unlocks multi-language access. The bridge to Python and every other ecosystem.

**Scope:**

- New CLI command: `npx audrey serve --port 7437`
- Lightweight HTTP framework: Hono (fast, small, few deps) — added as a dependency
- RESTful endpoints wrapping all 13 MCP tools:

  ```
  POST   /v1/encode          → memory_encode
  POST   /v1/recall          → memory_recall
  POST   /v1/consolidate     → memory_consolidate
  POST   /v1/dream           → memory_dream
  GET    /v1/introspect      → memory_introspect
  POST   /v1/resolve-truth   → memory_resolve_truth
  GET    /v1/export          → memory_export
  POST   /v1/import          → memory_import
  POST   /v1/forget          → memory_forget
  POST   /v1/decay           → memory_decay
  GET    /v1/status          → memory_status
  POST   /v1/reflect         → memory_reflect
  POST   /v1/greeting        → memory_greeting
  GET    /health             → liveness probe
  ```

- Auto-generated OpenAPI spec from existing Zod schemas
- API key auth via `AUDREY_API_KEY` env var (optional, off by default for local dev)
- MCP mode unchanged — existing users unaffected

**Acceptance criteria:**

- `npx audrey serve` starts HTTP server
- Every endpoint returns correct results matching MCP tool behavior
- OpenAPI spec is valid and browsable at `/docs`
- All existing MCP tests still pass
- New HTTP API test suite covers all endpoints

**Estimated effort:** 1 week

### v0.20: Python SDK Alpha

Unlocks the 60%+ of AI agent developers who work in Python.

**Scope:**

- Package: `audrey-memory` on PyPI
- Thin HTTP client wrapping the REST API from v0.19
- Sync and async APIs:

  ```python
  from audrey import Audrey

  brain = Audrey(base_url="http://localhost:7437")
  memory_id = brain.encode(
      content="Stripe API returns 429 above 100 req/s",
      source="direct-observation",
      tags=["stripe", "rate-limit"],
      context={"task": "debugging", "domain": "payments"},
      affect={"valence": -0.4, "arousal": 0.7, "label": "frustration"},
  )
  results = brain.recall("stripe rate limits", limit=5)
  dream_result = brain.dream()
  ```

  ```python
  from audrey import AsyncAudrey

  async with AsyncAudrey(base_url="...") as brain:
      await brain.encode(...)
  ```

- Full type hints (py.typed marker)
- Uses `httpx` for HTTP, `pydantic` for response models
- README with quickstart, agent integration patterns

**Acceptance criteria:**

- `pip install audrey-memory` works
- Sync and async APIs cover all 13 operations
- Type hints pass `mypy --strict`
- Integration tests against a running `npx audrey serve`

**Estimated effort:** 2 weeks

### v0.21: LoCoMo Benchmark Adapter

The credibility move for the research community. Gives Audrey a directly comparable number.

**Scope:**

- Adapter that runs the LoCoMo benchmark protocol against Audrey
- Downloads or references the LoCoMo dataset
- Maps LoCoMo evaluation categories to Audrey operations
- Uses real embedding provider (Gemini or OpenAI) for meaningful scores
- CI gate: `npm run bench:locomo` fails if score drops below threshold
- Published results in README with full methodology
- Also add LongMemEval adapter for multi-session reasoning

**Acceptance criteria:**

- Reproducible LoCoMo score published
- Score exceeds Mem0 baseline (66.9)
- CI gate prevents regression
- Methodology is documented well enough for independent reproduction

**Target score:** >70 on LoCoMo (achievable given consolidation + contradiction handling)

**Estimated effort:** 2 weeks

### v0.22: MCP Ecosystem Expansion

Expand from Claude Code to every MCP-compatible host.

**Scope:**

- Test and document Audrey with: Cursor, Windsurf, VS Code Copilot, JetBrains AI
- Per-host installation guide in docs
- MCP resource endpoints: expose memory stats, recent episodes, and principles as browsable resources (not just tools)
- MCP prompt templates: pre-built prompts for greeting, reflection, and recall
- Submit to Anthropic MCP server directory/registry

**Acceptance criteria:**

- Audrey confirmed working in 4+ MCP hosts
- Installation guide for each host
- Resource endpoints serve memory data
- Listed in at least one MCP directory

**Estimated effort:** 1 week

---

## Stage 2: Ecosystem Reach (v0.23 – v0.28)

### v0.23: LangChain Integration

**Scope:**

- Package: `audrey-langchain` (npm) and `audrey-langchain` (PyPI)
- Implements LangChain's `BaseMemory` / `BaseChatMemory` interface
- Works with LangGraph agents as a state manager
- Example: "Add biological memory to a LangGraph customer support agent"
- Listed in LangChain community integrations

**Acceptance criteria:**

- LangChain agent can encode and recall using Audrey as its memory backend
- Example agent runs end-to-end

**Estimated effort:** 1 week

### v0.24: Vercel AI SDK Integration

**Scope:**

- Package: `audrey-ai-sdk`
- Tool definitions for Vercel AI SDK `tool()` interface
- Memory-aware middleware: auto-encode conversation turns, auto-recall context
- Example: "Build a Next.js chat app with biological memory"

**Acceptance criteria:**

- Vercel AI SDK agent can use Audrey tools
- Example chat app runs end-to-end
- Works with streaming

**Estimated effort:** 1 week

### v0.25: Encryption at Rest

Required for regulated deployments (fintech, healthcare).

**Scope:**

- Two approaches, both implemented:
  1. **SQLCipher**: full-database encryption via `better-sqlite3-sqlcipher` as optional peer dependency
  2. **Application-level AES-256-GCM**: encrypt content fields before storage. Embeddings stay unencrypted (not reversible to content).
- Key management: `AUDREY_ENCRYPTION_KEY` env var or callback function for KMS integration
- Migration tool: `npx audrey encrypt` converts existing unencrypted database
- Configuration: `encryption: { mode: 'sqlcipher' | 'field-level', key: '...' }`

**Acceptance criteria:**

- Both encryption modes work
- Existing tests pass with encryption enabled
- `npx audrey encrypt` migrates a real database without data loss
- Key rotation documented

**Estimated effort:** 2 weeks

### v0.26: Multi-Agent Shared Memory

**Scope:**

- Formalize agent namespaces (already partially exists via `agent` config)
- Memory visibility: `private` (default, encoding agent only) or `shared` (all agents)
- Cross-agent recall: `brain.recall(query, { agents: ['support', 'escalation'] })`
- Memory attribution: recalled memories include the encoding agent's identity
- Shared consolidation: cross-agent episodes can consolidate into shared principles
- MCP and HTTP API updated with agent/visibility parameters

**Acceptance criteria:**

- Two Audrey instances with different agent names sharing the same SQLite database can share memories via shared visibility
- Private memories remain isolated per agent namespace
- Cross-agent recall returns attributed results

**Estimated effort:** 2 weeks

### v0.27: Observability

**Scope:**

- OpenTelemetry integration: spans for encode, recall, consolidate, dream
- Structured JSON logging: `AUDREY_LOG_FORMAT=json`
- Prometheus-compatible metrics endpoint: `GET /v1/metrics`
  - `audrey_encode_total`, `audrey_recall_latency_ms`, `audrey_memory_count`, `audrey_consolidation_duration_ms`, `audrey_dream_cycles_total`
- Grafana dashboard template (importable JSON)
- Health check: `GET /health` returns structured liveness + readiness status

**Acceptance criteria:**

- OTel traces appear in Jaeger/Zipkin when configured
- `/v1/metrics` returns Prometheus-format output
- Grafana dashboard imports cleanly and shows live data

**Estimated effort:** 2 weeks

### v0.28: Web Dashboard

**Scope:**

- `npx audrey dashboard` — launches local web UI on port 7438
- Lightweight frontend bundled in npm package (Preact + HTM or plain HTML + Alpine.js)
- Views:
  - **Memory Explorer:** browse, search, filter episodes/semantics/procedures with confidence scores
  - **Confidence Heatmap:** visualize confidence decay over time
  - **Contradiction Tracker:** open/resolved contradictions with linked claims
  - **Dream Log:** consolidation history, decay stats, health trends over time
  - **Causal Graph:** interactive visualization of causal links
- Read-only by default. Write operations behind `--allow-writes` flag.
- Powered by the HTTP API from v0.19

**Acceptance criteria:**

- `npx audrey dashboard` opens a browser with working memory explorer
- All five views render real data
- Dashboard works against any Audrey database (not just demo data)

**Estimated effort:** 3 weeks

---

## Stage 3: Enterprise & Research (v0.29 – 1.0)

### v0.29: Research Paper

**Scope:**

- Formal description of Audrey's biological memory model
- Empirical evaluation on LoCoMo and LongMemEval
- Ablation study: contribution of each biological component (affect, interference, consolidation, decay, contradiction detection)
- Comparison with Mem0, Letta, MIRIX on the same benchmarks
- Production analysis: latency, memory footprint, scaling characteristics
- Target venue: NeurIPS Workshop, EMNLP, or arXiv preprint

**Title:** "Biological Memory Architecture for Production AI Agents: Encoding, Consolidation, Interference, and Dreaming in Practice"

**Acceptance criteria:**

- Paper submitted to arXiv or conference
- All experimental results are reproducible from the repo

**Estimated effort:** 4 weeks

### v0.30: Docker & Deployment

**Scope:**

- Official Docker image published to Docker Hub (org `audreyai` or `evilander`, TBD based on availability) and GitHub Container Registry
  - Runs HTTP API server by default
  - Configurable via env vars
  - SQLite data on mounted volume
- Docker Compose template: Audrey + Grafana + Prometheus
- Helm chart for Kubernetes
- One-click deploy templates for Railway and Fly.io

**Acceptance criteria:**

- `docker run -p 7437:7437 audrey/audrey` starts a working server
- Docker Compose stack runs with monitoring
- Helm chart deploys to a Kubernetes cluster

**Estimated effort:** 1 week

### v0.31: RBAC & Audit Logging

**Scope:**

- Roles: `admin` (full access), `agent` (encode + recall + reflect), `reader` (recall only)
- API key scoping: each key assigned a role
- Audit log: separate SQLite table recording every operation (who, what, when, from where)
- Retention policies: auto-purge episodes older than N days, configurable
- HIPAA readiness documentation
- SOC2 control mapping document

**Acceptance criteria:**

- Reader API key cannot encode or forget
- Agent API key cannot purge or configure
- Audit log captures all operations with timestamps and actor identity
- Retention policy auto-purges on schedule

**Estimated effort:** 3 weeks

### v1.0 Release Candidate

**Scope:**

- API freeze: all v1.x releases are backwards-compatible
- Comprehensive migration guide from 0.x to 1.0
- Documentation site: hosted API reference, tutorials, concept guides
  - Generated from TypeScript types + inline docs
  - Hosted on Vercel or GitHub Pages
- Final test pass: all tests green on Node 18/20/22/24, Ubuntu + Windows + macOS

**Estimated effort:** 2 weeks

### v1.0 Launch

- Blog post: "Introducing Audrey 1.0: Biological Memory for AI Agents"
- Show HN post
- Product Hunt launch
- Twitter/X thread: the journey from 0.3.0 to 1.0
- Conference talk submission (AI Engineer Summit)

**Estimated effort:** 1 week

---

## Technical Architecture

### Current (v0.17)

```
Claude Code ──MCP──→ MCP Server ──→ Audrey Core (JS)
                                         │
                                    SQLite + sqlite-vec
```

### Target (v1.0)

```
┌──────────────────────────────────────────────────┐
│              Audrey Core (TypeScript)             │
│  encode | recall | consolidate | dream | affect   │
│  interference | contradiction | decay | causal    │
├──────────────┬───────────────┬───────────────────┤
│   MCP Server │   HTTP API    │   SDK (direct)    │
│   (stdio)    │   (Hono)      │   (import)        │
├──────────────┼───────────────┼───────────────────┤
│  Claude Code │  Python SDK   │  Node.js/TS apps  │
│  Cursor      │  LangChain    │  Vercel AI SDK    │
│  Windsurf    │  LlamaIndex   │  Mastra           │
│  JetBrains   │  CrewAI       │  Custom agents    │
└──────────────┴───────────────┴───────────────────┘
                       │
              SQLite + sqlite-vec
              (+ optional SQLCipher)
                       │
              ┌────────┴────────┐
              │   Observability │
              │   OTel + Metrics│
              └─────────────────┘
```

**Invariant:** The core never changes paradigm. SQLite stays. Zero-infrastructure stays. HTTP API and MCP server are thin transport wrappers over the same `Audrey` class.

### Python SDK Strategy

- **Phase 1 (v0.20):** HTTP client. Requires `npx audrey serve` running. Fast to build, validates demand.
- **Phase 2 (post-1.0, if demand):** Native Python port with its own SQLite. Only if HTTP client creates friction.

---

## Go-to-Market Strategy

### Content Per Release

| Release | Content |
|---|---|
| Every version | Changelog, Twitter thread, npm release |
| v0.18 (TS) | "Why We Rewrote Audrey in TypeScript" |
| v0.20 (Python) | "Add Biological Memory to Your Python Agent in 5 Minutes" |
| v0.21 (LoCoMo) | "Audrey vs. Mem0 vs. Letta: Memory Benchmark Results" |
| v0.23 (LangChain) | "LangChain Memory is Broken. Here's How to Fix It." |
| v0.28 (Dashboard) | Demo video / screen recording |
| v0.29 (Paper) | arXiv preprint + explainer thread |
| v1.0 | Full launch: blog + Show HN + Product Hunt + conference talk |

### Comparison Pages

- "Audrey vs. Mem0"
- "Audrey vs. Letta"
- "Audrey vs. ChatGPT Memory"
- "Best Memory for LangChain Agents"

### Community Timeline

| When | Action |
|---|---|
| v0.18 | GitHub Discussions enabled. Twitter/X presence active. |
| v0.22 | Discord server. MCP directory listing. |
| v0.24 | First external tutorial by a non-Tyler developer. |
| v0.28 | First conference talk submission. |
| v1.0 | Show HN. Product Hunt. Full launch. |

### Strategic Partnerships

1. **Anthropic:** MCP server showcase, reference memory implementation
2. **Vercel:** AI SDK integration showcase, potential Marketplace listing
3. **LangChain:** Community integration listing, co-authored tutorial
4. **Hugging Face:** Space demo, model card for the memory architecture

---

## Success Metrics

### Stage 1 (by v0.22)

| Metric | Target |
|---|---|
| npm weekly downloads | 500+ |
| GitHub stars | 1,000+ |
| PyPI weekly downloads | 100+ |
| External blog posts / tutorials | 3+ |
| MCP hosts tested & documented | 4+ |

### Stage 2 (by v0.28)

| Metric | Target |
|---|---|
| npm weekly downloads | 2,000+ |
| PyPI weekly downloads | 500+ |
| GitHub stars | 3,000+ |
| Framework integrations with >100 wkly downloads | 2+ |
| LoCoMo score | >70 |
| Discord members | 200+ |

### 1.0

| Metric | Target |
|---|---|
| npm + PyPI combined weekly downloads | 5,000+ |
| GitHub stars | 5,000+ |
| Production deployments (non-Tyler) | 3+ |
| Paper | Submitted or published |
| Enterprise inquiries | First inbound |
| Revenue | First dollar |

---

## Release Timeline

| Version | Focus | Duration | Cumulative |
|---|---|---|---|
| 0.18 | TypeScript conversion | 2 weeks | 2 weeks |
| 0.19 | HTTP API server | 1 week | 3 weeks |
| 0.20 | Python SDK alpha | 2 weeks | 5 weeks |
| 0.21 | LoCoMo benchmark adapter | 2 weeks | 7 weeks |
| 0.22 | MCP ecosystem expansion | 1 week | 8 weeks |
| 0.23 | LangChain integration | 1 week | 9 weeks |
| 0.24 | Vercel AI SDK integration | 1 week | 10 weeks |
| 0.25 | Encryption at rest | 2 weeks | 12 weeks |
| 0.26 | Multi-agent shared memory | 2 weeks | 14 weeks |
| 0.27 | Observability | 2 weeks | 16 weeks |
| 0.28 | Web dashboard | 3 weeks | 19 weeks |
| 0.29 | Research paper | 4 weeks | 23 weeks |
| 0.30 | Docker & deployment | 1 week | 24 weeks |
| 0.31 | RBAC & audit logging | 3 weeks | 27 weeks |
| 1.0 RC | API freeze, docs, migration | 2 weeks | 29 weeks |
| 1.0 | Launch | 1 week | 30 weeks |

---

## Constraints & Decisions

- **Solo developer until 1.0.** Every feature must be high-leverage. No coordination overhead.
- **Layered releases.** Ship every 2-3 weeks. Each release is usable and creates momentum.
- **No breaking changes until 1.0.** The 0.x API surface is already well-designed. Preserve it.
- **SQLite stays.** Zero-infrastructure is Audrey's deployment superpower. Never require Postgres, Redis, or any external service for the core.
- **Python SDK starts as HTTP client.** Native port only post-1.0 if demand warrants it.
- **Hono for HTTP framework.** Small, fast, TypeScript-native, minimal dependencies.
- **Contributors welcome after 1.0.** API stability makes contribution safe. Before 1.0, architecture is still fluid.
