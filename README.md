<div align="center">
  <img src="docs/assets/audrey-wordmark.png" alt="Audrey" width="720">

  <p><strong>Memory that shows up before your coding agent makes the same mistake twice.</strong></p>

  <p>
    Audrey gives Codex and Claude Code one local, evidence-backed memory loop:
    remember what mattered, recall it automatically, check before acting, and learn from what happened next.
  </p>

  <p>
    <a href="https://github.com/Evilander/Audrey/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Evilander/Audrey/actions/workflows/ci.yml/badge.svg?branch=master"></a>
    <a href="https://www.npmjs.com/package/audrey"><img alt="npm version" src="https://img.shields.io/npm/v/audrey.svg"></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  </p>
</div>

## Memory before action

You fix the deploy command on Monday. On Thursday, a fresh session tries the broken version again.

Audrey brings relevant project memory into the next session, checks supported tool calls before they run, and links their reported outcomes to the check that preceded them. A Guard decision carries evidence IDs you can inspect. Grounding can flag memories that reference deleted files or package scripts.

Try the SQLite-backed demo before configuring a host:

```bash
npm exec --yes --package=audrey -- audrey demo --scenario repeated-failure
```

The demo simulates a failed deploy, passes read-only inspection commands through the hook, and checks a proposed retry. It does not execute a deployment or change host configuration. After npm fetches the package, the demo needs no API key, model download, or network call.

## Meet Audrey Autopilot

Install Audrey once, review the hooks once, and then use Codex or Claude Code normally.

```bash
npm install -g audrey
audrey install --host auto
```

Requires Node.js 22.16+ (22.x) or 24+. SQLite is built into Node, so fresh installs and `npx` launches work without approving dependency scripts. npm 11.17+ may warn about dependency scripts, and npm 12 may report that it blocked them; those scripts are not required for Audrey's CPU embedding runtime.

`auto` configures whichever supported CLIs are installed. You can choose one explicitly:

```bash
audrey install --host codex
audrey install --host claude-code
```

Restart the host after installation. Codex asks you to trust non-managed hooks once through `/hooks`; Claude Code may also ask you to approve project or plugin components. Audrey is automatic after that explicit install-and-trust step—never secretly installed.

Autopilot then closes the loop:

| Moment | What Audrey does |
|---|---|
| Session starts | Injects a compact, agent-scoped memory briefing |
| You send a prompt | Recalls relevant evidence; explicitly durable phrases such as “remember that…” or “I prefer…” can become memories |
| Bash/edit/write is proposed | Checks exact prior failures, trusted rules, procedures, contradictions, and memory health |
| The tool finishes | Correlates `tool_use_id` to the Guard receipt and records the redacted outcome |
| A tool failure is reported | Forms a durable, sanitized failure memory for the next attempt |
| The turn stops or context compacts | Runs lightweight, due-only consolidation without holding the conversation open |

An outcome reflects the tool's reported status. A zero exit code can still produce stale or incorrect output. Custom integrations can declare [required result checks](docs/SUCCESS_CHECKS.md) in `beforeAction` and supply the actual output to `afterAction`. Guard then records a mismatch as failed and an unverifiable reported success as unknown. Audrey does not generate application-specific checks or infer the expected values.

Each hook event carries a host-declared timeout (30 seconds for the `PreToolUse` Guard check). Audrey caps individual hosted embedding/LLM requests below that deadline; this is not a deadline for the entire hook, and local model initialization has no equivalent internal timeout. Errors caught by Audrey fail open by default: the hook emits no decision. Set `AUDREY_HOOK_FAIL_CLOSED=1` to deny a `PreToolUse` action on a caught error. If the host terminates the process first, the host determines what happens. Other lifecycle hooks have no deny path and always degrade open on caught errors.

## A small story about a failed deploy

The first attempt fails:

```text
$ npm run deploy
Error: deployment target is missing
```

Audrey keeps a redacted trace and an action fingerprint. If another session under the same agent identity proposes that action, Guard can deny the retry with evidence. A later recorded success for that fingerprint clears the exact-failure block. If the failed action declared result checks, recovery must pass the same checks. The default exact-failure window is seven days; other memory warnings are evaluated separately.

