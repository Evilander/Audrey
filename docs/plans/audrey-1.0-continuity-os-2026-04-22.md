# Audrey 1.0 — Continuity OS for AI Agents

Plan date: 2026-04-22
Status: Active master plan. Supersedes the "biological memory library" framing.

## Category statement

**Audrey is the local-first continuity OS that makes AI agents learn from experience.**

Not a memory database. Not RAG for chat history. Not persistent context.

Audrey turns agent experience into reusable behavior. Memory goes in as experience; better future behavior comes out. The moat is the memory ledger, the behavior compiler, the eval suite, and the project-specific operating knowledge Audrey accumulates.

## Why this category, not "better recall"

The industry is chasing better retrieval: embeddings, graphs, summaries, recall accuracy. That matters but is not the breakthrough. The breakthrough is that a memory project should not merely remember what happened. It should convert what happened into better future behavior: fewer repeated mistakes, safer tool use, faster onboarding, cleaner project continuity, agent habits that improve over time.

Supporting signals from April 2026 research:

- LongMemEval / LoCoMo: long-term memory is moving past raw vector search into temporal reasoning, knowledge updates, abstention, structured memory, and agentic workflows.
- Mem0: extract, consolidate, retrieve salient memories rather than carrying full context. Strong latency and token-cost reductions vs. full-context.
- Zep / Graphiti: temporal knowledge graphs for conversational and business data.
- MIRIX: modular memory types — core, episodic, semantic, procedural, resource, knowledge-vault.
- MemOS: memory as an OS-managed resource with provenance, versioning, multiple formats.
- SmartSearch: ranking and token-budget allocation often matter more than elaborate memory structure.
- Memora: keep abstractions linked to concrete cue anchors.
- AMA-Bench: memory systems that look strong on dialogue can still fall short on long-horizon agentic tasks.

Collectively: memory should be designed around actions, not conversations.

## Audrey's six jobs

1. **Observe** what the agent actually does.
2. **Remember** useful facts, procedures, preferences, failures, decisions.
3. **Reconcile** contradictions over time.
4. **Retrieve** the right memory, at the right specificity, within the right token budget.
5. **Compile** repeated lessons into behavior — rules, hooks, tests, checklists, playbooks.
6. **Govern** memory with provenance, privacy, scope, expiry.

Most memory systems say "here are some relevant memories." Audrey should say: *"Here is what we learned, here is why we believe it, here is when it changed, and here is the behavior we should now enforce."*

## Overlooked insight: the tool trace is the richest memory source

The highest-value moments are around tool execution — shell commands, test failures, file edits, failed builds, repeated fixes, deployment mistakes, environment assumptions, subagent handoffs. Audrey's current MCP/hook wiring centers on session start, user prompt, stop, post-compact. Claude Code's hook system also exposes lifecycle events around tool use that can inspect or block. That gap is the opportunity.

Everyone is chasing "agent remembers the conversation." Audrey chases: **agent remembers the work.**

## Build order (five major PRs)

Each PR must be independently shippable with tests green.

### PR 1 — Action Trace Memory

Capture the agent's actual work. Compact, redacted metadata by default — never hoard raw logs.

Files:

- `src/events.ts`
- `src/redact.ts`
- `src/tool-trace.ts`
- `src/db.ts` migration v11 for `memory_events`

Schema:

```sql
CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_agent TEXT,
  tool_name TEXT,
  input_hash TEXT,
  output_hash TEXT,
  outcome TEXT,
  error_summary TEXT,
  cwd TEXT,
  file_fingerprints TEXT,
  redaction_state TEXT DEFAULT 'unreviewed',
  metadata TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

New CLI:

```
audrey observe-tool \
  --event PostToolUse \
  --tool Bash \
  --outcome failed \
  --cwd "$PWD" \
  --input-json "$HOOK_INPUT"
