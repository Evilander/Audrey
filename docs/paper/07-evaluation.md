# 7. Evaluation

This Stage-A evaluation reports implemented Audrey artifacts and local GuardBench adapters only. Section 5 specifies GuardBench as a reproducibility contract for pre-action memory control. The empirical claims below come from the repository's existing performance snapshot, the current behavioral regression output, the local comparative GuardBench runner, source-linked implementation inspection, and a freshly captured repeated-failure demo transcript.

## Methodology Disclosure

The evaluation separates specification from implementation evidence. GuardBench defines the scenarios, baselines, metrics, and reproducibility requirements for future external-system evaluation. This paper reports what the current repository already supports: encode and hybrid-recall latency from the canonical 0.22.2 snapshot, the `bench:memory:check` regression gate output, a local comparative GuardBench run, and a deterministic demo showing Audrey Guard blocking a repeated failed action (Ledger: E20-E25, E41-E42, E46).

This is narrower than a cross-system benchmark. It is also the honest Stage-A claim: the paper introduces the control problem, specifies the benchmark, reports local comparative results, and avoids unrun external-system comparisons.

## Performance Snapshot

The canonical performance snapshot is `benchmarks/snapshots/perf-0.22.2.json`. It was generated on 2026-05-01T02:15:29.400Z from git SHA `e2e821b`, using mock in-process 64-dimensional embeddings, a mock in-process LLM provider, hybrid vector-plus-lexical retrieval with limit 5, corpus sizes 100, 1000, and 5000, and 50 recall runs per corpus size. The machine provenance is Node 25.5.0, V8 14.1.146.11-node.18, Windows x64, 24-core AMD Ryzen 9 7900X3D, and 62.9 GB RAM (Ledger: E20).

The snapshot reports the following encode and hybrid recall latencies in milliseconds:

| Corpus Size | Encode p50 | Encode p95 | Encode p99 | Hybrid Recall p50 | Hybrid Recall p95 | Hybrid Recall p99 |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 0.331 | 0.589 | 7.65 | 0.539 | 1.82 | 2.712 |
| 1000 | 0.307 | 2.147 | 9.672 | 1.566 | 2.364 | 21.177 |
| 5000 | 0.308 | 1.838 | 10.45 | 2.091 | 3.417 | 16.58 |

These numbers measure Audrey's local call path under an in-process mock embedding provider. They do not measure real embedding-provider latency, local transformer warmup cost, GPU/CPU variance for 384-dimensional local embeddings, OpenAI or Gemini network latency, or production-load concurrency. The snapshot itself notes that cloud and local 384-dimensional providers will report higher recall latency dominated by embedding cost and network (Ledger: E20-E22, E31).

## Behavioral Regression Result

The current `benchmarks/output/summary.json` was generated on 2026-05-15T17:46:08.103Z with command `node benchmarks/run.js --provider mock --dimensions 64` (Ledger: E24). It reports:

| System | Score Percent | Pass Rate | Average Duration Ms |
|---|---:|---:|---:|
| Audrey | 100 | 100 | 15.083333333333334 |
| Vector Only | 41.66666666666667 | 25 | 0.25 |
| Keyword + Recency | 41.66666666666667 | 25 | 0.6666666666666666 |
| Recent Window | 37.5 | 25 | 0 |

This output is a regression-gate result. The baselines are toy local baselines used to catch retrieval and lifecycle regressions in the Audrey codebase. They are not external systems, not tuned competitor implementations, and not GuardBench baselines (Ledger: E23-E24). The current suite covers retrieval and operation families such as information extraction, knowledge updates, multi-session reasoning, conflict resolution, procedural learning, privacy boundary, overwrite, delete-and-abstain, semantic merge, and procedural merge (Ledger: E23-E24).

## GuardBench Local Comparative Result

The current `benchmarks/output/guardbench-summary.json`,
`benchmarks/output/guardbench-manifest.json`, and
`benchmarks/output/guardbench-raw.json` were generated on 2026-05-12 with:

```bash
npm run bench:guard:check
```

It reports local adapters only, not external-system comparisons (Ledger: E46):

| Metric | Result |
|---|---:|
| Scenarios passed | 10 / 10 |
| Prevention rate | 100% |
| False-block rate | 0% |
| Evidence recall | 100% |
| Redaction leaks | 0 |
| Recall-degradation detection | 100% |
| Guard latency p50 / p95 | 3.529 ms / 27.78 ms |
| Published artifact raw-secret leaks | 0 |
| Audrey Guard decision accuracy | 100% |
| No-memory decision accuracy | 10% |
| Recent-window decision accuracy | 60% |
| Vector-only decision accuracy | 40% |
| FTS-only decision accuracy | 10% |

