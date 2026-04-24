# Audrey Industry Standard Assessment

Assessment date: 2026-04-23
Last updated: 2026-04-24
Branch: `master`
Checkout: `B:\projects\claude\audrey`

## Product Thesis

Audrey should not be framed as a Claude Code add-on. Claude Code is one distribution channel.

The stronger category is:

**Audrey is the local-first continuity runtime for AI agents.**

That means Audrey should sit underneath Codex, Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, JetBrains, Ollama-backed local agents, and custom internal agents. The host should be replaceable. Audrey's job is persistent memory, recall, contradiction handling, consolidation, tool-trace learning, and behavior carryover.

The market is moving this way:

- Claude now has project-scoped memory with view/edit controls and incognito behavior.
- ChatGPT has saved memories and chat-history memory with user controls.
- Ollama supports local tool calling and OpenAI-compatible local APIs, which means local agents can call Audrey as a tool layer.
- Mem0, Zep/Graphiti, LongMemEval, LoCoMo, and MIRIX all point toward selective, temporal, structured, benchmarked memory rather than "dump all chat history into context."

Audrey's wedge should be local-first, host-neutral, inspectable memory that turns agent work into reusable behavior before the agent acts.

The sharper product pivot is:

**Audrey gives AI agents Memory Reflexes.**

That means Audrey turns prior failures, rules, host quirks, and procedures into trigger-response guidance such as "Before using npm test, check the last EPERM failure path." This is more commercially legible than generic "LLM memory" because the outcome is that agents stop repeating expensive mistakes.

## What Changed In This Pass

- Reframed the README from "Claude Code and AI agents" to "local-first memory runtime for AI agents."
- Added first-class Codex config generation: `npx audrey mcp-config codex`.
- Added generic MCP config generation: `npx audrey mcp-config generic` and host-specific output for VS Code.
- Changed the default MCP agent identity from `claude-code` to `local-agent`; the Claude installer still pins `AUDREY_AGENT=claude-code`.
- Prevented printable MCP configs from emitting provider API keys.
- Added `docs/ollama-local-agents.md` for Ollama/local-agent REST tool-bridge use.
- Added `POST /v1/capsule` so REST sidecar agents can use the same Memory Capsule concept exposed by MCP.
- Added `POST /v1/preflight` so REST sidecar agents can check memory before taking risky actions.
- Added `POST /v1/reflexes` so hosts can receive trigger-response Memory Reflexes derived from preflight evidence.
- Added SDK methods `audrey.preflight(action, options)` and `audrey.reflexes(action, options)`.
- Added MCP tools `memory_preflight` and `memory_reflexes`, bringing the host-facing MCP surface to 19 memory tools.
- Added `npx audrey demo`, a 60-second local proof path that writes temporary memories, records a redacted tool failure, asks for a Memory Capsule, proves recall, and cleans up without requiring API keys or host setup.
- Upgraded `npx audrey demo` so it also prints a Memory Reflex proof from a remembered failed tool trace.
- Added `examples/ollama-memory-agent.js`, a complete Ollama `/api/chat` tool-loop example that uses Audrey's `/v1/reflexes`, `/v1/preflight`, `/v1/capsule`, `/v1/recall`, and `/v1/encode` routes.
- Updated package files so the npm tarball includes the MCP host guide and Ollama guide.
- Removed the accidental self-dependency on `audrey` from package metadata.
- Ignored local `.tmp-npm-cache/` and `.claude/settings.local.json` noise.

## Current Proof Signals

These commands passed on this machine:

- `npm run build`
- `npm run typecheck`
- `npm run bench:memory:check`
- `npm pack --dry-run --cache .\.tmp-npm-cache`
- Direct `mcp-config` smoke for Codex and generic MCP output
- Direct `npx audrey demo` equivalent smoke through `node dist\mcp-server\index.js demo`
- Direct `examples/ollama-memory-agent.js --help` syntax/UX smoke
- Direct HTTP capsule smoke against built `dist/`
- Direct SDK reflex smoke: one remembered `npm test` failure produced `decision=caution`, one reflex, trigger `Before using npm test`, and `response_type=warn`.
- Direct HTTP reflex smoke against `POST /v1/reflexes` with bearer auth returned `status=200`, `decision=caution`, one reflex, and embedded preflight when requested.
- Direct MCP schema smoke confirmed `memory_reflexes` rejects empty actions and accepts `include_preflight`.
- `node dist\mcp-server\index.js status --json --fail-on-unhealthy`
- `python -m unittest discover -s python/tests -v`
- `npm view audrey version --cache .\.tmp-npm-cache` returned `0.20.0`

