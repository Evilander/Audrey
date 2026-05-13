# 4. Design: Audrey Guard as a Pre-Action Memory Controller

Audrey Guard is the pre-action control layer of Audrey, not a separate memory store. It uses the same local memory runtime, tool-event log, recall path, validation feedback, and MCP/CLI surfaces, then adds one controller loop around tool use. The controller's output is deliberately narrow: `allow`, `warn`, or `block`, plus risk score, evidence, reflexes, recommendations, and an optional capsule (Ledger: E1).

The design has four layers:

1. Tool events enter through a redaction-first trace layer.
2. Recall and event history are assembled into a bounded memory capsule.
3. Preflight turns capsule entries, recent failures, contradictions, memory health, and recall errors into a risk-scored decision.
4. Reflexes and the top-level controller convert the preflight into host-facing guidance, repeated-failure blocking, and post-action learning.

This section describes the implemented design as of the current repository state. Each Audrey implementation claim references the evidence ledger.

## Architecture Overview

Audrey's public surface includes MCP tools for observation, capsules, preflight, reflexes, validation, and dream/consolidation (Ledger: E18-E19). The package metadata describes the system as a local-first memory runtime with recall, consolidation, memory reflexes, contradiction detection, and tool-trace learning (Ledger: E27). The Guard design composes these existing mechanisms rather than introducing a separate policy engine.

The runtime path is:

```text
agent proposes action
        |
        v
MemoryController.beforeAction(a_t)
        |
        v
audrey.reflexes(action, strict=true, includePreflight=true, includeCapsule=true)
        |
        v
buildPreflight(...) -> buildCapsule(...) -> recall + events + status
        |
        v
GuardResult { allow | warn | block, evidence, recommendations }
        |
        v
tool executes only if host permits it
        |
        v
MemoryController.afterAction(o_t) -> observeTool(...) + optional failure memory
```

The controller is host-side. It does not ask the language model to decide whether memory matters. It converts memory state into a small decision object that a CLI, hook, MCP client, or agent runtime can enforce.

## Controller Loop

`MemoryController.beforeAction()` is the orchestration point. It calls `audrey.reflexes()` with `strict: true`, `includePreflight: true`, `includeCapsule: true`, `recordEvent: true`, and `scope: 'agent'` (Ledger: E2). This means a pre-action check records its own trace, returns the underlying evidence packet, and blocks on high-severity warnings rather than treating them as advisory text.

The controller then checks exact repeated failures outside the general preflight path. If a matching failed tool event exists, the controller returns `block`, raises the risk score to at least `0.9`, prepends a recommendation not to repeat the exact failed action, and merges the prior failure event IDs with reflex evidence IDs (Ledger: E3). This rule gives repeated-failure prevention a deterministic path that does not depend on embedding similarity, lexical search, or model interpretation.

`MemoryController.afterAction()` closes the loop after execution. It records the tool outcome through `observeTool()`, attaches the action hash as `audrey_guard_action_key`, and, when the outcome is failed and a redacted error summary exists, encodes a high-salience `tool-result` memory containing the failure, command, and error summary (Ledger: E4). The next preflight can therefore use both structured event history and ordinary recall.

This loop makes memory an action governor. The system remembers not only what was said, but what happened when an agent touched a tool.

## Capsule Construction

The capsule is the evidence packet that feeds preflight. It replaces a loose recall list with a typed, budgeted object containing:

- `must_follow`
- `project_facts`
- `user_preferences`
- `procedures`
- `risks`
- `recent_changes`
- `contradictions`
- `uncertain_or_disputed`
- `evidence_ids`
- optional `recall_errors`

The capsule also reports `budget_chars`, `used_chars`, and `truncated` so downstream callers know whether the packet was pruned (Ledger: E5).

Capsule construction starts with recall and then enriches results with tags, provenance, state, evidence IDs, recent failure events, and open contradictions. The implementation forces recall to `scope: 'agent'` even if a caller passes a different scope through capsule options (Ledger: E7). This is a security and relevance decision: the controller should not block or guide one agent using another agent's unrelated private work.

The capsule's control-source rule is conservative. A memory tagged as `must-follow`, `must`, `required`, `never`, `always`, or `policy` becomes a must-follow control signal only when its source is `direct-observation` or `told-by-user`; the same tag from an untrusted source is classified as uncertain/disputed context (Ledger: E6). This prevents tool output, imported text, or adversarial memory content from becoming a rule merely by containing a policy-looking tag.