Fixing a file or deployment target does not itself clear the block. For a deliberate retry, the Guard API accepts `acknowledgePriorFailure: true` (MCP/REST: `acknowledge_prior_failure`; CLI: `--acknowledge-prior-failure`). Autopilot also recognizes retry language in the current user prompt. Acknowledgement lowers the exact-failure block to a warning and preserves its evidence; it does not bypass separate policy warnings.

Guard does not yet evaluate whether a natural-language prerequisite has been satisfied. A trusted must-follow memory can keep blocking even after its suggested repair succeeds. Review the cited rule when that happens; changing a command's spelling is not proof that its underlying problem is fixed.

## Looking is not doing

Inspection commands such as `grep`, `git status`, and `cat` normally need no memory check. A non-zero exit from `grep` can simply mean there was no match.

A command whose every part is positively recognised as read-only skips Guard. The classifier rejects command substitution, redirects other than `/dev/null`, `sudo`, `xargs`, and environment assignments that could change command resolution. Inspection outcomes can be recorded, but are excluded from failure learning. Unrecognised commands remain guarded.

```text
$ grep -rn "prisma" src/          Guard: silent
$ git status --short              Guard: silent
$ cat prisma/schema.prisma        Guard: silent
$ npm run deploy
Audrey Guard: BLOCKED
- recent_failure (high): This exact Bash action failed before: Prisma client was not generated. Run npm run db:generate before deploy.
- must_follow (high): Before running npm run deploy, run npm run db:generate because Prisma client must be generated first.
```

This excerpt illustrates the output of `audrey demo --scenario repeated-failure`.

When Guard does speak, it names the memory it is speaking from, and a remembered failure is matched to the proposed command by what it runs (`npm run deploy` against `npm run deploy`), not by how similar two strings look to an embedding.

Commands with execution-capable options or lifecycle scripts are guarded, including `git ls-remote --upload-pack=...`, `npm pack --dry-run`, and `ss -K`. The classifier is a convenience for ordinary inspection commands, not an operating-system sandbox. Repository configuration, shell expansion, and programs invoked by a reader can change what a command does. Use host permissions or a sandbox when enforcement is required.

## What Audrey remembers

Audrey treats memory as more than a pile of text chunks.

- Episodes are things that happened: a user decision, a tool result, a project fact, a preference.
- Semantic memories are principles supported by accumulated evidence.
- Procedural memories are ways of acting: how to retry, verify, avoid, or recover.
- Contradictions stay visible instead of being silently overwritten.
- Confidence changes with source quality, evidence, age, retrieval, interference, context, and feedback.
- Low-value memories decay; repeated evidence can consolidate into longer-lived knowledge.

Every context packet includes memory IDs, confidence, provenance where available, and a reason for inclusion. Uncertain or disputed memories are labeled as such. Retrieved content is wrapped with a simple rule: memory is evidence, not authority; current system and user instructions always win.

## Checking memories against the repository

Age is not the only way a memory goes wrong. A note saying "ship with `npm run deploy:prod`" is perfectly recent, well sourced, and completely wrong the day that script is deleted. Worse, every recall reinforces it, because retrieval counts as evidence that a memory is useful. A confidently stated, well-supported, false instruction is more damaging than no memory at all.

Audrey checks a narrow, useful part of this problem: whether referenced repository paths and package script names still exist. When a memory is written with project context, it records only anchors that resolve at that moment. A missing anchor can then distinguish a later repository change from a reference that never resolved.

Existence does not establish correctness. A script can keep its name while changing behavior, and an intact file can contain obsolete instructions. Grounding does not execute scripts, prove a fix, or verify arbitrary claims in prose.

```bash
audrey ground
```

```text
[audrey] Grounding memories against /home/you/project
[audrey] Checked 14: 12 still true, 2 broken, 0 repaired.
[audrey]   01K8ZQ... references a missing npm_script: deploy:prod
[audrey]   01K8ZR... references a missing path: scripts/release.mjs
```