```

Hook events to wire (via Claude Code hook config pointing at `audrey observe-tool`):

- PreToolUse
- PostToolUse
- PostToolUseFailure
- PreCompact
- PostCompact

Default behavior:

- capture metadata, not raw logs
- redact aggressively (credentials, API keys, tokens, passwords, private keys, PAN/CVV, patient identifiers, source-code secrets, one-time URLs, session cookies)
- mark tool traces private by default
- summarize noisy output
- store command outcome
- link events to later reflections

Example memory derived from a tool trace:

```json
{
  "type": "procedural",
  "content": "Before running integration tests in Audrey, ensure the local SQLite vector extension is available and the test database has been initialized.",
  "source": "tool-trace",
  "evidence": ["failed npm test on 2026-04-22", "passed after initializing test DB"],
  "scope": "repo:Evilander/Audrey",
  "confidence": 0.82,
  "tags": ["testing", "sqlite", "procedure", "failure-prevention"]
}
```

Acceptance:

- `memory_events` table created via migration
- `audrey observe-tool` CLI logs a redacted event
- MCP tool `memory_observe_tool` mirrors the CLI
- Integration test: simulate PreToolUse + PostToolUse, verify redacted row written
- README section "Hook-driven action trace memory"

### PR 2 — Memory Capsule

Stop returning loose memory lists. Return a structured, ranked, evidence-backed packet: the Memory Capsule.

Files:

- `src/capsule.ts`
- `src/query-intent.ts`
- `src/retrieval-policy.ts`
- `src/rerank.ts`

Capsule sections (always present, may be empty):

1. must_follow
2. project_facts
3. user_preferences
4. procedures
5. risks
6. recent_changes
7. contradictions
8. uncertain_or_disputed
9. evidence

Shape:

```json
{
  "must_follow": [
    { "memory": "...", "scope": "global", "confidence": 0.97, "evidence": ["..."] }
  ],
  "project_facts": [
    { "memory": "...", "scope": "repo:Evilander/Audrey", "confidence": 0.95 }
  ],
  "procedures": [{ "memory": "...", "scope": "...", "confidence": 0.88 }],
  "risks": [{ "memory": "...", "scope": "...", "confidence": 0.79 }],
  "uncertain_or_disputed": [
    { "memory": "...", "confidence": 0.55, "recommended_action": "Verify ... before release." }
  ]
}
```

Config env vars:

```
AUDREY_CONTEXT_BUDGET_CHARS=4000
AUDREY_CAPSULE_MODE=balanced
AUDREY_RETRIEVAL_POLICY=adaptive
```

Every important memory must have a reason it was included. Capsules must be explainable. FTS (`src/fts.ts` — already exists) becomes a retrieval input here alongside vector KNN; fusion via RRF.

Acceptance:

- `Audrey#capsule(query, options)` returns a structured capsule
- MCP tool `memory_capsule` exposes it
- HTTP route `POST /v1/capsule`
- `tests/capsule.test.ts` covers ranking, token budget, and explainability
- Unskip `tests/fts.test.js`

### PR 3 — Claims, Entities, Temporal Validity

Separate facts from preferences from guesses from expired truths. Store claims with subject, predicate, object, scope, valid-from, valid-to, evidence, state.

Files:

- `src/claims.ts`
- `src/entities.ts`
- `src/temporal.ts`
- `src/contradiction-v2.ts`
- `src/cue-anchors.ts`

Schema:

```sql
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  scope TEXT,
  confidence REAL DEFAULT 0.5,
  valid_from TEXT,
  valid_to TEXT,
  observed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  state TEXT DEFAULT 'active',
  source_event_ids TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  type TEXT,
  aliases TEXT,
  scope TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE memory_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  discovered_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cue_anchors (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  anchor TEXT NOT NULL,
  anchor_type TEXT,
  weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Scope values: `global`, `user`, `repo:<slug>`, `agent:<name>`, `session:<id>`, temporary.

Specificity-preserving consolidation: anchor every abstraction to concrete cue anchors (repo slugs, command names, file paths, error signatures, tags).

Bad: "User likes efficient development."
Good: "In the Audrey repo, user prefers local-first, auditable memory features over cloud-dependent memory features."

Acceptance:

- Migrations for all four tables
- `Audrey#claims.upsert`, `Audrey#claims.resolve(at: Date)`, `Audrey#claims.close(id, valid_to)`
- Contradiction resolution prefers newer evidence, honors scope
- Unskip `tests/multi-agent.test.js` (scope now a first-class concept)

### PR 4 — Memory-to-Behavior Compiler

Promote durable procedural memories into executable behavior. This is the product's strongest differentiator.

Files:

- `src/promote.ts`
- `src/playbooks.ts`
- `src/rules-compiler.ts`
- `src/hook-compiler.ts`

New CLI:

```
audrey promote
audrey promote --dry-run
audrey promote --target claude-rules
audrey promote --target agents-md
audrey promote --target hooks
audrey promote --target playbook
```

Output targets:

- `.claude/rules/*.md`
- `AGENTS.md`
- `.audrey/playbooks/*.md`
- `.audrey/checklists/*.md`
- `.audrey/hooks/*.json`
- `.audrey/tests/memory-regression/*.json`

Promotion candidate format:

```
Promotion candidate:
  Memory: "Run snapshot/restore tests after schema edits."
  Evidence: observed in 4 sessions, prevented 2 repeated failures.
  Target: .claude/rules/schema.md
  Confidence: 0.91
  Action: approve / reject / edit
```

Never silently rewrite project files. Always propose with evidence. Manual approval or explicit `--yes` flag required.

Preemptive guardrails (PreToolUse hook):

- warn on dangerous commands
- warn on commands that previously failed
- warn on missing prerequisites
- warn on file edits that require paired edits
- block actions that violate project preferences
- block attempts to store sensitive data in memory

Acceptance:

- `audrey promote --dry-run` prints candidates without touching the FS
- `audrey promote --target claude-rules --yes` writes `.claude/rules/*`
- Hook compiler emits `.claude/hooks/pre-tool-use.json` entries that call back into `audrey recall` for preflight warnings
- Unskip `tests/relevance.test.js` (markUsed / usage_count feed promotion eligibility)

### PR 5 — Agent Continuity Benchmark

Evaluate whether memory *changes future behavior*, not just whether it recalls.

Directory: `bench/agent-continuity/`

Scenarios (each a JSON file):