The capsule includes two non-recall evidence classes. First, recent tool failures are inserted into the `risks` section as `tool_failure` entries with confidence derived from failure count (Ledger: E5). Second, open contradictions are inserted into the `contradictions` section with both sides referenced as evidence (Ledger: E5). These are control-relevant facts even when the current semantic query does not retrieve them.

Finally, capsule pruning uses section priority. Must-follow rules, risks, contradictions, and procedures are retained before general project facts and preferences when the character budget is tight (Ledger: E5). This is the right asymmetry for pre-action control: the controller loses optional context before losing stop conditions.

## Preflight Risk Scoring

Preflight is the decision layer over the capsule. The output contract includes the action, query, tool, working directory, generated timestamp, decision, verdict, `ok_to_proceed`, numeric `risk_score`, summary, warnings, recent failures, optional status, recommended actions, evidence IDs, optional preflight event ID, and optional capsule (Ledger: E8).

`buildPreflight()` constructs its query from the action, tool, and working directory, then requests a conservative capsule with risks and contradictions enabled (Ledger: E9). It adds warnings from seven sources:

- memory health failures or re-embedding recommendations;
- recall errors carried by the capsule;
- recent failed tool events matching the action or tool;
- must-follow capsule entries;
- remembered risks and tool failures;
- remembered procedures;
- open contradictions and uncertain/disputed entries.

Each warning has a type, severity, message, reason, optional evidence ID, and optional recommended action (Ledger: E8-E9). The decision rule is intentionally simple. Warnings are sorted by severity. The risk score is the maximum severity score. In strict mode, any high-severity warning returns `block`; high or medium warnings outside strict mode return `caution`; absence of such warnings returns `go` (Ledger: E10). The controller maps `go` to `allow`, `caution` to `warn`, and `block` to `block` (Ledger: E1).

This scoring rule trades statistical sophistication for auditability. A user can inspect the warning type and evidence ID that produced the decision. The rule is also stable under small recall-score perturbations: once an item enters the capsule and is categorized as high-severity, the block decision does not depend on an opaque model score.

## Reflex Generation

Reflexes are the host-readable form of preflight warnings. `buildReflexReport()` calls `buildPreflight()` and maps each warning into a `MemoryReflex` with a stable hash ID, trigger text, response type, severity, source warning type, response, reason, evidence ID, action, tool, and working directory (Ledger: E11).

The response type is derived from decision and warning semantics. A high-severity warning under a blocking preflight becomes `block`; an informational procedure becomes `guide`; other warnings become `warn` (Ledger: E11). The report returns the preflight decision, risk score, summary, reflexes, evidence IDs, recommended actions, and optionally the embedded preflight (Ledger: E11).

This layer separates the controller's enforcement object from user-facing guidance. The host can enforce the top-level decision while still showing a concise list of trigger-response reflexes that explain what memory changed.

## Action Identity Hashing

Repeated-failure prevention requires stable action identity. Audrey's action key is a SHA-256 hash over:

- lower-cased tool name;
- redacted command or action text normalized for whitespace and case;
- normalized working directory;
- sorted normalized file paths.

The implementation resolves real paths when available, removes Windows extended path prefixes, normalizes slashes, lowercases paths on Windows, and sorts the file set before hashing (Ledger: E3). The repeated-failure matcher then scans failed tool events for the same tool and agent and checks whether event metadata contains the same `audrey_guard_action_key` (Ledger: E3).

This design avoids two failure modes. Raw command matching leaks secrets and treats path spelling differences as different actions. Pure semantic matching catches near neighbors but cannot prove that the exact failed operation is being repeated. Audrey uses a redacted deterministic key for the exact-repeat case and leaves broader similarity risks to capsule/preflight.

## Redaction Discipline

Tool traces are both valuable and dangerous. The trace layer states an explicit contract: raw tool input, output, and error text do not leave `tool-trace.ts` without redaction (Ledger: E12). By default, tool tracing stores hashes and summaries rather than full payloads. When callers opt into retained details, those details still pass through JSON redaction before persistence (Ledger: E12-E13).

The redaction layer is rule-based and conservative. It covers provider keys, GitHub and Slack tokens, Stripe keys, bearer/basic auth, private key blocks, JWTs, URL credentials, password and secret assignments, credit cards, CVV, US SSNs, signed URL signatures, session cookies, high-entropy secrets, and sensitive JSON keys (Ledger: E13). Truncation preserves redaction markers so an audit trail still records what class of secret was removed even when the surrounding text is shortened (Ledger: E13).

The trace layer also computes file fingerprints from files under the current working directory, capped at 50 files, rather than storing raw file contents (Ledger: E12). This gives preflight evidence enough identity to connect a future action with a prior failure without turning the memory log into an uncontrolled data sink.