The ten scenarios cover exact repeated failures, required procedures, changed
file scopes, changed commands, recovered failures, vector recall degradation,
FTS recall degradation, truncation-boundary secret redaction, conflicting
instructions, and noisy-store control-memory recall. These results are the
first public local comparative Audrey GuardBench numbers. The emitted manifest
records the ten scenario actions, seeded memories, seeded tool events, fault
injections, expected evidence classes, and non-secret references for seeded
redaction probes; the raw output file records every local adapter result for
each case. The harness also sweeps the summary, manifest, and raw output for
seeded raw secrets and fails the run on artifact leaks. External ESM adapters
receive private seed values at runtime while expected decisions and evidence
remain withheld during execution. The first concrete external adapter targets
Mem0 Platform via its REST APIs, but it has not yet been run with a live key, so
this section does not report Mem0 scores.

## Repeated-Failure Demo Transcript

The qualitative control figure is the deterministic repeated-failure demo. The project was rebuilt with `npm run build`, then the demo was run with:

```bash
node dist/mcp-server/index.js demo --scenario repeated-failure
```

The run produced the following transcript. The temporary path, memory IDs, and timestamp-bearing failure ID are run-specific; the decision structure is the evaluated behavior (Ledger: E25, E41-E42). Appendix A provides the same transcript as a standalone reproduction artifact with line annotations.

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

The transcript demonstrates the core pre-action memory-control loop for one scenario: a failed tool action is observed, a procedural lesson is encoded, a later identical action is intercepted before tool use, the guard returns a block decision, and the decision carries evidence IDs, recommendations, reflexes, and impact accounting (Ledger: E3-E4, E8-E11, E16-E17, E25, E42).

## Implemented-Evidence Summary

| Design Claim | Ledger IDs | Evidence Type |
|---|---|---|
| Audrey exposes a pre-action `allow`/`warn`/`block` controller result. | E1-E2 | Source inspection |
| Exact repeated failures are blocked by action identity. | E3, E25, E42 | Source inspection and demo |
| Post-action observation stores redacted tool outcomes and action identity. | E4, E12-E13 | Source inspection |
| Capsules preserve structured memory sections, evidence IDs, budget state, and recall errors. | E5-E7 | Source inspection |
| Preflight converts memory health, failures, risks, procedures, contradictions, and disputed memories into severity-sorted warnings. | E8-E10 | Source inspection |
| Reflexes carry response type, recommendations, and evidence IDs. | E11 | Source inspection |
| Recall degradation is represented and propagated as `RecallError[]`. | E15, E40 | Source inspection |
| Hybrid recall uses vector plus FTS with RRF constants `60`, `0.3`, and `0.7`. | E14 | Source inspection |
| Redaction covers named credentials, generic auth, private keys, payment/PII patterns, sessions, signed URLs, entropy fallback, JSON sensitive keys, and truncation marker preservation. | E12-E13 | Source inspection |
| The runtime includes SQLite, sqlite-vec, FTS5, MCP stdio, Hono REST, CLI, and Python client surfaces. | E29-E36 | Source inspection |
| Security-relevant defaults keep REST local, require API keys for non-loopback, disable no-auth exposure, disable admin tools, and restrict promote roots. | E33, E35, E37-E38 | Source inspection |
| Encode and hybrid-recall latency are reported from the canonical 0.22.2 perf snapshot. | E20-E22 | Snapshot |
| Behavioral regression status is reported from the current `bench:memory:check` output. | E23-E24 | Regression output |
| Local comparative GuardBench status is reported from `bench:guard:check`. | E46 | GuardBench comparative output |
| The repeated-failure control loop is demonstrated by the `demo --scenario repeated-failure` transcript. | E25, E41-E42 | Demo |

## What This Section Does Not Claim

This section does not claim cross-system superiority over Mem0, Letta/MemGPT, Zep, Graphiti, MemOS, LangMem, Supermemory, Cognee, or any production memory service.

This section claims local comparative GuardBench results, the adapter contract, and the existence of the Mem0 adapter only. External-system GuardBench outputs are deferred until live runs are captured.

This section does not claim production-load measurements. The performance snapshot is a local mock-provider benchmark, not a concurrency, soak, storage-pressure, or real-provider benchmark.

This section does not claim real-hardware variance. It reports one machine's provenance and raw numbers from the repository snapshot.

This section does not claim perfect redaction coverage. It reports implemented pattern coverage and the current GuardBench artifact sweep for seeded raw-secret leakage.

This section does not claim that local toy baselines represent external systems. The current `bench:memory:check` baselines exist to detect Audrey regressions.
