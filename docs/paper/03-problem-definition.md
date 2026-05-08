# 3. Problem Definition: Pre-Action Memory Control

Long-term memory systems for agents are usually evaluated as retrieval systems: given prior interaction history and a current query, the system returns facts, summaries, graph neighborhoods, or memory-tool results that improve the next model response. Mem0 evaluates scalable conversational memory and token efficiency [@chhikara2025mem0; @mem02026tokenefficient]. MemGPT/Letta frames memory as virtual context management across tiers [@packer2024memgpt]. Zep and Graphiti model changing facts as temporal knowledge graphs [@rasmussen2025zep; @zep2026graphiti]. MemOS treats memory as a manageable system resource [@li2025memos]. LangMem, Supermemory, and Cognee expose memory management, search, and graph/context layers for agents [@langchain2026langmem; @supermemory2026docs; @markovic2025cognee; @cognee2026repo].

Those systems make recall, memory formation, or memory organization the central artifact. This paper studies a different artifact: a controller that runs before an agent uses a tool. The relevant question is not only whether memory returns useful text. The relevant question is whether memory changes the next external action.

## Problem Statement

A tool-using agent repeatedly converts model state into external actions: shell commands, file edits, API calls, browser operations, MCP tool calls, or domain-specific side effects. These actions are not only language outputs. They change local files, spend API budget, mutate remote systems, publish content, delete data, and expose credentials. MCP standardizes tool discovery and invocation through a JSON-RPC protocol surface [@mcp2025schema]. Claude Code hooks expose pre-tool and post-tool extension points around tool calls [@anthropic2026claudecodehooks]. These interfaces make tool use observable and interceptable; they do not by themselves decide whether prior failures, remembered constraints, stale recall, or contradictions should stop the next action.

The pre-action memory control problem is:

Given an intended agent action and a local memory state, return an auditable decision before tool execution: `allow`, `warn`, or `block`, with evidence and repair guidance.

Audrey implements this decision as the `GuardResult` contract with `decision`, `riskScore`, `summary`, `evidenceIds`, `recommendedActions`, `capsule`, `reflexes`, and `preflightEventId` fields (Ledger: E1). Its current controller calls preflight/reflex generation before action, records a preflight event, and scopes recall to the current agent (Ledger: E2). It also records tool outcomes after execution and turns failures into future tool-result memories (Ledger: E4).

## Formal Interface

Let an intended action at time `t` be:

```text
a_t = (tool, action, command, cwd, files, session_id)
```

where `tool` names the external capability, `action` is the human-readable intended operation, `command` is the concrete command when present, `cwd` is the execution directory, `files` is the known file scope, and `session_id` identifies the agent session. Audrey represents this shape in `AgentAction` (Ledger: E1).

Let `M_t` be the memory store visible to the agent, `T_t` be the tool-trace event history, and `H_t` be the current recall-health state. A pre-action memory controller is a function:

```text
G(M_t, T_t, H_t, a_t) -> (d_t, r_t, E_t, R_t, C_t)
```

where:

- `d_t in {allow, warn, block}` is the action decision.
- `r_t in [0,1]` is the risk score.
- `E_t` is a set of evidence identifiers.
- `R_t` is a set of recommended repair or mitigation actions.
- `C_t` is an optional memory capsule containing the evidence packet.

The controller is useful only if `d_t` is consumed before the side effect occurs. If the decision is displayed after execution, the system is post-hoc logging, not pre-action control.

After the tool executes, let the observed outcome be:

```text
o_t = (outcome, output, error_summary, metadata)
```

where `outcome` includes success, failure, or unknown status. A closed-loop memory controller also defines an update function:

```text
U(M_t, T_t, a_t, o_t) -> (M_{t+1}, T_{t+1})
```

Audrey implements this post-action update by recording redacted tool events and encoding failures as tool-result memories for later preflight use (Ledger: E4, E12).

## Desired Behavior Properties

**Pre-action placement.** The controller runs after the agent proposes tool parameters and before the tool runs. Audrey's `beforeAction()` path calls reflex/preflight generation before execution (Ledger: E2). This placement separates memory control from answer generation.

**Evidence-linked decisions.** Every warning or block is backed by memory IDs, failure IDs, recall diagnostics, or preflight event IDs. Audrey preflight returns warnings, evidence IDs, recommended actions, recent failures, and an optional capsule (Ledger: E8-E10). Reflex generation preserves evidence IDs and reasons (Ledger: E11).

**Action identity.** A repeated-failure detector needs an action identity stricter than a natural-language similarity match and more robust than raw string equality. Audrey hashes tool name, redacted command/action text, normalized working directory, and sorted normalized files; it then compares the hash with prior failed tool events for the same agent and tool (Ledger: E3).