Broken memories are not deleted. They keep their content, say plainly what they still refer to, and take a confidence penalty so they stop leading by default while remaining readable and repairable. They also stop being eligible for the packet's must-follow section — that is the section that can force a Guard block, and a rule naming a file that no longer exists is a rule nobody can follow.

Repair is symmetric. Restore the file or the script and the next check clears the flag. A checkout that has moved reports unknown rather than broken, because a memory should not be discredited for describing a project this machine cannot currently see.

Memories with no checkable claims are left unlabeled. Silence is not a clean bill of health, and presenting it as one would be the same mistake pointed the other way.

## Daily use

Most of this runs on its own once Autopilot is installed. You do not invoke recall, and you do not invoke Guard. The table is here for the parts you would reach for deliberately, and so the automatic parts are legible rather than magic.

| What | When you want it | Why it helps | How |
|---|---|---|---|
| **Autopilot** | Always, after one install | The whole point. Memory arrives before the agent acts instead of after you notice it went wrong. | `audrey install --host auto`, restart the host, approve hooks once |
| **Guard** | Automatic, before supported edit, write, or shell tool calls | Checks action fingerprints against recorded failures and surfaces memory warnings. Recognised read-only commands skip the check. Repairing the repository alone does not clear a prior failure. | Runs at `PreToolUse`. Manually: `audrey guard --tool Bash --strict` |
| **Grounding** | After deleting or renaming things a memory might mention | Flags previously observed paths or package script names that no longer exist. | `audrey ground`, or let the maintenance sweep do it |
| **Session briefing** | Automatic at session start | Small, scoped packet instead of pasting context every time. Unchanged memories inject once per session; changes to content or standing are sent again. | `SessionStart` hook. Preview with `audrey greeting` |
| **Explicit capture** | When you say "remember that…" or "I prefer…" | Deliberate memories are worth more than inferred ones, and phrasing it that way is enough. | Just type it. Autopilot picks up those sentence shapes |
| **Consolidation** | Automatic when idle; manually before a long break | Repeated episodes become one principle. Otherwise the store is a pile of near-duplicates and recall gets noisy. | `audrey dream` |
| **Contradictions** | When two memories disagree | Neither one silently wins. Both stay visible and labeled until something resolves them. | Surfaced in packets; `memory_resolve_truth` to settle one |
| **Decay** | Confidence ages during recall; run maintenance to mark dormant memories | Age lowers confidence. Explicit decay can move weak memories out of active retrieval. Autopilot consolidation does not run this dormancy pass. | `audrey dream` or `memory_decay` |
| **Promote** | When a pattern deserves to be a repo rule | Moves a learned habit out of memory and into a file your team can read and review. | `audrey promote --dry-run` first |
| **Impact** | When reviewing memory feedback | Reports explicit used/helpful/wrong feedback and frequently validated memories. It does not measure time saved or independently establish that a blocked action would have failed. | `audrey impact --window 30` |
| **Snapshot** | Backups, or moving to a new machine | Full store in one JSON file. Import treats it as untrusted: redacted and stripped of trust markers on the way in. | `AUDREY_ENABLE_ADMIN_TOOLS=1`, then `memory_export` / `memory_import` |
| **Doctor** | Packets stopped arriving | The two real causes are a drifted hook entrypoint and starved consolidation. Doctor names which one. | `audrey doctor` |
| **Demo** | Before configuring a host | Exercises a simulated failure and blocked retry in temporary SQLite storage, with no API key or network call. | `audrey demo --scenario repeated-failure` |
| **REST sidecar** | Custom agents that are not Codex or Claude Code | Same memory runtime, same evidence contract, over HTTP. Python and JS clients included. | `audrey serve` with `AUDREY_API_KEY` set |

## What Audrey deliberately does not do

Audrey does not upload your memory to a hosted service by default. It does not treat every sentence as permanent truth. It does not promote instructions from arbitrary tool output into trusted policy. It does not claim that a small local benchmark proves state-of-the-art memory quality.

Raw prompt events and tool bodies are not retained by default. Audrey stores hashes, bounded summaries, fingerprints, and redaction metadata. Explicit user-memory language is persisted intentionally; tool failure memories are sanitized first. Admin export/import/forget/promote surfaces are disabled unless `AUDREY_ENABLE_ADMIN_TOOLS=1`.

