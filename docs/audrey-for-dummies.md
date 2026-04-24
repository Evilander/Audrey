# Audrey For Dummies

Date: 2026-04-24

This guide explains Audrey in plain language. It assumes you know what an AI assistant is, but not how memory systems work.

## The One-Sentence Version

Audrey is a local brain for AI agents.

It gives tools like Codex, Claude Code, Claude Desktop, Cursor, Ollama agents, and custom apps a shared memory that can remember facts, decisions, procedures, failures, preferences, and project context across sessions.

## The Problem Audrey Solves

Most AI agents are powerful but forgetful.

You can spend an hour teaching an agent how your project works, what failed before, what commands are safe, what your customer cares about, and how you like work done. Then the next session starts and the agent often needs that same context again.

Large context windows help, but they are not the same as memory. A context window is what the model can see right now. Memory is what the system decides is worth keeping, organizing, updating, recalling, and eventually forgetting.

Audrey gives agents a durable memory layer so they do not have to start from zero every time.

## What Audrey Is

Audrey is:

- A local-first memory runtime.
- A SQLite-backed memory database.
- A vector-search recall engine.
- A Model Context Protocol server for AI tools.
- A REST API sidecar for local agents and services.
- A JavaScript library.
- A Python client.
- A benchmarked memory system with health checks.

Audrey is not:

- A replacement for an LLM.
- A hosted chatbot.
- A vector database only.
- A regulated compliance platform by itself.
- A magic guarantee that an agent will always remember correctly.

## Why "Local-First" Matters

Local-first means Audrey can store memory on your machine or inside your deployment boundary instead of forcing you to send memory to a hosted vendor.

By default, Audrey stores data under:

```text
C:\Users\<you>\.audrey\data
```

You can change that with:

```bash
AUDREY_DATA_DIR=B:\path\to\audrey-data
```

Use one shared data directory when you want multiple hosts to share memory. Use separate directories when you need strict separation by customer, project, environment, or agent.

## The Basic Loop

Audrey does seven core things.

1. Encode memory.
2. Recall memory.
3. Build Memory Capsules.
4. Dream over memory.
5. Track tool traces and failures.
6. Run Memory Preflight before actions.
7. Turn important warnings into Memory Reflexes.

### 1. Encode Memory

Encoding means storing something worth remembering.

Examples:

- "This repo uses TypeScript ES modules only."
- "On this machine, Vitest can fail with `spawn EPERM`; use build, typecheck, benchmarks, and direct dist smokes as fallback evidence."
- "The customer wants website changes explained in business language, not technical language."
- "Before starting a task, ask Audrey for a Memory Capsule."

Good memories are durable. They are likely to help again later.

Bad memories are raw noise. Do not store every sentence of every chat unless you have a clear reason.

### 2. Recall Memory

Recall means asking Audrey for memories related to the current task.

Example:

```bash
npx audrey
```

In MCP hosts, the agent calls tools such as `memory_recall`. In REST mode, local agents call `/v1/recall`.

### 3. Build Memory Capsules

A Memory Capsule is a compact task briefing.

Instead of dumping every matching memory into the model, Audrey groups useful memories into a structured packet with reasons. This is the right shape for agent context.

Use cases:

- "What should Codex know before editing this repo?"
- "What should an Ollama agent remember before answering this customer?"
- "What project rules matter before release?"
- "What risks have happened before?"

REST route:

```text
POST /v1/capsule
```

### 4. Dream Over Memory

Dreaming is Audrey's maintenance and consolidation step.

It can:

- Find patterns.
- Promote repeated lessons into stronger memories.
- Detect contradictions.
- Decay stale memories.
- Consolidate episodes into semantic or procedural knowledge.

Run it manually:

```bash
npx audrey dream
```

In production, schedule it during low-traffic windows.

### 5. Track Tool Traces

Agents do not just chat. They use tools, run commands, edit files, call APIs, and sometimes fail.

Audrey can remember those tool outcomes.

Example:

```bash
npx audrey observe-tool --event PostToolUse --tool Bash --outcome failed
```

Why this matters:

If an agent keeps running into the same environment failure, Audrey can turn that failure into a future warning or procedure.

### 6. Run Memory Preflight

Preflight means asking Audrey what the agent should know before it acts.

Example:

```text
Before running npm test, check whether this failed before, whether there are release rules, and whether there is a safer known procedure.
```

Audrey returns:

- `decision`: `go`, `caution`, or `block`.
- `risk_score`: how serious the remembered risks are.
- `warnings`: prior failures, must-follow rules, risks, contradictions, or uncertain memories.
- `recommended_actions`: what the agent should do next.
- `evidence_ids`: memories that support the warning.

### 7. Use Memory Reflexes

Memory Reflexes are preflight results shaped as trigger-response rules.

Example:

```text
Trigger: Before using npm test
Response: Review the prior EPERM failure path before re-running the command.
```

This is the product pivot: Audrey is not only a memory store. It is a reflex layer that helps agents stop repeating expensive mistakes.

