# Audrey Guard Controller Design

Date: 2026-05-05
Status: draft for user review
Target release: v0.23

## Purpose

Audrey already has recall, capsules, preflight, reflexes, tool traces, validation, and impact reporting. The missing product shape is a single loop that an agent can call before and after actions.

This design makes Audrey Guard the headline v0.23 feature:

- Before action: classify the action, recall relevant memory, decide go, caution, or block, and return evidence-backed guidance.
- After action: record what happened, link it back to the guard decision, and reinforce or challenge the memories that influenced the action.
- Over time: produce auditable proof that Audrey prevented repeated mistakes, improved outcomes, and learned from wrong guidance.

The commercial wedge is not "another local vector database." It is "memory before action for AI agents that need to stop repeating expensive mistakes."

## Audrey Self-Use Evidence

During analysis, Audrey was run against `.audrey-working-memory` with mock embeddings. It stored the user's commercial ambition as must-follow memory and blocked a loose "improve Audrey" action in strict preflight mode until the work was framed as an ambitious product loop. That behavior is exactly the product promise v0.23 should make usable by agent hosts.

## Approaches Considered

### Approach A: Guard CLI only

Add `audrey guard --tool <Tool> "<action>"` as a thin wrapper around `preflight()` and `reflexes()`.

Pros:
- Fastest demo.
- Low risk.
- Minimal API churn.

Cons:
- Does not give SDK, REST, or MCP callers one durable abstraction.
- Does not close the loop after the action.
- Risks becoming another disconnected primitive.

### Approach B: Memory Controller core plus guard surfaces

Add `src/controller.ts` with `beforeAction()` and `afterAction()`. Then expose it through the JS SDK, REST, MCP, and CLI.

Pros:
- Creates one product loop over existing Audrey primitives.
- Keeps the headline demo simple while giving serious integrators a stable API.
- Lets future work add action classification, replay scheduling, policy, and team audit without rewriting host surfaces.

Cons:
- More design work than a CLI wrapper.
- Requires careful compatibility with existing preflight and tool-trace behavior.

### Approach C: Policy engine and enforcement runtime

Build a richer rules engine with custom policies, hard blocks, signed receipts, and host adapters first.

Pros:
- Strong enterprise story.
- Clear path to paid team controls.

Cons:
- Too large for the next release.
- High chance of burying the simple memory-before-action demo under configuration.

## Recommendation

Use Approach B.

The first release should add a small controller core and guard surfaces without a new policy language or schema migration. It should feel like Audrey gained a spine, not like it gained a new subsystem.

## Product Promise

Audrey Guard answers four questions before an agent acts:

1. What does Audrey remember that matters here?
2. Should the agent proceed, slow down, or stop?
3. What exact evidence caused that decision?
4. How will Audrey learn whether the decision helped?

The output must be useful to both machines and humans. Machine callers need stable fields. Humans need a compact explanation and a receipt id they can audit later.

## Architecture

Add a new controller module:

```ts
// src/controller.ts
beforeAction(action, options) -> GuardDecision
afterAction(receiptOrInput, outcome) -> GuardOutcome
```

The controller composes existing primitives:

- `preflight()` provides the evidence packet, warnings, risk score, and go/caution/block decision.
- Reflex generation provides trigger-response guidance from the same preflight result.
- `observeTool()` records pre-action and post-action events.
- `validate()` reinforces or challenges evidence memories.
- `impact()` later shows whether the loop is doing useful work.

The controller should be imported by `src/audrey.ts`, not buried in the CLI. All external surfaces call the same implementation.

Implementation should avoid two independent recall/preflight passes for one guard check. Either extract an internal `reflexesFromPreflight()` helper from `src/reflexes.ts`, or add an option that lets the controller pass an already-built preflight result into reflex generation.

## Core Types

`GuardDecision` should include:

- `receipt_id`: the `memory_events` id for the recorded guard check.
- `action`, `tool`, `cwd`, `generated_at`.
- `decision`: `go`, `caution`, or `block`.
- `ok_to_proceed`: false only for block.
- `risk_score`.
- `summary`.
- `warnings`.
- `reflexes`.
- `recommended_actions`.
- `evidence_ids`.
- `capsule` when requested.
- `status` when requested.

