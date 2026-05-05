# Audrey Memory Benchmarking Strategy

Updated: 2026-05-05 for the 0.23.0 Audrey Guard release.

Audrey should win trust before it tries to win leaderboards. The benchmark story is:
separate what Audrey can prove locally, publish the exact harness and artifacts, and
only compare against external systems on tasks that measure the same thing.

## 0.23.0 Release Stance

- Performance snapshots measure Audrey's local pipeline: SQLite, sqlite-vec,
  hybrid ranking, and post-encode work. They intentionally exclude hosted
  embedding latency and do not compare against unrelated systems.
- The behavioral suite is split into retrieval, lifecycle operations, and guard
  loop behavior. Guard cases stay out of the comparable aggregate because
  "no controller" baselines are useful regressions, not fair leaderboard peers.
- `npm run bench:memory:guard` is Audrey's new product benchmark: can memory
  stop an agent before it repeats a known tool failure or violates a must-follow
  release rule, and can the receipt boundary reject replayed or non-guard
  outcomes?
- The next public claim should be a reproducible report, not a slogan: commit
  the command, raw JSON, machine provenance, model/provider configuration, and
  any judge prompt or scoring rule used.

## External Benchmark Map

| Benchmark | What It Tests | Audrey Fit |
|---|---|---|
| LongMemEval | Information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention across scalable chat histories. | Good retrieval/lifecycle fit once Audrey has an adapter and evaluator. Source: https://arxiv.org/abs/2410.10813 |
| LoCoMo | Very long-term conversations around 300 turns, 9K tokens on average, and up to 35 sessions, with QA, summarization, and multimodal dialogue tasks. | Useful external context, but Audrey should keep published scores separate from local synthetic cases. Source: https://arxiv.org/abs/2402.17753 |
| MemoryAgentBench | Incremental multi-turn memory with accurate retrieval, test-time learning, long-range understanding, and selective forgetting. | Strong fit for Audrey's live agent posture because it evaluates online accumulation rather than static long-context reading. Source: https://arxiv.org/abs/2507.05257 |
| StructMemEval | Whether agents organize long-term memory into useful structures such as ledgers, to-do lists, and trees rather than just recalling facts. | High-value 0.24 target for Audrey's memory-controller routing and future typed memory stores. Source: https://arxiv.org/abs/2602.11243 |
| MemGUI-Bench | Cross-temporal and cross-spatial memory for mobile GUI agents, with memory-centric tasks and staged evaluation. | Not a direct coding-agent benchmark, but its failure taxonomy is relevant to tool-bound agents with UI state. Source: https://arxiv.org/abs/2602.06075 |

## Release-Quality Rules

1. Do not mix controller benchmarks with retrieval leaderboards unless all
   compared systems receive equivalent controller affordances.
2. Do not quote latency without the embedding provider, dimensions, corpus size,
   recall mode, hardware, Node version, and whether warm caches were involved.
3. Treat abstention, deletion, overwrite, conflict resolution, and selective
   forgetting as first-class memory outcomes, not edge cases.
4. Prefer task evidence over vibe: raw JSON, artifacts, evaluator code, and
   reproduction commands should ship with every public benchmark claim.
5. For coding-agent memory, measure prevented mistakes and time-to-recovery, not
   only whether a stored fact was recalled.

## 0.24 Benchmark Targets

- Add a LongMemEval adapter that can run a small public shard with mock and real
  embedding providers.
- Add a MemoryAgentBench-style incremental harness with explicit selective
  forgetting and test-time learning cases.
- Add structured-memory cases that force Audrey to maintain a ledger, checklist,
  or dependency tree across sessions.
- Add an agent-tool benchmark where `beforeAction()` and `afterAction()` wrap a
  scripted coding workflow and score prevented repeats, blocked violations, and
  useful cautions.
- Publish one reproducible external report before making any SOTA-style claim.