**Conservative control-source handling.** A memory tagged as a rule is not automatically trusted. Audrey treats `must-follow` style tags as control signals only when the source is `direct-observation` or `told-by-user`; untrusted control-looking memories are routed to uncertain/disputed context (Ledger: E6).

**Recall-degradation awareness.** If retrieval partially fails, a memory controller should not silently proceed as though recall were complete. Audrey represents recall errors, propagates partial failures, exposes recent recall degradation in status, carries recall errors into capsules, and turns capsule recall errors into high-severity preflight warnings (Ledger: E7, E9, E15).

**Redaction before persistence.** Tool traces are high-risk memory inputs because they contain commands, environment output, stack traces, credentials, and file paths. Audrey's tool-trace contract states that raw tool input, output, and error text do not leave the module without redaction; it stores hashes, redacted summaries, redacted metadata, file fingerprints, and redaction state (Ledger: E12). The redaction layer covers common credentials, bearer/basic auth, private keys, JWTs, URL credentials, password assignments, payment/PII patterns, signed URL signatures, session cookies, high-entropy secrets, and sensitive JSON keys (Ledger: E13).

**Bounded context assembly.** A pre-action controller must fit within model and tool budgets. Audrey capsules include `budget_chars`, `used_chars`, and `truncated` fields and organize evidence into typed sections rather than returning an unstructured recall list (Ledger: E5).

**Agent scoping.** A local memory runtime used by multiple agents should not leak another agent's private operational history into a current preflight. Audrey capsule recall forces `scope: 'agent'` (Ledger: E7).

**Closed-loop validation.** A memory controller needs feedback after action because the controller's evidence can be helpful, merely used, or wrong. Audrey validation accepts `used`, `helpful`, and `wrong` outcomes and updates salience and bookkeeping fields; impact reporting summarizes validation and recent activity (Ledger: E16-E17).

## Threat Model

The controller assumes an agent with legitimate access to local tools and MCP tools. The main hazards are action-selection hazards, not cryptographic compromise.

The in-scope hazards are:

- Repeating an exact action that already failed.
- Ignoring a remembered must-follow procedure or project rule.
- Acting on a memory set with open contradictions.
- Treating degraded recall as complete recall.
- Persisting credentials or sensitive tool output into long-lived memory.
- Allowing untrusted tool outputs or descriptors to influence future actions as if they were trusted rules.
- Losing auditability between a warning/block and the evidence that caused it.

The MCP ecosystem makes these hazards concrete. The MCP specification standardizes the schema for tools and messages [@mcp2025schema]. MCP security benchmarks and tool-poisoning work evaluate attacks against MCP-integrated agents, including adversarial tool descriptions, shadowing through shared context, and changed tool descriptors after approval [@zhang2026mcpsecuritybench; @jamshidi2025toolpoisoning]. The MCP tool-annotations discussion frames annotations as risk hints that matter only when a client performs a concrete action based on them [@mcp2026toolannotations]. Audrey's controller fits this pattern: memory risk is useful when it changes the host-side decision.

The out-of-scope hazards are:

- First-time mistakes with no relevant prior evidence.
- Malicious host compromise, database tampering, or filesystem attacks outside Audrey's process boundary.
- Formal verification that a tool action is semantically safe.
- Permission enforcement, sandboxing, rate limiting, or policy execution outside the memory controller.
- Model alignment, deception detection, and general prompt-injection defense independent of remembered evidence.
- Complete prevention of secret exposure after a caller explicitly stores unredacted data outside Audrey's tool-trace path.

These boundaries matter for evaluation. Audrey Guard is not a replacement for sandboxing, MCP permission systems, static analysis, or human approval. It is a memory-derived pre-action control layer: it catches hazards that are visible in prior outcomes, stored rules, contradictions, tool traces, and recall health.

## Stage-A Evaluation Target

The first paper version evaluates implemented mechanisms and specifies GuardBench rather than claiming full benchmark results across external systems. The implemented evidence available today is: the controller and CLI guard path (Ledger: E1-E4, E26), the redacted tool-trace path (Ledger: E12-E13), preflight/reflex behavior (Ledger: E8-E11), recall degradation handling (Ledger: E15), closed-loop validation and impact reporting (Ledger: E16-E17), the canonical performance snapshot (Ledger: E20-E22), the current behavioral regression gate output (Ledger: E23-E24), and the deterministic repeated-failure demo (Ledger: E25).

GuardBench therefore belongs in this version as a specification for future comparative evaluation, not as a completed empirical result table. The empirical claims in the first version use existing Audrey artifacts only.