`GuardOutcome` should include:

- `receipt_id`.
- `post_event_id`.
- `outcome`: `succeeded`, `failed`, `blocked`, `skipped`, or `unknown`.
- `validated_evidence`: ids that were marked `used`, `helpful`, or `wrong`.
- `learning_summary`: a compact statement of what Audrey learned or why it abstained.

## Data Flow

### Before Action

1. Caller sends action text plus optional tool, cwd, session id, files, strict mode, and capsule budget.
2. Controller calls `preflight()` with `recordEvent: true`.
3. Controller derives reflexes from that same preflight result, avoiding duplicate recall and duplicate event creation.
4. Controller returns one `GuardDecision`.
5. If `decision=block`, CLI exits non-zero and REST/MCP/SDK set `ok_to_proceed=false`.

### After Action

1. Caller sends the receipt id, outcome, optional error summary, output summary, and evidence feedback.
2. Controller records a redacted post-action tool trace.
3. If the action was blocked, it records `outcome=blocked` without pretending a tool ran.
4. If evidence feedback is supplied, controller calls `validate()` for each memory id.
5. Controller returns `GuardOutcome`.

## External Surfaces

### JavaScript SDK

Add:

```ts
await audrey.beforeAction('run npm test before release', { tool: 'npm test', strict: true });
await audrey.afterAction({ receiptId, outcome: 'failed', errorSummary });
```

### REST

Add:

- `POST /v1/guard/before`
- `POST /v1/guard/after`

Keep `/v1/preflight` and `/v1/reflexes` unchanged for compatibility.

### MCP

Add:

- `memory_guard_before`
- `memory_guard_after`

The current `memory_preflight` and `memory_reflexes` remain available.

### CLI

Add:

```bash
npx audrey guard --tool "npm test" --strict "run npm test before release"
npx audrey guard-after --receipt <id> --outcome failed --error-summary "..."
```

The first command is the headline demo. It should print a compact human report and support `--json`.

## Error Handling

- Empty action returns a validation error.
- Unknown receipt id in `afterAction()` returns a controlled not-found error.
- Memory health problems appear as high or medium warnings, consistent with `preflight()`.
- If recall or FTS is degraded, the guard result must say so rather than imply full coverage.
- Redaction remains centralized in `observeTool()`. Controller code must not store raw tool payloads directly.
- Strict mode blocks only high-severity warnings, matching existing preflight semantics.

## Compatibility

This release should not remove or rename existing tools, routes, or SDK methods. It should only add a controller layer and guard surfaces.

The controller should use existing `memory_events` rows as receipts so v0.23 can ship without a schema migration. A future paid/team version can add signed receipts and richer audit tables.

## Testing

Add focused tests before implementation:

- Controller returns `go` when no warnings exist.
- Controller returns `block` in strict mode for relevant must-follow memory.
- Controller returns `caution` for a repeated failed tool action.
- `beforeAction()` records exactly one guard/preflight event.
- `afterAction()` records a post-action event linked to the receipt.
- Evidence feedback calls validation and changes impact metrics.
- REST guard routes sanitize options like current recall routes.
- MCP schemas accept valid guard calls and reject malformed inputs.
- CLI `guard --json` returns machine-readable `decision`, `receipt_id`, and `evidence_ids`.

## Out Of Scope For v0.23

- A full custom policy language.
- Hosted sync.
- Multi-tenant team authorization.
- New database schema for signed receipts.
- Automatic host hook installation.
- Replacing existing preflight or reflex APIs.

## Success Criteria

The v0.23 demo should make this claim defensible:

> Audrey remembered before acting, stopped or warned on known risks, recorded a receipt, and learned whether the guidance helped.

Release gates:

- `npm run typecheck`
- Focused Vitest coverage for controller, REST, MCP schemas, and CLI parsing.
- Existing preflight, reflexes, capsule, and http API tests still pass.
- `npx audrey guard --json --tool "npm test" --strict "run npm test before release"` works against a mock-memory demo store.

## Review Question

If this spec is approved, the implementation plan should start with controller tests, then the core controller, then SDK, REST, MCP, CLI, docs, and final release-gate verification.