At-rest encryption, identity-bound tenant authorization, rate limiting, and regulated retention remain deployment responsibilities today. They are not hidden behind a “production ready” badge.

## Why a team might actually want this

### Fewer repeated mistakes

Guard checks memory at the point where it can change an action, not after the damage is done. Exact failure fingerprints avoid the noisy “one Bash command failed, so all Bash commands are suspicious” behavior.

### Continuity across agent sessions

Codex and Claude Code use the same memory runtime and evidence contract. Generated configurations use separate `codex` and `claude-code` agent identities, so they do not automatically recall each other's memories. Cross-agent Autopilot recall requires the explicit `AUDREY_AUTOPILOT_SCOPE=shared` setting in the host runtime environment; this broadens recall across the store. MCP, REST, JavaScript, and Python clients make the core usable in custom agents too.

### Evidence a human can inspect

Allow, warn, and block decisions carry receipts and evidence IDs. Outcome records connect back to those receipts. Teams can ask not only “what did the agent remember?” but “which memory changed this action, and was that useful?”

### Local control

The default store is SQLite, FTS5, and `sqlite-vec`. Local embeddings are the default. Cloud embedding or LLM providers require explicit configuration.

### A safer shared store

Agent-scoped recall continues through validation, contradiction detection, interference, affect, failure lookup, capsules, greetings, Guard, and REST request routing. Recall updates retrieval count and last-reinforced timestamp for returned semantic and procedural memories. Capsule and Guard filtering may further narrow those results. Explicit validation feedback (`memory_validate` / `/v1/validate`) separately updates usage and salience from a caller's used/helpful/wrong assessment.

Vector candidates are partitioned by agent before nearest-neighbor ranking, so one busy agent cannot crowd another out of a bounded search. For hard tenant boundaries, still use a distinct `AUDREY_DATA_DIR` per tenant or security domain.

<div align="center">
  <img src="docs/assets/audrey-feature-grid.jpg" alt="Audrey memory continuity, recall, evidence, local storage, and memory-before-action" width="760">
</div>

---

## Technical reference

Everything below is the machinery. The short version above is the product.

### Requirements and packages

- Node.js 22.16+ (22.x) or 24+; Node 20 and 23 are no longer supported
- npm package: `audrey`
- Python client: `audrey-memory`
- Default storage: local SQLite + FTS5 + `sqlite-vec`
- Default embeddings: local 384-dimensional model

```bash
npm install audrey
pip install audrey-memory
```

Audrey uses `node:sqlite`; `sqlite-vec` ships its extension in platform packages. The local embedding runtime also includes its CPU binaries, so `npm install --ignore-scripts audrey` works. Keep optional dependencies enabled: they contain the platform files for `sqlite-vec` and `sharp`. GPU acceleration may require additional ONNX Runtime libraries for your platform. Some supported Node releases print an experimental SQLite warning at startup; it does not prevent operation.

For Autopilot, prefer a global or otherwise stable installation. Hook and MCP configuration pins the actual Node executable and Audrey entrypoint; an ephemeral `npx` cache is not a durable production runtime.

### Host configuration

Preview or apply lifecycle hooks independently:

```bash
audrey hook-config claude-code
audrey hook-config claude-code --apply --scope local
audrey hook-config claude-code --apply --scope project
audrey hook-config claude-code --apply --scope user

audrey hook-config codex
audrey hook-config codex --apply --scope project
audrey hook-config codex --apply --scope user
```

Claude Code scope mapping follows the host’s terminology:

- `local` → `.claude/settings.local.json`
- `project` → `.claude/settings.json`
- `user` → `~/.claude/settings.json`

Codex supports project `.codex/hooks.json` and user `~/.codex/hooks.json`; it has no local hook scope. Audrey preserves unrelated hooks, replaces older Audrey-owned handlers, writes a private timestamped backup, and is idempotent on repeat installation. Project-adjacent backup names match `*.audrey-*.bak`; keep that pattern ignored because a host config can contain unrelated credentials.

