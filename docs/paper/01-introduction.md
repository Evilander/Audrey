# 1. Introduction

Tool-using agents fail in ways that ordinary chat-memory evaluation does not measure. They repeat broken shell commands after a previous run already exposed the error. They ignore project-specific setup rules that were learned in an earlier session. They lose the causal link between a failed action and the fix that made a later action safe. They treat degraded retrieval as complete memory and act anyway. In Audrey's repeated-failure demo, an agent first runs `npm run deploy` and fails because the Prisma client was not generated. Audrey records the failed tool event, stores the operational rule, and blocks the same action when it is proposed again. The transcript ends with the intended behavior of pre-action memory control: "Audrey saw the agent fail once. Audrey stopped it from failing twice." (Ledger: E25, E42)

Most memory evaluation frames do not test this behavior. MTEB evaluates text embeddings across retrieval and representation tasks [@muennighoff2023mteb]. LongMemEval evaluates chat assistants on information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention over long interaction histories [@wu2025longmemeval]. LoCoMo evaluates very long-term conversational memory through question answering, summarization, and multimodal dialogue generation [@maharana2024locomo]. These benchmarks are valuable, but their output target is retrieved context or an answer. They do not ask whether memory changed a future tool action before the action reached the shell, file system, browser, API, or MCP server.

This paper defines pre-action memory control as a distinct systems problem. A controller receives a proposed tool action and remembered state before execution, then returns an auditable `allow`, `warn`, or `block` decision with evidence. Section 3 gives the formal input and output contract, desired behavior properties, threat model, and scope boundaries. The key shift is the evaluation target: memory is judged by its effect on action selection, not only by the relevance of retrieved text.

Audrey Guard is the artifact studied in this paper. It is a local-first memory controller for agents that observes tool outcomes, redacts traces, retrieves relevant memory, constructs a bounded capsule, scores preflight risk, generates reflexes, returns `allow`/`warn`/`block`, and validates whether memory helped after the action path completes (Ledger: E1-E17). The implementation is exposed through MCP, CLI, REST, and Python client surfaces, while the core guard path runs host-side before tool execution (Ledger: E18-E19, E26, E32-E36).

This paper makes six contributions:

1. It formalizes pre-action memory control as a problem separate from chat recall, retrieval accuracy, and long-context question answering (Section 3).

2. It presents Audrey Guard, a local-first controller that converts remembered failures, procedures, contradictions, recall health, and redacted tool traces into `allow`, `warn`, or `block` decisions before tool use (Sections 4 and 6; Ledger: E1-E15, E29-E40).

3. It introduces deterministic action identity for repeated-failure prevention: tool, redacted command, normalized working directory, and sorted file scope are hashed and matched against prior failed tool events (Sections 4, 6, and 7; Ledger: E3, E25, E42).

4. It implements a redaction-first tool-trace path so guard evidence can reference prior tool input, output, and error summaries without storing raw secrets in durable memory (Sections 4 and 6; Ledger: E12-E13).

5. It treats recall degradation as a control signal: missing vector tables, KNN failures, and FTS failures propagate as `RecallError[]`, appear in capsules, and become high-severity preflight warnings under strict guard mode (Sections 4 and 6; Ledger: E7, E9-E10, E15, E40).

6. It specifies GuardBench, a reproducibility contract for measuring whether memory changes future tool actions, including scenarios, baselines, metrics, redaction sweeps, machine provenance, and raw per-scenario outputs (Section 5).

The empirical scope is Stage A. This paper reports implemented Audrey evidence: the controller and CLI guard path, redaction-first tool tracing, recall-degradation handling, the canonical 0.22.2 performance snapshot, the current `bench:memory:check` regression output, the local comparative GuardBench run, and the deterministic repeated-failure demo transcript (Ledger: E20-E26, E41-E42, E46). It does not report external-system GuardBench comparisons, production-load measurements, or real-provider embedding latency. The external adapter contract, Mem0 adapter, and evidence-bundle runner now exist, but live external-system scores belong in a v2 paper after credentialed runs publish raw outputs under the contract in Section 5 (Ledger: E47-E50).

Section 2 positions Audrey against memory systems, memory benchmarks, graph-memory systems, and MCP safety work. Section 3 defines the pre-action memory-control problem. Section 4 describes Audrey Guard's design. Section 5 specifies GuardBench. Section 6 documents the implementation. Section 7 reports Stage-A evaluation artifacts. Section 8 discusses limitations and open problems. Section 9 concludes.
