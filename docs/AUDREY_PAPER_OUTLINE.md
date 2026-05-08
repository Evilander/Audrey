# Audrey Paper Outline

## Working Title

Audrey Guard: Local-First Pre-Action Memory Control for Tool-Using Agents

## One-Sentence Thesis

Long-term memory for agents should not stop at recall; it should run before tool use, connect prior outcomes to the next action, and return an auditable `allow`, `warn`, or `block` decision with evidence.

## Abstract Draft

Tool-using agents repeatedly fail in ways that are avoidable: they rerun broken commands, ignore project-specific procedures, lose the context behind prior failures, and trust degraded retrieval paths as if they were complete. Existing agent-memory systems focus mainly on storing and retrieving conversational facts. Audrey reframes memory as a local-first control loop for action: observe tool outcomes, encode durable lessons, build a memory capsule before the next action, generate reflexes, decide whether to allow, warn, or block, and validate whether the memory changed the result.

This paper introduces Audrey Guard, a SQLite-backed memory controller for Model Context Protocol and CLI agents. Audrey Guard combines hybrid vector/FTS recall, memory capsules, preflight warnings, tool-trace learning, redaction-first audit logging, and evidence-linked impact measurement. The evaluation plan measures repeated-failure prevention, false-block rate, degraded-recall fail-closed behavior, redaction safety, and overhead. The result is a practical memory firewall for local agent work: not a replacement for general memory platforms, but an auditable layer that helps agents avoid repeating known mistakes before they touch tools.

## Core Contributions

1. Define pre-action memory control as a distinct problem from generic long-term memory retrieval.
2. Present the Audrey Guard loop: `PostToolUse` observation -> memory encoding -> preflight/capsule/reflex generation -> `allow` / `warn` / `block` -> validation/impact.
3. Show a local-first implementation over SQLite, vector search, FTS, MCP, CLI, REST, and Python clients.
4. Introduce GuardBench, an evaluation suite focused on tool-use risk reduction rather than chat-memory accuracy alone.
5. Measure safety properties that memory systems usually underreport: repeated-failure prevention, recall degradation handling, secret redaction, and audit lineage.

## Paper Structure

### 1. Introduction

- Agents now operate tools, not just text conversations.
- The failure mode is operational: the agent knows less than yesterday's run.
- Generic memory recall is necessary but insufficient; the memory must participate before action.
- Audrey's claim: a local memory controller can prevent repeated tool failures with low overhead and inspectable evidence.

### 2. Background and Related Work

- Agent-memory systems: Mem0, Letta/MemGPT, LangMem, Zep/Graphiti, Supermemory, OpenMemory, Cognee, LlamaIndex memory.
- Memory-as-system-resource work: MemOS, procedural memory, evidence-driven retention, temporal graphs.
- MCP tool safety: tool annotations, tool poisoning, descriptor drift, open-world tool risk.
- Hook runtimes: Claude Code `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` make pre-action memory control deployable.

### 3. Problem Definition

- Input: proposed agent action, tool name, command/action text, cwd, file scope, session id, and current memory store.
- Output: decision, risk score, summary, evidence ids, recommended actions, reflexes, optional capsule, and preflight event id.
- Desired behavior:
  - Block exact repeated failures unless the action changed.
  - Warn on relevant prior failures, must-follow procedures, contradictions, and degraded recall.
  - Preserve evidence lineage and redact secrets before durable storage.
  - Add low enough latency to run inside tool hooks.

### 4. Audrey Guard Design

- Memory substrate: episodic, semantic, procedural, event log, validation, decay, consolidation.
- Recall: hybrid vector + FTS with tag/source/date filters and partial-failure diagnostics.
- Capsules: budgeted evidence assembly for action context.
- Preflight: warnings and risk scoring from capsule sections, status, and recent tool failures.
- Reflexes: action-oriented responses generated from preflight evidence.
- Controller: `beforeAction()` and `afterAction()` over existing Audrey primitives.
- Audit safety: redaction-before-truncation, action hashing, file-scope hashing, event ids.

### 5. Implementation

- Runtime: Node.js 20+, TypeScript, SQLite, sqlite-vec, Hono REST, MCP stdio, Python client.
- CLI:
  - `audrey guard --tool Bash "npm run deploy"`
  - `audrey demo --scenario repeated-failure`