## Recall and Degradation Handling

Audrey recall uses hybrid retrieval: vector KNN and FTS5 BM25 are fused with reciprocal rank fusion, using `RRF_K = 60`, vector weight `0.3`, FTS weight `0.7`, and mode-specific behavior for vector, keyword, and hybrid retrieval (Ledger: E14). The paper should treat these weights as implementation choices, not theoretical claims.

More important for Guard is recall degradation. Audrey's recall result type carries `partialFailure` and `errors`; memory status exposes `recall_degraded` and `last_recall_errors`; capsules preserve recall errors; preflight turns capsule recall errors into high-severity memory-health warnings with repair guidance (Ledger: E7, E9, E15). In strict guard mode, this becomes a block because high-severity warnings block (Ledger: E10).

This behavior is a core distinction between recall as context and memory as control. A chat assistant can degrade gracefully by answering from partial recall. A pre-action controller that cannot inspect part of memory should not present a clear action path as equivalent to complete recall.

## Closed-Loop Validation

Audrey includes explicit post-hoc validation. `memory_validate` accepts `used`, `helpful`, or `wrong`; the implementation updates salience, usage count, retrieval count, challenge count, and last-use/reinforcement fields according to memory type (Ledger: E16). Impact reporting then aggregates totals, validation windows, semantic challenge counts, validation outcomes from audit events, top-used memories, weakest memories, and recent activity (Ledger: E17).

Guard validation can also bind the feedback event to the exact `preflight_event_id`, evidence set, and action fingerprint that surfaced a memory. This keeps post-hoc feedback attached to the pre-action decision it is judging instead of treating validation as an unscoped memory tap (Ledger: E44).

The controller uses validation in the repeated-failure demo: after Guard blocks the repeat action, the demo validates the operational lesson as helpful and reports impact counts (Ledger: E25). This is qualitative evidence, not a benchmark score. Its role in the paper is to show the end-to-end control loop: failure, memory write, preflight block, evidence, validation.

## Interfaces

Audrey exposes Guard through both MCP and CLI surfaces. MCP registers the lower-level tools needed to assemble the loop: `memory_observe_tool`, `memory_capsule`, `memory_preflight`, `memory_reflexes`, `memory_validate`, and `memory_dream` (Ledger: E18-E19). The CLI exposes `audrey guard`, which parses tool/action/file/cwd/session options, runs `MemoryController.beforeAction()`, prints JSON or formatted output, and exits with code `2` on block or fail-on-warn unless overridden (Ledger: E26).

The deterministic demo, `audrey demo --scenario repeated-failure`, constructs a temporary mock-provider store, records a failed deploy, encodes the required remediation as a must-follow memory, reruns preflight on the same action, validates the lesson, and reports whether a repeated failure was prevented (Ledger: E25). This demo is the right Stage-A qualitative figure because it exercises the implemented controller path without external API keys or hosted services.

## Existing Empirical Hooks

The current paper version has two implemented empirical anchors. First, `benchmarks/snapshots/perf-0.22.2.json` reports canonical local performance under the mock-provider methodology: generated on 2026-05-01 from git SHA `e2e821b`, using mock 64-dimensional in-process embeddings, hybrid recall limit 5, and corpus sizes 100, 1,000, and 5,000 on Node 25.5.0 with a 24-core Ryzen 9 7900X3D and 62.9 GB RAM (Ledger: E20). Under that methodology, hybrid recall p95 is 1.82 ms, 2.364 ms, and 3.417 ms for those three sizes, and encode p95 is 0.589 ms, 2.147 ms, and 1.838 ms (Ledger: E21-E22).

Second, `bench:memory:check` is wired into the release gate and enforces retrieval/lifecycle benchmark guardrails against weak local baselines (Ledger: E23). The current checked-in output reports a 2026-05-08 mock-provider run in which Audrey scores 100% with 100% pass rate, while the strongest listed local baselines score 41.67% with 25% pass rate in that output (Ledger: E24). These numbers support regression-gate honesty; they do not replace GuardBench.

The README benchmark table currently differs from the canonical JSON snapshot, so the paper quotes only the JSON snapshot and tracks the README correction as a follow-up (Ledger: E28).

## Design Consequence

The central design consequence is that memory is not treated as passive context. It becomes a control signal with a lifecycle:

```text
observe -> redact -> remember -> retrieve -> capsule -> preflight -> reflex -> allow/warn/block -> validate
```

This lifecycle is the paper's contribution. The Stage-A paper should present GuardBench as the evaluation specification for this lifecycle, while reporting only the implemented Audrey artifacts and current Audrey-only measurements that already exist in the repository.
