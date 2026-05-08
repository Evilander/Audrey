# Appendix A. Repeated-Failure Demo Transcript

This appendix records the qualitative demo used in Section 7. The demo creates an isolated temporary Audrey store, records one failed deploy command, stores the operational rule implied by the failure, and runs a pre-action guard check on the same command. It is the paper's artifact-grounded figure because it shows the central claim in one executable trace: memory changes the next tool action before the tool runs.

## Commands

Build command:

```bash
npm run build
```

Run command:

```bash
node dist/mcp-server/index.js demo --scenario repeated-failure
```

## Verbatim Transcript

```text
Audrey Guard repeated-failure demo

Memory store: [LOCAL-TEMP]/audrey-demo-AkCROa
Step 1: the agent tries a deploy and hits a real setup failure.
Step 2: Audrey stores the failure and the operational rule it implies.
Lesson memory: 01KR491DG2YZHVEM79QVW5BHZA

Step 3: a new preflight checks the same action before tool use.

Audrey Guard: BLOCKED

Reason: Blocked: this exact Bash action failed before. Stop: 3 memory reflexes, 2 blocking, 1 warning matched.
Risk score: 0.90

Evidence:
- 01KR491DFZYZ20TFK71KJHC88F
- 01KR491DG2YZHVEM79QVW5BHZA
- failure:Bash:2026-05-08T17:09:22.047Z

Recommended action:
- Do not repeat the exact failed action until the prior error is understood or the command is changed.
- Do not proceed until the high-severity memory warning is addressed.
- Apply this must-follow rule before acting.
- Mitigate this remembered risk before proceeding.
- Before re-running Bash, check what changed since the last failure.

Memory reflexes:
- block: Apply this must-follow rule before acting. Before running npm run deploy, run npm run db:generate because Prisma client must be generated first.
- block: Mitigate this remembered risk before proceeding. Before running npm run deploy, run npm run db:generate because Prisma client must be generated first.
- warn: Before re-running Bash, check what changed since the last failure.

Next: fix the warning and retry, or pass --override to allow this guard check.

Impact:
- 1 repeated failure prevented
- 1 helpful memory validation recorded
- 3 evidence ids attached

Audrey saw the agent fail once.
Audrey stopped it from failing twice.
```

## Line Annotations

| Transcript Fragment | Demonstrates |
|---|---|
| `Audrey Guard repeated-failure demo` | The named scenario is the Guard demo, not a generic recall query. |
| `Memory store: ...\audrey-demo-...` | The demo uses an isolated temporary memory store; IDs and temp path are run-specific. |
| `Step 1: the agent tries a deploy...` | The first action is allowed to fail once, creating real operational evidence. |
| `Step 2: Audrey stores the failure...` | The failed tool outcome is converted into memory state. |
| `Lesson memory: ...` | The procedural lesson receives a concrete memory ID that can be cited later. |
| `Step 3: a new preflight...` | The next decision occurs before tool use, which is the pre-action control boundary. |
| `Audrey Guard: BLOCKED` | The controller returns an enforced block decision rather than retrieved context. |
| `Reason: Blocked: this exact Bash action failed before...` | The decision combines exact repeated-failure matching with reflex summary counts. |
| `Risk score: 0.90` | The guard exposes a numeric risk score in the decision object. |
| `Evidence:` and the three evidence rows | The block is auditable: prior event, lesson memory, and failure-class evidence are attached. |
| `Recommended action:` rows | The guard returns concrete next actions rather than only a warning sentence. |
| `Memory reflexes:` rows | Preflight warnings are converted into block and warn reflexes with operational wording. |
| `Next: fix the warning...` | The CLI output preserves an explicit override path while defaulting to prevention. |
| `Impact:` rows | The loop records prevention, validation, and attached-evidence accounting. |
| `Audrey saw the agent fail once.` | The system observes failure instead of pretending it can prevent first-time unknown errors. |
| `Audrey stopped it from failing twice.` | The central behavior: memory changes the next tool action. |

## How to Reproduce

Prerequisites:

- Node.js 20 or newer.
- Audrey dependencies installed with `npm install`.
- A clean or dirty checkout is acceptable; the demo uses a temporary mock-provider store and does not write to the user's normal Audrey data directory.

Commands:

```bash
npm run build
node dist/mcp-server/index.js demo --scenario repeated-failure
```

Expected output shape:

- The command prints `Audrey Guard repeated-failure demo`.
- It reports a temporary `Memory store` path.
- It prints a run-specific `Lesson memory` ID.
- It prints `Audrey Guard: BLOCKED`.
- It prints `Risk score: 0.90`.
- It lists at least one prior failure evidence ID, one lesson memory ID, and one `failure:Bash:<timestamp>` evidence ID.
- It reports two blocking reflexes, one warning reflex, one repeated failure prevented, one helpful memory validation recorded, and three evidence IDs attached.

Run-specific values:

- The temp directory suffix changes on each run.
- Memory IDs change on each run.
- The timestamp inside the `failure:Bash:<timestamp>` evidence ID changes on each run.