Audrey respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Generated hooks pin the stable Node executable, Audrey entrypoint, data directory, agent identity, and non-secret provider choices used at install time. With local embeddings, an Autopilot install warms the model cache; set `AUDREY_DISABLE_WARMUP=1` to skip it. Each hook still runs in a new process and initializes an embedding pipeline when needed, so cached model files do not eliminate startup latency.

Generate MCP configuration without applying it:

```bash
audrey mcp-config codex
audrey mcp-config generic
audrey mcp-config vscode
```

Remove Audrey-owned MCP registrations and hooks with the same host and scope you installed:

```bash
audrey uninstall --host auto --scope user
audrey uninstall --host claude-code --scope local
audrey uninstall --host codex --scope project
```

Add `--dry-run` to preview uninstall without changing either host. Add `--mcp-only` only when you intentionally want to preserve Audrey hooks.

### Autopilot safety contract

The shared hook adapter normalizes current Codex and Claude Code payloads.

- Context injection is bounded by `AUDREY_CONTEXT_BUDGET_CHARS` (default 4000; Autopilot uses a conservative 3200-character packet unless overridden).
- Prompt and tool retrieval queries are bounded before embedding. Large edits carry hashes and lengths instead of file bodies; exact Guard identity uses a full redacted digest rather than a truncated prefix.
- The generated default hooks guard and observe `Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `apply_patch`, and every `mcp__*` tool from connected MCP servers, excluding Audrey's own memory tools so the Guard never guards itself.
- A Bash command is only guarded when it can have side effects. A command whose every part is positively recognised as read-only (`grep`, `ls`, `sed -n`, `git status`, `npm ls`, and similar; no command substitution, no redirect except to `/dev/null`, no `sudo`, `xargs`, or `eval`) skips the preflight, and a non-zero exit from it is recorded but never treated as a failure to avoid. Anything the classifier does not recognise is guarded.
- A remembered Bash failure is matched to a proposed command by the verbs it runs (`npm run deploy`, `git push`), not by how similar the two command strings read.
- Pre/post correlation uses `session_id + tool_use_id`, so parallel tool calls do not attach to the wrong receipt.
- Claude `PostToolUseFailure` and Codex responses that explicitly expose a non-zero exit normalize to the same failure path. Current Codex hooks can omit Bash exit status; Audrey records an opaque result as `unknown`, never as invented success.
- On an internal error, every hook logs to stderr and emits `{}` (no opinion, so the tool proceeds). Only `PreToolUse` changes behavior under `AUDREY_HOOK_FAIL_CLOSED=1`, emitting a deny decision instead; context-injection and post-tool hooks have no deny path and always emit `{}`.
- Stop hooks always emit valid JSON and never continue or block a completed turn.

Codex hook interception is a guardrail, not a complete shell-policy boundary. The current host contract does not intercept every richer `unified_exec` path and may omit the exit status of silent Bash failures. See the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks). Use the Guard receipt as evidence, and keep sandboxing, approvals, CI, and deployment controls in place.

### JavaScript API

```js
import { Audrey } from 'audrey';

const memory = new Audrey({
  dataDir: './audrey-data',
  agent: 'payments-agent',
  embedding: { provider: 'local', dimensions: 384 },
});

await memory.encode({
  content: 'Stripe returns HTTP 429 above 100 requests per second.',
  source: 'direct-observation',
  tags: ['stripe', 'rate-limit'],
  context: { service: 'billing' },
});

const capsule = await memory.capsule('increase Stripe throughput', {
  scope: 'agent',
  budgetChars: 3000,
});

const before = await memory.beforeAction('npm run deploy:billing', {
  tool: 'Bash',
  cwd: process.cwd(),
  strict: true,
});