REST route:

```text
POST /v1/reflexes
```

## The Fastest Demo

Run:

```bash
npx audrey demo
```

This does not need API keys, Claude, Codex, Ollama, or any hosted model.

The demo:

- Creates a temporary memory store.
- Writes example memories.
- Records a redacted tool failure.
- Builds a Memory Capsule.
- Proves recall.
- Deletes the temporary store unless you pass `--keep`.

## Three Ways To Use Audrey

### 1. MCP Mode

Use this when connecting Audrey to tools that support Model Context Protocol.

Examples:

- Codex
- Claude Code
- Claude Desktop
- Cursor
- Windsurf
- VS Code Copilot
- JetBrains AI Assistant

Generate host config:

```bash
npx audrey mcp-config codex
npx audrey mcp-config generic
npx audrey mcp-config vscode
```

Claude Code has a direct installer:

```bash
npx audrey install
claude mcp list
```

### 2. REST Sidecar Mode

Use this when building your own local agent, web app, CRM assistant, or Ollama-backed tool loop.

Start Audrey:

```bash
npx audrey serve
```

Health check:

```bash
curl http://localhost:7437/health
```

Useful routes:

```text
GET  /health
GET  /v1/status
POST /v1/encode
POST /v1/recall
POST /v1/capsule
POST /v1/preflight
POST /v1/reflexes
POST /v1/export
POST /v1/import
```

### 3. SDK Mode

Use this when embedding Audrey directly in a Node.js app.

```js
import { Audrey } from 'audrey';

const brain = new Audrey({
  dataDir: './.audrey-data',
  agent: 'my-agent',
});

await brain.encode({
  content: 'This project prefers ES modules.',
  source: 'direct-observation',
  tags: ['project-rule'],
});

const memories = await brain.recall('project module format', { limit: 3 });
console.log(memories);

brain.close();
```

## Ollama And Local Agents

Ollama runs local models. Audrey gives those local models memory.

Start Audrey:

```bash
AUDREY_AGENT=ollama-local-agent npx audrey serve
```

Run the example agent:

```bash
OLLAMA_MODEL=qwen3 node examples/ollama-memory-agent.js "What should you remember about this project?"
```

The example uses Ollama tool calling and Audrey REST routes. It exposes Audrey tools for:

- `memory_preflight`
- `memory_reflexes`
- `memory_capsule`
- `memory_recall`
- `memory_encode`

## Memory Types

Audrey stores several kinds of memory.

### Episodic Memory

Something that happened.

Example:

```text
The release smoke on 2026-04-24 passed build, typecheck, pack dry-run, and the demo command.
```

### Semantic Memory

A general fact or principle.

Example:

```text
Audrey is host-neutral and should not be framed as Claude-only.
```

### Procedural Memory

How to do something.

Example:

```text
Before calling a release ready, run build, typecheck, benchmark, pack dry-run, and direct CLI smoke.
```

### Tool Trace Memory

What happened when a tool ran.

Example:

```text
npm test failed with spawn EPERM on a locked-down Windows host.
```

## Memory Metadata

A memory is more useful when it has metadata.

Important fields:

- `source`: where the memory came from.
- `tags`: searchable labels.
- `salience`: importance.
- `context`: project, task, customer, host, or environment.
- `affect`: emotional or urgency signal.
- `private`: whether it should be excluded from public recall results.

Example encode body:

```json
{
  "content": "Use npm run typecheck before claiming TypeScript changes are safe.",
  "source": "direct-observation",
  "tags": ["procedure", "release-gate"],
  "salience": 0.8,
  "context": {
    "repo": "audrey",
    "host": "codex"
  }
}
```

## Beginner Rules For Good Memory

Use these rules when deciding what Audrey should remember.

- Store lessons that will matter again.
- Store procedures, not just facts.
- Store failures that should not be repeated.
- Store user preferences when they affect future work.
- Store project conventions.
- Store business context that saves explanation later.
- Do not store raw secrets, API keys, passwords, or private customer data unless your deployment is designed for it.
- Do not blindly store everything.
- Prefer short, clear memories over giant pasted transcripts.
- Add tags.
- Run `npx audrey status` when recall seems wrong.

## Command Cheat Sheet

```bash
# Run the local proof demo
npx audrey demo

# Print Codex MCP config
npx audrey mcp-config codex

# Print generic MCP JSON
npx audrey mcp-config generic

# Install into Claude Code
npx audrey install

# Remove from Claude Code
npx audrey uninstall

# Start REST sidecar
npx audrey serve

# Check memory health
npx audrey status
npx audrey status --json --fail-on-unhealthy

# Consolidate memory
npx audrey dream

# Repair vector/index drift
npx audrey reembed

# Record a tool result
npx audrey observe-tool --event PostToolUse --tool Bash --outcome failed
```

## HTTP Examples

Start the server:

```bash
npx audrey serve
```

Encode a memory:

```bash
curl -X POST http://localhost:7437/v1/encode ^
  -H "Content-Type: application/json" ^
  -d "{\"content\":\"Audrey should work across Codex, Claude, and Ollama.\",\"source\":\"direct-observation\",\"tags\":[\"host-neutral\"]}"
```

Recall memory:

```bash
curl -X POST http://localhost:7437/v1/recall ^
  -H "Content-Type: application/json" ^
  -d "{\"query\":\"host neutral Audrey\",\"limit\":5}"
```

Build a Memory Capsule:

```bash
curl -X POST http://localhost:7437/v1/capsule ^
  -H "Content-Type: application/json" ^
  -d "{\"query\":\"How should an agent use Audrey before starting work?\",\"budget_chars\":3000}"
```

PowerShell equivalent:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:7437/v1/capsule `
  -ContentType 'application/json' `
  -Body '{"query":"How should an agent use Audrey before starting work?","budget_chars":3000}'
```

Run Memory Preflight:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:7437/v1/preflight `
  -ContentType 'application/json' `
  -Body '{"action":"run npm test before release","tool":"npm test","include_capsule":false}'
```

## Production Basics

For real deployments:

- Pin `AUDREY_EMBEDDING_PROVIDER`.
- Pin `AUDREY_LLM_PROVIDER` if using LLM-backed consolidation.
- Set a dedicated `AUDREY_DATA_DIR`.
- Use one data directory per tenant boundary.
- Set `AUDREY_API_KEY` before exposing REST beyond localhost.
- Run `npx audrey status --json --fail-on-unhealthy` in health checks.
- Schedule `npx audrey dream`.
- Backup the data directory before migrations or provider changes.
- Keep secrets out of memory.
- Put encryption, access control, and audit logging around Audrey at the host layer.

## Small Business Use Cases

Audrey is especially practical for small businesses because their operational knowledge is usually scattered across the owner, a few employees, emails, spreadsheets, website notes, CRM records, and repeated manual fixes.

### Website Optimization

Audrey can remember:

- What the business sells.
- Which pages convert.
- Which SEO changes were already tried.
- Which technical issues recur.
- The owner's tone and brand preferences.

### CRM Assistant

Audrey can remember:

- Customer preferences.
- Follow-up rules.
- Common objections.
- Deal stage quirks.
- Which fields matter in the CRM.

### Support Agent

Audrey can remember:

- Recurring customer issues.
- Approved response patterns.
- Escalation rules.
- Past fixes.
- Product or service constraints.

### Internal Operations

Audrey can remember:

- How invoices are handled.
- Which vendor has special terms.
- How reports are generated.
- What failed during the last migration.
- Which automations are safe to run.

## Troubleshooting

### `npx audrey demo` Fails

Run:

```bash
npx audrey status
node --version
```

Audrey requires Node.js 20 or newer.

### Codex Or Claude Cannot Find Audrey

Generate a pinned config:

```bash
npx audrey mcp-config codex
npx audrey mcp-config generic
```

If a Windows MCP host cannot find `npx`, use `cmd /c npx -y audrey` in the host config.

### Recall Returns Nothing

Check health:

```bash
npx audrey status --json --fail-on-unhealthy
```

If the embedding dimensions changed, run:

```bash
npx audrey reembed
```

### Local Embeddings Are Slow

The local embedding provider may download or initialize model assets. For quick CI or demos, use mock providers. For production, pin the provider explicitly.

### REST Returns Unauthorized

If `AUDREY_API_KEY` is set, requests need:

```text
Authorization: Bearer <your-key>
```

### Tests Fail With `spawn EPERM`

On some locked-down Windows hosts, Vitest/Vite worker startup can fail with `spawn EPERM`. Treat that as a local execution blocker. Use build, typecheck, benchmark checks, package dry-run, and direct Node smokes as fallback evidence.

## Glossary

### Agent

An AI system that can take actions, use tools, or work across steps.

### MCP

Model Context Protocol. A standard way for AI tools to call external tools and access resources.

### REST Sidecar

A local HTTP service that another app or agent can call.

### Embedding

A numeric representation of text used for similarity search.

### Vector Search

Searching by meaning instead of exact words.

### Memory Capsule

A compact briefing of memories relevant to a task.

### Dream

Audrey's consolidation and maintenance cycle.

### Tool Trace

A record of what happened when an agent used a tool.

### Re-Embedding

Rebuilding vector indexes when the embedding provider or dimensions change.

## The Mental Model

Think of Audrey like a project notebook that AI agents can read and update, except it is structured, searchable, local, and designed for automation.

The best use is not "remember everything."

The best use is:

> Remember the lessons, preferences, procedures, and failures that make the next session better than the last one.

## Where To Go Next

- Run `npx audrey demo`.
- Read `docs/mcp-hosts.md` to connect Codex, Claude, Cursor, Windsurf, VS Code, or JetBrains.
- Read `docs/ollama-local-agents.md` for local Ollama-backed agents.
- Read `docs/production-readiness.md` before using Audrey in a real deployment.
- Read `docs/future-of-llm-memory.md` for the forward-looking product roadmap.