- MCP surfaces:
  - Tools for recall, preflight, reflexes, observe-tool, impact, status.
  - Resources for status, recent memories, and principles.
  - Prompts for session briefing, recall, and reflection.
- Docker behavior: fail-closed non-loopback REST sidecar with required API key.

### 6. Evaluation: GuardBench

Baselines:

- No memory.
- Recent-window memory.
- Vector-only recall.
- Keyword/FTS-only recall.
- Audrey Guard with hybrid recall and exact-failure matching.

Scenarios:

- Repeated failed shell command.
- Required preflight procedure missing.
- Same command in a different file scope.
- Same tool/action with changed command.
- Prior failure plus successful fix.
- Recall vector table missing.
- FTS failure under hybrid recall.
- Long secret near truncation boundary.
- Conflicting project instructions.
- High-volume irrelevant memory noise.

Metrics:

- Repeated-failure prevention rate.
- False-block rate.
- Useful-warning precision.
- Evidence recall: whether the blocking evidence is surfaced.
- Redaction safety: raw secret leakage count.
- Recall-degradation detection rate.
- Runtime overhead p50/p95.
- Validation-linked impact count.

### 7. Results Plan

- Use the existing repeated-failure demo as the first qualitative figure.
- Run `npm run bench:memory:check` as the memory-regression baseline.
- Add a new `bench:guard` command before paper submission.
- Report machine provenance for all timings, matching the existing 0.22.2 benchmark snapshot style.
- Include ablations:
  - Without exact action hash.
  - Without file scope.
  - Without recall degradation warnings.
  - Without redaction-aware truncation.

### 8. Discussion

- Why Audrey should not compete as "the best general memory store."
- Why local-first matters for tool traces: secrets, filesystem paths, project rules, and private failures.
- Why tool annotations are hints, not policy guarantees.
- What Audrey borrows from graph memory without adding a graph database to the core.
- Limitations:
  - No real host hook installer yet.
  - Validation is not fully bound to exact preflight event lineage yet.
  - No public GuardBench numbers yet.
  - Temporal belief fields are still future work.

### 9. Conclusion

- Agent memory should be judged by whether it changes future actions, not just whether it retrieves relevant text.
- Audrey Guard demonstrates a practical local loop for using memory as a pre-action control layer.
- The next publishable milestone is GuardBench plus host-hook integration.

## Figures and Tables

1. Guard loop diagram: observe -> encode -> capsule/preflight/reflex -> decision -> validate.
2. Architecture diagram: SQLite store, event log, recall, controller, MCP/CLI/REST clients.
3. Repeated-failure demo transcript with evidence ids.
4. GuardBench table by baseline and scenario.
5. Redaction/truncation safety table.
6. Latency table: preflight p50/p95 by memory count.

## Artifact Checklist Before Submission

- `bench:guard` script and JSON output.
- Public GuardBench scenario manifest.
- Reproducible benchmark snapshot with Node version, CPU, RAM, git SHA.
- CLI smoke transcript for `audrey demo --scenario repeated-failure`.
- MCP smoke transcript for `tools/list`, `resources/list`, `prompts/list`, and `memory_status`.
- Python integration proof.
- Docker fail-closed auth proof.
- Paper appendix with exact commands.

## Submission Strategy

1. Publish an arXiv preprint after GuardBench exists.
2. Submit to an agent-systems, AI engineering, or LLM applications workshop.
3. Keep the first version implementation-centered, not theory-heavy.
4. Release the evaluation artifact with the paper so the claim is falsifiable.

## Source Map

- MCP tool annotations and trust model: https://modelcontextprotocol.io/specification/2025-06-18/server/tools and https://modelcontextprotocol.io/specification/2025-06-18/schema
- MCP annotation risk vocabulary: https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Mem0 token-efficient memory algorithm: https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm
- MemOS: https://huggingface.co/papers/2507.03724
- MCP Security Bench: https://huggingface.co/papers/2510.15994
- Securing MCP against tool poisoning: https://papers.cool/arxiv/2512.06556
- Zep/Graphiti temporal knowledge graph: https://help.getzep.com/graphiti/graphiti/overview
