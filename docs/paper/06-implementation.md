# 6. Implementation

Audrey is implemented as a local-first Node and TypeScript runtime with SQLite storage, vector and full-text indexes, MCP stdio tools, a REST sidecar, a Python client, a CLI, and release gates. The implementation is small enough to inspect directly, which is why this paper treats source-linked evidence as part of the artifact.

## Runtime Stack

The package requires Node 20 or newer and is implemented in TypeScript. The runtime uses `better-sqlite3` for local SQLite storage, `sqlite-vec` for vector tables, Hono for the REST sidecar, the Model Context Protocol SDK for the stdio MCP server, and `@huggingface/transformers` for the local embedding provider (Ledger: E31). Audrey also ships a Python client that calls the REST sidecar through synchronous and asynchronous methods (Ledger: E36).

Embedding providers are explicit. The default resolver selects the local provider with 384 dimensions and device `gpu` unless configured otherwise. The local provider uses `Xenova/all-MiniLM-L6-v2`. The mock provider uses 64 dimensions for deterministic tests and benchmarks. OpenAI and Gemini providers are supported but are not auto-selected from ambient API keys; operators must set `AUDREY_EMBEDDING_PROVIDER=openai` or `AUDREY_EMBEDDING_PROVIDER=gemini`. Their default dimensions are 1536 and 3072 respectively (Ledger: E31).

## Storage Schema

Audrey stores memory in SQLite. The schema is created and migrated in code, not through standalone SQL migration files. The database has typed memory tables, event tables, contradiction tables, vector tables, and FTS5 tables (Ledger: E29-E30).

| Storage Component | Role | Implementation Evidence |
|---|---|---|
| `episodes` | Episodic memories, including source, confidence, tags, context, affect, privacy, agent scope, usage, and consolidation fields. | E29 |
| `semantics` | Durable factual or preference memories with state, confidence, provenance, agent scope, salience, and usage fields. | E29 |
| `procedures` | Reusable operating procedures with trigger, steps, state, confidence, salience, and usage fields. | E29 |
| `contradictions` | Records unresolved or resolved conflicts between claims. | E29 |
| `memory_events` | Tool and memory event log, including session, tool, outcome, hashes, redacted summaries, and metadata. | E29 |
| `causal_links`, `consolidation_runs`, `consolidation_metrics`, `audrey_config` | Supporting tables for consolidation, lineage, metrics, and schema versioning. | E29 |
| `vec_episodes`, `vec_semantics`, `vec_procedures` | sqlite-vec indexes for typed vector search. | E30 |
| `fts_episodes`, `fts_semantics`, `fts_procedures` | FTS5 indexes for typed lexical search. | E30 |

The implementation keeps vector and FTS storage type-specific instead of flattening all memory into one undifferentiated index. That matters for control behavior because preflight can ask for risks, procedures, contradictions, and recent tool outcomes separately before producing a decision (Ledger: E5, E9, E29-E30).

## Recall and FTS

Audrey implements vector, keyword, and hybrid recall modes. Hybrid recall fuses vector KNN and FTS5 BM25 with reciprocal rank fusion. The current constants are `RRF_K = 60`, `VECTOR_WEIGHT = 0.3`, and `FTS_WEIGHT = 0.7` (Ledger: E14). FTS search is backed by separate `fts_episodes`, `fts_semantics`, and `fts_procedures` tables and returns BM25-ranked matches joined back to the live typed memory tables (Ledger: E30).

Recall is failure-aware. Before vector search, Audrey checks whether each expected vector table exists. During recall, it catches per-type KNN failures and FTS lookup failures, records them as `RecallError[]`, marks the result as a partial failure, and still returns available partial results (Ledger: E15, E40). Preflight then turns recall errors into high-severity memory-health warnings, so degraded retrieval changes control output instead of being silently swallowed (Ledger: E9-E10).

This distinction is important for GuardBench. A retrieval system that fails open under missing indexes can look accurate on happy-path queries while making unsafe tool decisions under degraded memory. Audrey exposes degradation through the same evidence and warning channels used for ordinary risks.

## Capsule Implementation

A memory capsule is the bounded context object that bridges recall and control. It contains budget metadata, truncation status, must-follow rules, project facts, preferences, procedures, risks, recent changes, contradictions, uncertain or disputed memories, evidence IDs, and recall errors (Ledger: E5). Capsule construction forces `scope: 'agent'`, preserving agent-local memory boundaries during recall (Ledger: E7).

Capsules also enforce a control-source gate. A `must-follow` style memory becomes a control signal only when the source is trusted as `direct-observation` or `told-by-user`; otherwise it is routed to uncertain or disputed context rather than treated as an instruction (Ledger: E6). This prevents untrusted memory content from escalating itself into an operational rule.