- `bench/scenarios/tool-failure-recall.json`
- `bench/scenarios/schema-edit-procedure.json`
- `bench/scenarios/contradicted-workaround.json`
- `bench/scenarios/private-secret-redaction.json`
- `bench/scenarios/user-preference-persistence.json`
- `bench/scenarios/cross-session-debugging.json`
- `bench/scenarios/project-specific-command.json`
- `bench/scenarios/memory-abstention.json`
- `bench/scenarios/capsule-token-budget.json`
- `bench/scenarios/subagent-handoff.json`

Metrics:

- future_failure_prevented
- correct_pre_tool_warning
- memory_precision
- memory_abstention
- evidence_presence
- privacy_boundary
- token_budget_efficiency
- contradiction_resolution
- procedure_promotion_quality

Alongside the existing LongMemEval-style regression suite (`benchmarks/`), agent continuity scores become the headline external benchmark.

Acceptance:

- `npm run bench:continuity` runs all scenarios against a real LLM
- `npm run bench:continuity:check` enforces regression gates
- README shows continuity scores alongside LoCoMo

## Killer demo: Audrey prevents the same bug twice

Session 1:
- User: Run the test suite.
- Agent: Runs `npm test`.
- Result: Fails because sqlite extension / test DB not initialized.
- Agent: Fixes setup.
- Audrey: Captures failure, fix, and passing command via tool-trace.

Session 2:
- User: Run the test suite.
- Audrey PreToolUse: "Before running `npm test`, check sqlite extension and initialize test DB. This prevented a previous failure."
- Agent: Runs preflight.
- Agent: Runs `npm test`.
- Result: Passes first try.

Session 3:
- `audrey promote`: "This procedure has prevented repeated failures. Promote to `.claude/rules/testing.md`?"

That demo says everything. Memory becomes behavior.

## Experience Graph

Audrey owns a new first-class object: the Experience Graph. Not just a knowledge graph — an experience graph.

Nodes: user_preference, repo_fact, command, failure, fix, file, procedure, contradiction, decision, rule, promoted_behavior, benchmark_result.

Edges: caused, fixed_by, contradicted_by, depends_on, applies_to, promoted_to, observed_in, expired_by, similar_to, requires.

Most memory tools remember what was said. Audrey remembers what worked.

## Trust and privacy as product features

Audrey's edge is: local, inspectable, controllable, evidence-backed.

Visible trust layer CLI / MCP / HTTP:

- `audrey inspect-memory`
- `audrey redact`
- `audrey forget`
- `audrey quarantine`
- `audrey export-evidence`
- `audrey audit`

Memory states: active, private, quarantined, contradicted, expired, promoted, needs_review.

Automatic redaction classes: credentials, API keys, tokens, passwords, private keys, PAN / CVV / payment data, patient identifiers, source-code secrets, one-time URLs, session cookies.

## "What changed?" mode

```
audrey diff --since "last session"
audrey diff --scope repo:Evilander/Audrey
audrey what-changed "testing setup"
```

Example output:

```
Since last session:
- New procedure learned: run sqlite extension check before integration tests.
- Updated fact: benchmark target changed from X to Y.
- Contradiction detected: README says Node 20+, package metadata may allow a different range.
- New risk: schema edits can break restore compatibility.
```

For long-running projects, this is huge. Developers do not only need recall. They need **continuity**.

## Strategic positioning

Strongest wedge: developer / agent continuity, not broad consumer memory.

Coding agents create high-signal traces: commands, diffs, tests, errors, commits, files, tool calls, environment issues, recurring workflows. Those traces are measurable. Prove Audrey saved time by preventing repeated failures. Prove Audrey respected privacy by showing the audit log. Prove Audrey improved the agent by showing behavior before and after promotion.

Audrey does not compete by saying "we also have memory." Audrey competes by saying: "We turn memory into project behavior across agents, tools, hooks, and environments." Audrey sits underneath Claude Code, OpenAI agents, custom MCP clients, local CLIs, and internal developer tools.

## Currently skipped tests → future PR mapping

| Test file / case | Unblocks in PR | Feature |
|---|---|---|
| `tests/fts.test.js` | PR 2 (Memory Capsule) | FTS retrieval input |
| `tests/multi-agent.test.js` | PR 3 (Claims / scope) | agent + repo scope |
| `tests/relevance.test.js` | PR 4 (Promote) | markUsed / usage_count |
| `tests/audrey.test.js > waitForIdle drains tracked background work` | PR 1 prerequisites | `_trackAsync` / `_pending` internals |
| `tests/recall.test.js > surfaces partial failures when a recall path breaks` | PR 1 prerequisites | recall() returns `partialFailure` + `errors` |

## Out of scope for 1.0

- Audrey Cloud / multi-tenant billing (deferred)
- LangChain / LangGraph adapter (can follow 1.0)
- Vercel AI SDK adapter (can follow 1.0)
- Encryption at rest (SQLCipher) — optional peer dep in a 1.x point release
- Remote MCP for ChatGPT — tracked as a separate deliverable with its own hosting story

## One-line summary

The future of memory is not remembering more. It is repeating less.
