# 2. Related Work

This section organizes prior work by the behavior each system optimizes. The point of comparison is not whether a system has memory. It is whether memory runs before tool use and produces an evidence-linked action decision.

## Conversational and Scalable Memory Systems

Mem0 optimizes scalable long-term memory for multi-session agents. Its paper frames the problem as extracting, consolidating, and retrieving salient information from ongoing conversations, including a graph-memory variant for relational structure, and evaluates on LoCoMo-style conversational memory tasks [@chhikara2025mem0]. Its 2026 algorithm post emphasizes token-efficient retrieval through hierarchical memory, ADD-only extraction, entity linking, and multi-signal retrieval [@mem02026tokenefficient]. Audrey differs at the control boundary: Mem0 optimizes what context to retrieve for response generation, while Audrey evaluates whether remembered context changes a proposed tool action before execution.

MemGPT, now associated with Letta, optimizes virtual context management. The MemGPT paper treats limited context windows as an operating-system-style memory hierarchy problem, moving information between memory tiers so an LLM can operate beyond its immediate context window [@packer2024memgpt]. This is an architectural framing for extended context and multi-session chat. Audrey borrows the systems instinct but changes the target: its controller is not a virtual-context manager for the model; it is a host-side guard that returns `allow`, `warn`, or `block` for a proposed action.

LangMem optimizes memory as a reusable agent-runtime primitive. Its documentation describes tooling for extracting important information from conversations, optimizing agent behavior through prompt refinement, maintaining long-term memory, and providing hot-path memory tools agents can call during active conversations [@langchain2026langmem]. This is close to an agent developer's integration layer. Audrey differs because the guard path does not depend on the language model deciding to call a memory tool; the host asks memory before the tool call proceeds.

Supermemory optimizes a developer memory API and context stack. Its documentation positions the service as long-term and short-term memory and context infrastructure, with ingestion, extraction, graph memory, user profiles, connectors, and managed RAG [@supermemory2026docs]. Its repository describes persistent memory for AI tools and an API that returns user profiles and relevant memories [@supermemory2026repo]. Audrey differs by keeping the pre-action controller local and by treating prior tool outcomes, redaction state, and recall degradation as enforceable control inputs rather than retrieved context alone.

## Memory as System Resource and Graph Systems

MemOS optimizes memory as a system resource. The paper introduces a memory operating system that manages heterogeneous memory forms across temporal scales, with memory units carrying content and metadata such as provenance and versioning [@li2025memos]. This is the broadest systems framing among the related memory papers. Audrey's scope is narrower and more operational: it does not manage parameter-level memories or schedule heterogeneous memory resources; it inserts a local memory-derived decision layer before agent tool use.

Zep optimizes temporal knowledge graphs for agent memory. Its paper presents Graphiti as a temporally aware knowledge-graph engine that synthesizes unstructured conversations and structured business data while maintaining historical relationships, then evaluates retrieval over Deep Memory Retrieval and LongMemEval-style tasks [@rasmussen2025zep]. Audrey uses contradictions, recent tool events, and typed memory, but it does not claim to be a temporal knowledge graph service. Its central output is a guard decision, not a retrieved graph context.

Graphiti optimizes real-time temporal context graphs. Its repository describes context graphs that track how facts change over time, maintain provenance to source data, and support semantic, keyword, and graph traversal retrieval [@zep2026graphiti]. This is valuable for evolving facts and historical queries. Audrey's use of evidence is different: evidence is attached to an action decision and to recommendations that a host can enforce.

Cognee optimizes knowledge infrastructure for agent memory. The Cognee repository describes an open-source memory control plane that ingests data, combines embeddings and graphs, supports local execution, and provides traceability and cross-agent knowledge sharing [@cognee2026repo]. The Cognee paper studies hyperparameter optimization for graph construction, retrieval, and prompting in multi-hop question answering [@markovic2025cognee]. Audrey does not optimize knowledge-graph retrieval quality. It uses local memory to decide whether an agent action should proceed.

## Memory Benchmarks and Evaluation

MTEB optimizes broad evaluation of embedding models. It spans embedding tasks such as retrieval, clustering, reranking, and semantic textual similarity across many datasets and languages [@muennighoff2023mteb]. It is relevant because many memory systems rely on embeddings, but it evaluates representation quality rather than the behavioral effect of memory on a tool-using agent.

LongMemEval optimizes long-term chat-assistant memory evaluation. It tests information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention across sustained user-assistant histories [@wu2025longmemeval]. GuardBench is orthogonal. It starts after a system has some memory state and asks whether that state changes a future tool action.

LoCoMo optimizes very long-term conversational memory. It provides long dialogues across many sessions and evaluates question answering, event summarization, and multimodal dialogue generation [@maharana2024locomo]. GuardBench does not replace LoCoMo. It tests a separate failure surface: repeated actions, missing procedures, degraded recall, secret redaction, and contradictions at the tool boundary.

MemoryBench optimizes continual-learning evaluation from accumulated user feedback. Its paper argues that many memory benchmarks focus on homogeneous reading-comprehension tasks and introduces a user-feedback simulation framework across domains, languages, and task types [@ai2026memorybench]. Audrey's validation loop is smaller: it records whether a memory was used, helpful, or wrong, then updates salience and bookkeeping (Ledger: E16). GuardBench evaluates the control effect of those memories, not general continual-learning quality.

## MCP Tool Safety and Pre-Action Runtimes

The Model Context Protocol standardizes how clients discover and call tools. The 2025-06-18 schema defines `tools/list`, tool metadata, `tools/call`, input and output schemas, and tool annotations [@mcp2025schema]. MCP creates an interoperable tool surface; it does not define a memory-derived policy for whether a call should happen. Audrey fits beside MCP as a local controller that runs before a host invokes a tool.

MCP Security Bench optimizes evaluation of MCP-specific attacks. It introduces attack categories across task planning, tool invocation, and response handling, and evaluates LLM agents with real benign and malicious MCP tools [@zhang2026mcpsecuritybench]. Audrey is not an MCP attack benchmark and not a complete MCP defense system. It addresses one component inside a defensive host: memory-derived pre-action control with evidence and redaction.

The tool-poisoning paper studies semantic attacks against MCP-integrated systems, including malicious tool descriptors, shadowing through contaminated context, and descriptor changes after approval [@jamshidi2025toolpoisoning]. Audrey's trusted-control-source gate responds to a related risk inside memory: untrusted memories tagged as must-follow are not promoted into control rules (Ledger: E6). This does not solve tool poisoning. It reduces one path by which remembered content becomes operational instruction.

The MCP tool-annotations blog frames annotations as a risk vocabulary. It states that annotations such as read-only, destructive, idempotent, and open-world are hints, not guaranteed descriptions, and that clients should not base tool-use decisions on annotations from untrusted servers [@mcp2026toolannotations]. Audrey's decision layer is complementary: it uses remembered outcomes, procedures, contradictions, and recall health, not only static tool metadata.

## What Is Missing

Across the primary sources reviewed here, memory systems optimize extraction, retrieval, persistence, graph structure, context assembly, personalization, or continual learning. Safety work around MCP optimizes attack detection, tool metadata, and protocol-level risk. The missing evaluation target is action effect: whether memory changes what an agent does next. Audrey implements a redaction-first, evidence-linked, host-side controller that runs before tool use and returns `allow`, `warn`, or `block`; GuardBench specifies how to evaluate that category.