Budget enforcement is performed before the capsule is handed to preflight. The implementation tracks whether the capsule was truncated and keeps evidence IDs available even when natural-language sections are shortened (Ledger: E5). The pre-action controller therefore receives both a bounded textual packet and an auditable evidence list.

## Preflight and Reflexes

Preflight is the risk-scoring layer. Its output contract includes `go`, `caution`, and `block` decisions, a risk score, warnings, recent failures, status, recommended actions, evidence IDs, an optional event ID, and an optional capsule (Ledger: E8). Internally, preflight builds a capsule with risks and contradictions enabled, checks memory health, converts recall errors into high-severity warnings, and adds warning sources for recent failures, must-follow rules, risks, procedures, contradictions, and uncertain or disputed memories (Ledger: E9).

Warnings are sorted by severity. Risk score is derived from the highest warning severity, and strict mode blocks high-severity warnings (Ledger: E10). Reflex generation maps preflight warnings into `guide`, `warn`, or `block` reflexes with evidence IDs, reasons, recommendations, and optional embedded preflight data (Ledger: E11).

Evidence propagation is preserved across these layers. A warning generated from a procedure, contradiction, recall error, or prior failure carries evidence IDs into the preflight response; reflexes then carry those IDs into the agent-facing guard report (Ledger: E8-E11).

## Controller Implementation

`MemoryController.beforeAction()` is the pre-action entry point. It runs `audrey.reflexes()` in strict mode, requests the preflight and capsule, records a preflight event, and scopes recall to the current agent (Ledger: E2). The external guard result is `allow`, `warn`, or `block`, with a risk score, summary, evidence IDs, recommendations, optional capsule, reflexes, and optional preflight event ID (Ledger: E1).

Exact repeated-failure control is deterministic. Audrey computes an action identity from the tool name, redacted command or action text, normalized working directory, and sorted normalized file scope. If a prior failed tool event carries the same identity, the controller blocks the action before tool use (Ledger: E3). This is stricter than semantic similarity: the repeat block is keyed to the normalized action, not to whether an embedding happens to retrieve the old failure.

`MemoryController.afterAction()` closes the loop after tool execution. It records tool outcomes through `observeTool()`, stores the `audrey_guard_action_key`, redacts action, command, and error text, and encodes failed outcomes as tool-result memories (Ledger: E4). The same event stream supports future preflight checks and impact reporting.

## Redaction Implementation

Audrey redacts before tool traces enter durable memory. The tool-tracing module states that raw tool input, output, and error text do not leave the module without redaction, and it stores hashes, redacted summaries or details, file fingerprints, redaction state, and a memory event (Ledger: E12).

The redaction catalog covers named credentials, generic credentials, payment and PII patterns, and entropy-based fallbacks (Ledger: E13). Examples of concrete coverage:

| Pattern Class | Example Input Shape | Output Shape |
|---|---|---|
| AWS access key | `AKIA` followed by 16 uppercase alphanumeric characters. | `[REDACTED:aws_access_key:tail]` |
| Anthropic API key | `sk-ant-` followed by a long token. | `[REDACTED:anthropic_api_key:tail]` |
| OpenAI API key | `sk-...` or `sk-proj-...` long token. | `[REDACTED:openai_api_key:tail]` |
| GitHub token | `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_` token. | `[REDACTED:github_token:tail]` |
| Stripe key | `sk_live_`, `rk_live_`, `pk_live_`, or test equivalents. | `[REDACTED:stripe_live_key:tail]` or `[REDACTED:stripe_test_key:tail]` |
| Google API key | `AIza` plus the expected key body. | `[REDACTED:google_api_key:tail]` |
| Slack token | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, or `xoxs-` style token. | `[REDACTED:slack_token:tail]` |
| Bearer or Basic auth | `Bearer <token>` or `Basic <base64>`. | `Bearer [REDACTED:generic_bearer]` or `Basic [REDACTED:basic_auth]` |
| Private key block | PEM private-key block. | `[REDACTED:private_key_block]` |
| URL credentials | `scheme://user:password@host`. | `scheme://user:[REDACTED:url_credentials]@host` |
| Password assignment | `password=...`, `api_key: ...`, `auth_token=...`, or similar keys. | Original key plus `[REDACTED:password_assignment]` |
| Payment and PII | Luhn-valid card numbers, CVV labels, and US SSNs. | Payment or PII class marker. |
| Signed URLs and sessions | Signature, token, and session-cookie query or cookie fields. | Preserved field name plus redaction marker. |
| High-entropy fallback | Long mixed-character token with sufficient entropy. | `[REDACTED:high_entropy_secret:tail]` |

