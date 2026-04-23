# Benchmarking Audrey

Audrey now ships with a memory benchmark harness that does three different jobs:

1. It runs Audrey against a local retrieval suite inspired by LongMemEval, plus privacy and abstention checks that matter in production.
2. It runs Audrey against an operation-level suite for update, overwrite, delete, merge, and abstain behavior.
3. It overlays published leaderboard numbers from leading memory systems on LoCoMo so you can place Audrey in the current market and research landscape without pretending the measurements are identical.

That split is deliberate. A lot of memory tooling mixes internal demos with external benchmark claims. Audrey should not do that.

## Run It

```bash
npm run bench:memory
```

The package script is the intended operator entrypoint:

```bash
npm run bench:memory
```

Artifacts are written to `benchmarks/output/`:

- `summary.json`
- `report.html`
- `local-overall.svg`
- `retrieval-overall.svg`
- `operations-overall.svg`
- `published-locomo.svg`

For CI, JSON-only output is available:

```bash
npm run bench:memory:json
```

For regression gating, use:

```bash
npm run bench:memory:check
```

That command fails if Audrey falls below its minimum local score, pass rate, or required lead over the strongest naive baseline.

To refresh the committed SVGs used in the README:

```bash
npm run bench:memory:readme-assets
```

That writes stable chart assets to `docs/assets/benchmarks/` so the GitHub repo surface shows the same benchmark posture as the generated report.

To run a single local track:

```bash
npm run bench:memory:retrieval
npm run bench:memory:operations
```

## What The Local Retrieval Benchmark Measures

The retrieval suite covers eight memory families:

- `information_extraction`
- `knowledge_updates`
- `multi_session_reasoning`
- `temporal_reasoning`
- `abstention`
- `conflict_resolution`
- `procedural_learning`
- `privacy_boundary`

This is intentionally closer to how operators evaluate memory in production than a single retrieval-accuracy number. Audrey should not only retrieve facts. It should:

- prefer fresh state over stale state
- avoid leaking private memory
- consolidate repeated episodes into reusable procedures
- handle conflict without amplifying low-reliability noise

## What The Local Operations Benchmark Measures

The operations suite covers four lifecycle families:

- `update_overwrite`
- `delete_and_abstain`
- `semantic_merge`
- `procedural_merge`

This suite exists because leading memory systems are often compared on offline recall, while real agent memory succeeds or fails on memory operations:

- can a newer fact overwrite stale state without leaking both
- can a delete actually prevent future recall
- can repeated raw events merge into reusable semantic knowledge
- can repeated events merge into an actionable procedure instead of another inert blob of text

Those are not implementation details. They are the actual product surface of memory.

## What The Published Leaderboard Means

The LoCoMo chart in the generated report is a research context layer, not a claim that Audrey has already reproduced those exact scores.

Current published anchors included in the report:

- MIRIX: LoCoMo `85.4` from the MIRIX paper
- Letta Filesystem: LoCoMo `74.0` from Letta's benchmark write-up
- Mem0 Graph Memory: LoCoMo `68.5` from the Mem0 paper
- Mem0: LoCoMo `66.9` from the Mem0 paper
- OpenAI Memory baseline: LoCoMo `52.9` as reported in the Mem0 paper

Use this chart to answer: "Where is the frontier today?" not "Has Audrey already matched that exact benchmark protocol?"

## March 23, 2026 Research Readout

The most important memory trends right now:

1. Typed memory systems are replacing flat retrieval.
   MemOS frames memory as an operating system concern with scheduling and memory-object abstractions, not just vector lookup.

2. Realistic long-horizon benchmarks are replacing toy recall tests.
   LongMemEval emphasizes multi-session reasoning, temporal updates, abstraction, and knowledge revision.

3. Context engineering is now a first-class competitor to retrieval-only memory.
   Letta's filesystem and memory-block work argues that editable context structure can outperform simpler retrieval-only designs.

4. Production memory is now judged on latency and token cost too.
   Mem0 explicitly reports quality alongside lower token and latency overhead.

5. Temporal and multimodal memory are moving into the frontier.
   MIRIX pushes beyond text-only episodic recall into typed multimodal memory with compression.

## What Audrey Should Do Next

The benchmark highlights the next credible roadmap for Audrey:

- first-party LoCoMo and LongMemEval adapters so Audrey can publish directly reproducible external benchmark numbers
- contradiction-state and truth-resolution benchmark cases, not just retrieval outcomes
- cost, latency, and storage curves against long-context baselines and simpler memory systems
- a typed memory graph layer for cross-memory state transitions and time-aware reasoning

## Source Links

- LongMemEval: [arXiv 2410.10813](https://arxiv.org/abs/2410.10813)
- Mem0: [arXiv 2504.19413](https://arxiv.org/abs/2504.19413)
- MIRIX: [arXiv 2507.07957](https://arxiv.org/abs/2507.07957)
- MemOS: [arXiv 2507.03724](https://arxiv.org/abs/2507.03724)
- MemGPT: [arXiv 2310.08560](https://arxiv.org/abs/2310.08560)
- Letta memory blocks: [Letta blog](https://www.letta.com/blog/memory-blocks)
- Letta benchmarking: [Letta benchmark write-up](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- LoCoMo benchmark repo: [snap-research/locomo](https://github.com/snap-research/locomo)
- LongMemEval repo: [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval)