console.log(before.decision, before.evidence_ids, before.receipt_id);
// Only execute an authorized action when before.ok_to_proceed is true.
// After execution, close this receipt with memory.afterAction({
//   receiptId: before.receipt_id, outcome: 'succeeded' | 'failed' | 'unknown',
//   errorSummary: '...' // when available
// });
// Report the observed outcome; creating a receipt does not execute the action.
await memory.closeAsync();
```

### REST sidecar

```bash
AUDREY_AGENT=payments-agent audrey serve
curl http://127.0.0.1:7437/health
```

Core routes:

| Need | Route |
|---|---|
| Encode an episode | `POST /v1/encode` |
| Recall memory | `POST /v1/recall` |
| Build a context packet | `POST /v1/capsule` |
| Check before an action | `POST /v1/preflight` |
| Create a Guard receipt | `POST /v1/guard/before` |
| Close a Guard receipt | `POST /v1/guard/after` |
| Consolidate and decay | `POST /v1/dream` |
| Health and index state | `GET /v1/status` |
| Promote learned procedures to rule files (admin) | `POST /v1/promote` |

Use `AUDREY_API_KEY` for any non-loopback deployment. `X-Audrey-Agent` scopes encode, recall, capsules, preflight, Guard, consolidation, and greetings inside a trusted deployment; it is a routing header, not an authentication boundary. Bind agent/tenant identity at your gateway rather than trusting an arbitrary public header. Every route also accepts a per-call `agent` field in the JSON body as a fallback for callers (such as the Python client) that cannot set a header per request; the header wins whenever both are present.

### Python client

```python
from audrey_memory import Audrey

memory = Audrey(base_url="http://127.0.0.1:7437", agent="payments-agent")
memory_id = memory.encode(
    "Stripe returns HTTP 429 above 100 requests per second.",
    source="direct-observation",
)
results = memory.recall("Stripe rate limit", limit=5)
memory.close()
```

The Python package is a client for the REST sidecar; the memory runtime remains in the Node process.

### Memory and retrieval pipeline

```text
episode
  ├─ transactional SQLite + vector + FTS write
  ├─ agent-scoped interference / resonance / validation
  ├─ reinforcement or contradiction evidence
  ├─ sleep-time consolidation into semantic or procedural memory
  └─ grounding rechecks recorded paths and package-script names

query
  ├─ bounded vector candidates
  ├─ FTS5 lexical candidates
  ├─ reciprocal-rank fusion and confidence scoring
  ├─ context / affect / recency / interference modifiers
  └─ final-only retrieval bookkeeping
```

Agent-scoped vector search uses a native `sqlite-vec` partition key before nearest-neighbor ranking, not post-filtered whole-store candidates. If fusion underfills, Audrey makes one bounded partition-local retry. Semantic and procedural retrieval counts update only as final results are yielded; deduplicated, over-limit, and unconsumed stream candidates receive no authority boost.

### MCP surface

Audrey exposes 23 MCP tools plus status, recent-memory, and principle resources and briefing/recall/reflection prompts. The main groups are:

- capture: `memory_encode`, `memory_reflect`, `memory_observe_tool`
- retrieval: `memory_recall`, `memory_capsule`, `memory_greeting`
- action safety: `memory_preflight`, `memory_guard_before`, `memory_guard_after`, `memory_reflexes`
- lifecycle: `memory_consolidate`, `memory_dream`, `memory_decay`, `memory_resolve_truth`, `memory_ground`
- governance: `memory_validate`, `memory_promote`, `memory_forget`, `memory_export`, `memory_import`, `memory_status`, `memory_introspect`

The server also sends host instructions explaining the Guard receipt loop when lifecycle hooks are unavailable.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUDREY_MODEL_CACHE_DIR` | `$XDG_CACHE_HOME/audrey/models` or `~/.cache/audrey/models` | Writable per-user cache for local model files |
| `AUDREY_SHARED_STORE` | `0` | Set `1` to retain operator-managed permissions for an intentionally shared store |
| `AUDREY_DATA_DIR` | `~/.audrey/data` | SQLite store; use a distinct directory per tenant/security boundary |
| `AUDREY_AGENT` | host-specific | Logical memory owner used for scoped operations |
| `AUDREY_EMBEDDING_PROVIDER` | `local` | `local`, `gemini`, `openai`, or `mock` |
| `AUDREY_LLM_PROVIDER` | unset | `anthropic`, `openai` (API billing), `chatgpt` (subscription), or `mock` for reflection/consolidation; unset (or `auto`) uses local heuristics only, never an ambient API key |
| `AUDREY_LLM_MODEL` | provider default | Explicit LLM model override |
| `AUDREY_LLM_REASONING_EFFORT` | `medium` | OpenAI reasoning effort: `low`, `medium`, `high`, `xhigh`, or `max` |
| `AUDREY_CHATGPT_AUTH_DIR` | `~/.audrey/auth` | Protected local subscription credential directory |
| `AUDREY_CHATGPT_ACCOUNT` | active account | Saved subscription registration to use |
| `AUDREY_DEVICE` | `gpu` | Local embedding device; falls back to CPU |
| `AUDREY_CONTEXT_BUDGET_CHARS` | `4000` | Maximum default capsule size |
| `AUDREY_AUTOPILOT_SCOPE` | `agent` | `agent` or explicit cross-agent `shared` recall for hooks |
| `AUDREY_PACKET_FORMAT` | `compact` | Injected packet style: `compact` line format or `verbose` key=value |
| `AUDREY_PACKET_DELTA` | `1` | Inject each unchanged memory version once per session; `0` resends full packets every prompt |
| `AUDREY_HOOK_FAIL_CLOSED` | `0` | Deny guarded actions when Audrey itself fails |
| `AUDREY_API_KEY` | unset | Bearer token for REST access |
| `AUDREY_ALLOW_NO_AUTH` | `0` | Set `1` to permit unauthenticated non-loopback REST access |
| `AUDREY_HOST` | `127.0.0.1` | REST bind address |
| `AUDREY_PORT` | `7437` | REST port |
| `AUDREY_ENABLE_ADMIN_TOOLS` | `0` | Enable export, import, forget, and promote operations |
| `AUDREY_ENABLE_SHARED_SCOPE` | `0` | Allow explicit cross-agent REST recall; admin tools also enable it |
| `AUDREY_PROFILE` | `0` | Include stage timing diagnostics |
| `AUDREY_DISABLE_WARMUP` | `0` | Disable MCP embedding warmup |
| `AUDREY_PRAGMA_DEFAULTS` | `1` | Set `0` to disable SQLite performance tuning |