The JSON walker redacts sensitive keys and values recursively. If a value sits under a sensitive key and does not match a named pattern, it is still replaced with a password-assignment marker (Ledger: E13). Truncation is applied after redaction and preserves redaction markers rather than cutting them in half or dropping the only proof that a secret was removed (Ledger: E13).

## MCP, CLI, and REST Surfaces

The MCP server registers 20 tools: `memory_dream`, `memory_encode`, `memory_recall`, `memory_consolidate`, `memory_introspect`, `memory_resolve_truth`, `memory_export`, `memory_import`, `memory_forget`, `memory_validate`, `memory_decay`, `memory_status`, `memory_reflect`, `memory_greeting`, `memory_observe_tool`, `memory_recent_failures`, `memory_capsule`, `memory_preflight`, `memory_reflexes`, and `memory_promote` (Ledger: E32). The Guard-relevant MCP surface is `memory_observe_tool`, `memory_recent_failures`, `memory_capsule`, `memory_preflight`, and `memory_reflexes`, with `memory_validate` supporting closed-loop validation and REST or CLI impact reporting supporting aggregate impact inspection (Ledger: E16-E19, E32-E34).

The CLI recognizes `install`, `uninstall`, `mcp-config`, `hook-config`, `demo`, `guard`, `reembed`, `dream`, `greeting`, `reflect`, `serve`, `status`, `doctor`, `observe-tool`, `promote`, and `impact` (Ledger: E34). The `guard` subcommand invokes the controller, prints JSON or formatted output, exits nonzero for blocking decisions unless an explicit override is supplied, and can run as a Claude Code PreToolUse hook with `--hook`. `hook-config claude-code --apply` merges the generated hook block into Claude Code settings with backup/idempotence (Ledger: E26, E43).

The REST sidecar exposes routes for health, encode, recall, validate, mark-used, capsule, preflight, reflexes, consolidate, dream, introspect, impact, resolve-truth, export, import, forget, decay, status, reflect, and greeting (Ledger: E33). The sidecar defaults to loopback binding, refuses non-loopback binds without `AUDREY_API_KEY` unless `AUDREY_ALLOW_NO_AUTH=1`, and emits an explicit warning when that no-auth override is used (Ledger: E35). Export, import, and forget are disabled unless `AUDREY_ENABLE_ADMIN_TOOLS=1` (Ledger: E33).

## Configuration

The README documents the runtime environment variables that affect storage, provider selection, server exposure, admin tools, and performance behavior (Ledger: E37). The security-critical defaults are:

| Variable | Default | Security Role |
|---|---|---|
| `AUDREY_HOST` | `127.0.0.1` | Keeps the REST sidecar on loopback by default. Non-loopback exposure requires auth or an explicit unsafe override (Ledger: E35, E37). |
| `AUDREY_API_KEY` | unset | Required bearer token for non-loopback REST traffic (Ledger: E35, E37). |
| `AUDREY_ALLOW_NO_AUTH` | `0` | Escape hatch for non-loopback without auth. The docs explicitly mark this as unsafe (Ledger: E35, E37). |
| `AUDREY_ENABLE_ADMIN_TOOLS` | `0` | Keeps export, import, and forget routes/tools disabled by default (Ledger: E33, E37). |
| `AUDREY_PROMOTE_ROOTS` | unset | Restricts `audrey promote --yes` writes to `process.cwd()` unless additional roots are explicitly listed (Ledger: E37). |

`AUDREY_MODEL` is not part of the documented Audrey environment matrix and is not used as an Audrey runtime variable in the inspected source. Model selection is currently represented by provider defaults and provider-specific environment variables, not by a single `AUDREY_MODEL` switch (Ledger: E38).

## Testing and Release Gates

The package scripts wire build, typecheck, Vitest, perf benchmark, performance snapshot, memory regression check, npm pack dry-run, release gate, and sandbox release gate commands (Ledger: E39). The documented release path also includes Python unittest discovery and Python package build commands (Ledger: E39).

`bench:memory:check` is a regression gate. It runs retrieval and lifecycle benchmark suites, compares Audrey against vector-only, keyword-plus-recency, and recent-window local baselines, and enforces score, pass-rate, and margin guardrails (Ledger: E23). Section 7 reports the current output as a regression-gate result, not as a cross-system leaderboard.

For the repeated-failure evaluation transcript in this paper, the project was rebuilt with `npm run build` before running `node dist/mcp-server/index.js demo --scenario repeated-failure`; the build completed successfully (Ledger: E41).
