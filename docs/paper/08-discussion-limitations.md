# 8. Discussion and Limitations

## What the Implementation Changes

Repeated-failure prevention is the clearest implemented behavior. The demo records one failed `npm run deploy`, stores the operational lesson that Prisma generation must run first, and blocks the identical future action before tool use. The guard output includes a `BLOCKED` decision, risk score `0.90`, two blocking reflexes, one warning reflex, evidence IDs, concrete recommendations, and impact accounting (Ledger: E25, E42). The change is not better recall in a chat answer. The change is that the second tool call does not happen.

The redacted evidence trail changes what can be safely remembered. Audrey's tool-tracing path states that raw tool input, output, and error text do not leave the module without redaction, and it stores redacted summaries, hashes, file fingerprints, redaction state, and a memory event (Ledger: E12). The redaction catalog covers named API keys, auth headers, private keys, URL credentials, password assignments, payment and PII patterns, signed URLs, session cookies, high-entropy tokens, JSON sensitive keys, and truncation marker preservation (Ledger: E13). This lets guard decisions point back to prior tool evidence without turning the memory store into an unfiltered secret archive.

Action-key determinism gives the controller a hard repeated-failure path. Audrey hashes tool name, redacted command or action text, normalized working directory, and sorted normalized file scope, then matches the hash against prior failed tool events for the same agent (Ledger: E3). This is separate from semantic retrieval. A prior failure does not need to be semantically similar enough to rank first; the exact repeated action is a structured event match.

Recall-degradation handling changes failure posture. Audrey records missing vector tables, per-type KNN failures, and FTS lookup failures as `RecallError[]`, preserves partial results, exposes degradation in memory status, and carries errors into capsules (Ledger: E15, E40). Preflight converts recall errors into high-severity memory-health warnings, and strict guard mode blocks high-severity warnings (Ledger: E9-E10). A degraded memory substrate therefore becomes a visible control condition instead of an invisible recall-quality drop.

## Conservative Control Choices

Audrey is conservative by design. Strict mode blocks high-severity warnings rather than asking the model to decide whether a remembered warning matters (Ledger: E10). This increases false-positive risk when a high-severity warning is stale or overbroad. The trade-off is appropriate for pre-action control because the guarded operations include file mutation, shell execution, credential exposure, network calls, and destructive tools. The safer default is to force inspection when memory reports high risk.

Agent-scoped recall is another conservative choice. Capsule construction forces `scope: 'agent'`, so a caller cannot accidentally widen a capsule to shared memory by passing broad recall options (Ledger: E7). This reduces cross-agent leakage at the cost of hiding useful memory learned by another agent. Cross-agent sharing belongs behind an explicit federation policy, not an accidental default.

The trusted-control-source gate is also conservative. A memory tagged as must-follow becomes a control rule only when its source is `direct-observation` or `told-by-user`; untrusted must-follow tags are routed to uncertain or disputed context (Ledger: E6). This blocks an obvious memory-injection path. It also creates false positives when a useful operating rule comes from a source that has not been promoted into trust.

## What This Paper Does Not Claim

This paper reports one local comparative GuardBench run. It does not report GuardBench results across external memory systems. Section 5 specifies GuardBench; v2 reports the full external-system run.

It does not report cross-system comparisons against Mem0, Letta/MemGPT, Zep, Graphiti, MemOS, LangMem, Supermemory, Cognee, or hosted memory services.

It does not report production-load measurements, concurrent-agent soak tests, storage-pressure behavior, or long-running operational telemetry.

It does not report real-provider embedding latency. The canonical performance snapshot uses a mock in-process 64-dimensional embedding provider (Ledger: E20-E22).

It does not prove redaction completeness. The implementation has a broad rule catalog, but unknown credential formats and adversarial encodings remain out of scope (Ledger: E13).

It does not prevent first-time errors. Pre-action memory control works from prior evidence, remembered rules, contradictions, and recall health. A novel error with no remembered signal still reaches the underlying tool policy.

It does not replace sandboxing, OS permissions, MCP permission systems, human approval, or network isolation. Audrey is a memory-derived control layer that fits inside a host's broader tool-use safety stack.

## Threats to Current Claims

Action-key fidelity is a central threat. Repeated-failure prevention depends on stable normalization of command text, working directory, and file scope. If a host supplies incomplete file lists, unstable cwd values, or action text that hides the meaningful operation inside nested arguments, exact-repeat detection loses coverage (Ledger: E3). The current hash is deterministic, not omniscient.

Redaction is rule-based. It covers many common credential and PII formats, sensitive JSON keys, high-entropy strings, and truncation boundaries (Ledger: E13). It remains incomplete for novel secret formats, multi-part secrets split across fields, encoded payloads, and tool outputs crafted to evade regex and entropy checks.

Capsule pruning is priority-based, not learned. Capsules enforce a character budget and preserve structured sections and evidence IDs (Ledger: E5). The current implementation uses explicit sectioning and truncation logic rather than a learned policy that optimizes downstream guard accuracy. Budget pressure can hide useful non-control context while keeping control evidence.

Reflex generation is deterministic, not adaptive. Reflexes are mapped from preflight warnings into `guide`, `warn`, or `block` responses with evidence and recommendations (Ledger: E11). The mapping does not learn from later validation events. Validation updates memory salience and bookkeeping, but risk scoring remains fixed by severity rules (Ledger: E16, E45).

## Open Problems

Host hook parity. Audrey exposes CLI pieces that host hooks can call, and Claude Code documents hook extension points [@anthropic2026claudecodehooks]. Audrey now generates and applies Claude Code hook settings, `guard --hook` emits the current PreToolUse `hookSpecificOutput.permissionDecision` shape, and `observe-tool` records post-tool events (Ledger: E43). The remaining production installer work is equivalent wiring for hosts with stable hook surfaces, especially Codex.

Validation lineage is implemented but not yet policy-adaptive. Audrey can bind validation events to the exact preflight event, evidence IDs, and action key that produced a decision, and rejects mismatched evidence claims (Ledger: E44). The next step is using that closed-loop signal to tune warning priority and recommendation wording without giving the model direct control over policy.

Cross-agent memory federation. Audrey currently protects capsules through agent-scoped recall (Ledger: E7). Multi-agent runtimes need explicit federation rules: which memories transfer across agents, which remain private, which require user confirmation, and how contradictions propagate across agent identities.

Adaptive risk scoring. Preflight uses a fixed severity map and strict mode blocks high-severity warnings (Ledger: E45). Validation feedback should eventually tune risk scoring, warning ordering, and recommendation wording without giving the model direct control over the safety policy.

Adversarial-memory robustness. The trusted-control-source gate blocks untrusted must-follow tags, but poisoned tool outputs that enter through trusted observation paths remain a hard problem (Ledger: E6, E12). Future work needs adversarial memory tests where attacker-controlled output resembles an operational rule, a project instruction, or a false recovery signal.

## Local-First as a Feature

Pre-action memory control operates on sensitive operational history: shell commands, file paths, build failures, project rules, API error summaries, user instructions, and redacted tool outputs. Sending that control surface to a hosted memory service creates an avoidable privacy, availability, and latency dependency. Audrey's local-first SQLite, sqlite-vec, FTS5, loopback REST default, and no-auth network refusal keep the controller deployable inside local agents and air-gapped environments (Ledger: E29-E30, E35, E37). The local design is not just an implementation convenience; it is aligned with the data that a pre-action controller must inspect.