Local memory health is green:

- `healthy=true`
- `episodes=58`
- `vec_episodes=58`
- `schema_version=12`
- `reembed_recommended=false`

Known local test limitation:

- `npx vitest run tests/mcp-server.test.js` still fails at startup with `spawn EPERM` from Vite/esbuild in this environment. Treat that as a host execution blocker, not proof of a code regression. CI still needs to be checked separately.

## Strengths Worth Defending

- SQLite plus `sqlite-vec` keeps Audrey local-first and easy to ship.
- Memory is richer than RAG: episodic, semantic, procedural, affect, confidence decay, contradictions, causal links, consolidation, forgetting, and tool traces.
- MCP and REST now both expose the critical path for agent hosts.
- The Memory Capsule is the right retrieval product shape: structured, ranked, evidence-backed, and budgeted.
- Memory Reflexes are the clearest product wedge: they repackage evidence as trigger-response behavior agents can automate.
- Tool-trace memory is a differentiated idea: Audrey remembers the work, not just the chat.
- Benchmark instincts are already present, and the local regression gate is green.

## Release Blockers

1. Python SDK and TS HTTP server contract drift.
   Python integration tests are skipped because `/v1/analytics`, `/v1/mark-used`, and snapshot/restore body contracts do not fully match the server. Fix this before calling Python first-class.

2. OpenAPI/docs surface is not current in the active `src/routes.ts`.
   Older plans mention `/openapi.json` and `/docs`, but the current active server file is plain Hono routes. Either restore OpenAPI for `/v1/capsule`, `/v1/preflight`, and `/v1/reflexes`, or remove the claim everywhere.

3. Remote MCP is still missing.
   ChatGPT-style remote MCP needs a streaming HTTP/SSE deployment story. Local stdio MCP covers Codex/Claude/Desktop IDEs, not ChatGPT remote connectors.

4. External benchmark credibility is still incomplete.
   The internal benchmark is useful as a regression gate, but Audrey needs reproducible LoCoMo and LongMemEval adapters to compete credibly.

5. Host installers are uneven.
   Claude Code has `npx audrey install`; Codex has generated TOML; Claude Desktop has docs; Ollama has REST bridge docs. The next product slice should make this feel like one coherent install story.

6. Some tests are intentionally skipped.
   `multi-agent`, `implicit relevance feedback`, one recall failure test, and one wait-for-idle test are skipped. These are not all release blockers, but they mark unfinished product claims.

## Highest-Leverage Next Slices

1. Build the unified host installer.
   Add `npx audrey install --host codex|claude-code|claude-desktop|generic` with dry-run support and safe config backup. Keep `mcp-config` as the non-mutating path.

2. Wire Memory Reflexes into real host hooks.
   Codex, Claude Code, and local agents should be able to call `memory_reflexes` automatically before shell commands, file edits, deploys, package publishing, and CRM/customer actions.

3. Repair Python SDK parity.
   Either implement the missing TS HTTP routes or remove unsupported Python methods. Unskip the integration tests only when the contract is real.

4. Restore official API docs.
   Reintroduce `/openapi.json` and `/docs` for the current route set, including `/v1/capsule`, `/v1/preflight`, and `/v1/reflexes`, or stop marketing that surface.

5. Add an Ollama example agent test.
   Initial example exists at `examples/ollama-memory-agent.js`. Next step is a CI-safe mocked Ollama test plus a real local smoke when Ollama is installed.

6. Build external benchmark adapters.
   Start with a small LoCoMo harness, then LongMemEval. Keep the local benchmark labeled as regression-only.

## Strategic Positioning

Audrey should sell three outcomes:

- Agents stop forgetting operational context across tools and hosts.
- Teams can inspect, export, repair, and govern memory locally.
- Memory becomes behavior: repeated failures become reflexes, warnings, procedures, rules, and project-specific habits.

The small-business angle fits this: websites, CRMs, support bots, ops assistants, and local AI automations all need durable memory without giving every customer workflow to a hosted memory vendor.

The category is not "Claude remembers." The category is "every agent you run gets a durable local brain and checks it before acting."