Provider secrets are never embedded in generated hook commands. `--include-secrets` applies only to MCP registration; prefer host environment injection or a secret manager.

OpenAI API billing uses `AUDREY_LLM_PROVIDER=openai` and `OPENAI_API_KEY`. To use a ChatGPT subscription for reflection and consolidation, run `audrey auth login`, then set `AUDREY_LLM_PROVIDER=chatgpt`, `AUDREY_LLM_MODEL=gpt-6.1-sol`, and `AUDREY_LLM_REASONING_EFFORT=medium`. Reinstall the host configuration after changing provider settings. Subscription requests require account permission and an available model; failures never switch to API billing. Embeddings remain a separate provider and default to local execution. See [OpenAI's subscription documentation](https://developers.openai.com/siwc/token-sharing-open-source).

Use `audrey auth accounts` to list saved registrations, `audrey auth select --account <ID>` to switch, and `audrey auth logout` to sign out. Tokens stay in protected local storage outside the memory database. `audrey auth status` reports connection state without exposing tokens.

New local stores use private directory and database permissions on filesystems that support POSIX modes. Existing database and WAL files are restricted on open. Windows and mounted volumes need appropriate operating-system ACLs. Set `AUDREY_SHARED_STORE=1` (SDK: `sharedStore: true`) only when you manage shared access yourself.

Local models download into the per-user cache on first use. Allow that first run to finish before relying on hooks offline. A failed initialization can be retried in the same process. For a system package installed by root, run the initial model load as the desktop user so the cache remains writable.

Snapshot format 2 preserves grounding anchors, their last known state, and consolidation undo journals; older snapshots remain importable. Worktrees share a repository identity for recall, while grounding checks the checkout where an anchor was recorded. Rollback preserves earlier knowledge when undoing a merge. Legacy merges without an undo journal are refused when they cannot be reversed safely.

The REST API requires JSON request bodies and rejects cross-origin browser requests. Unauthenticated requests require a loopback host unless `AUDREY_ALLOW_NO_AUTH=1` is explicitly set. Configure `AUDREY_API_KEY` for network deployments.

### Production checklist

- Give every tenant or hard isolation domain its own `AUDREY_DATA_DIR`.
- Pin embedding and LLM providers explicitly.
- Back up the store before provider, dimension, or version migrations.
- Put the REST sidecar behind authentication and rate limits; do not expose an agent-selection header as identity.
- Leave REST shared scope disabled unless cross-agent retrieval is intentional and authorized by your own identity layer.
- Keep credentials and regulated raw content out of encoded memories.
- Decide retention, deletion, encryption, and audit policy before regulated use.
- Monitor `audrey status --json --fail-on-unhealthy`.
- Keep the hook runtime on a stable installed path.
- Load-test concurrent writers for your topology; SQLite WAL is not a distributed coordination layer.

Local embeddings use Transformers.js 4.3+ with `sharp` 0.35.4+, resolving the earlier libvips/libheif advisories in the published dependency tree. A hosted embedding provider changes runtime execution but does not remove installed packages. Run `npm audit --omit=dev` against your installation to check current advisories.

### Benchmarks and evidence

Run the release gates locally:

```bash
npm test
npm run bench:memory:check
npm run bench:guard:check
npm run bench:guard:publication:verify
npm run smoke:cli
npm run pack:check
```

GuardBench currently contains ten local, deterministic pre-action scenarios covering repeated failures, procedures, scope changes, recovery, redaction, conflicting instructions, and noisy stores. The checked-in v1 methodology uses a mock 64-dimensional embedding provider and exists to catch regressions. A perfect local pass is not a claim about real-provider latency or production false-positive rates.

<!-- guardbench-summary:start -->
Latest local result in this checkout: 10/10 scenarios passed, 100% prevention rate, 0% false-block rate, 0 raw secret leaks, 0 published artifact leaks, and 3.805ms / 13.445ms p50/p95 Guard latency under the mock-provider methodology.
<!-- guardbench-summary:end -->

`benchmarks/perf-snapshot.js` measures encode and hybrid-recall p50/p95/p99 at configurable corpus sizes with machine provenance. It currently uses mock 64-dimensional embeddings; it has no provider-selection flag and does not measure hook process startup. Measure complete hook invocations separately with your intended provider, cache state, corpus, and hardware before using these numbers to estimate interactive latency.

The longer-term public evaluation target includes [LongMemEval](https://arxiv.org/abs/2410.10813), [MemoryAgentBench](https://arxiv.org/abs/2507.05257), and adversarial memory-poisoning cases. Relevant design directions include bitemporal knowledge graphs in [Zep/Graphiti](https://arxiv.org/abs/2501.13956), evolving memory organization in [A-MEM](https://arxiv.org/abs/2502.12110), and sleep-time agent compute in [Sleep-time Compute](https://arxiv.org/abs/2504.13171).

### Development

```bash
git clone https://github.com/Evilander/Audrey.git
cd Audrey
npm ci
npm run build
npm run lint
npm run format:check
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [docs/MEMORY_BENCHMARKING.md](docs/MEMORY_BENCHMARKING.md).

### Maintainer release gates

These commands are intentionally documented because the paper and release evidence ledger verifies them against the public source tree:

```bash
npm run bench:guard:zep
npm run bench:guard:external:dry-run
npm run bench:guard:external:evidence
npm run bench:guard:external:evidence:strict

npm run paper:arxiv:compile
npm run paper:arxiv:compile:strict

npm run release:cut:plan
npm run release:cut:apply
npm run release:readiness
npm run release:readiness:strict
npm run python:release:check
```

Live Zep runs require `ZEP_API_KEY`; `ZEP_GUARDBENCH_INGEST_DELAY_MS` tunes ingestion settling time. The external dry-run matrix proves adapter shape without credentials, while external evidence verification distinguishes pending runs from verified live evidence.

Publication packaging verifies artifact hashes, source bundles, and path redaction. Release readiness separately reports source-control state, live remote-head verification, npm registry/auth readiness, and PyPI publish readiness. Pass `-- --target-version <version>` to the readiness commands when checking a release; the script's legacy default is `1.1.1`.

MIT licensed. Built for agents that should get better at the work without becoming less accountable.
