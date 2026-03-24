export const PUBLISHED_LEADERBOARD = [
  {
    system: 'MIRIX',
    benchmark: 'LoCoMo',
    score: 85.4,
    unit: 'accuracy',
    source: 'https://arxiv.org/abs/2507.07957',
    note: 'Published LoCoMo result from the MIRIX paper.',
  },
  {
    system: 'Letta Filesystem',
    benchmark: 'LoCoMo',
    score: 74.0,
    unit: 'accuracy',
    source: 'https://www.letta.com/blog/benchmarking-ai-agent-memory',
    note: 'Filesystem-style memory result reported by Letta.',
  },
  {
    system: 'Mem0 Graph Memory',
    benchmark: 'LoCoMo',
    score: 68.5,
    unit: 'accuracy',
    source: 'https://arxiv.org/abs/2504.19413',
    note: 'Graph memory variant reported in the Mem0 paper.',
  },
  {
    system: 'Mem0',
    benchmark: 'LoCoMo',
    score: 66.9,
    unit: 'accuracy',
    source: 'https://arxiv.org/abs/2504.19413',
    note: 'Core Mem0 LoCoMo score reported in the Mem0 paper.',
  },
  {
    system: 'OpenAI Memory',
    benchmark: 'LoCoMo',
    score: 52.9,
    unit: 'accuracy',
    source: 'https://arxiv.org/abs/2504.19413',
    note: 'OpenAI memory baseline as reported by the Mem0 paper.',
  },
];

export const MEMORY_TRENDS = [
  {
    title: 'Memory is moving from flat retrieval to typed systems',
    summary: 'Recent work treats episodic, semantic, procedural, and graph memory as separate but cooperating layers.',
    source: 'https://arxiv.org/abs/2507.03724',
  },
  {
    title: 'Benchmarks now emphasize multi-session realism',
    summary: 'LongMemEval and LoCoMo push memory systems toward temporal updates, abstraction, and cross-session reasoning instead of single-turn fact recall.',
    source: 'https://arxiv.org/abs/2410.10813',
  },
  {
    title: 'Context engineering is now competing with retrieval-first designs',
    summary: 'Letta argues filesystem and memory-block approaches can outperform simpler retrieval-only memory on realistic long-horizon tasks.',
    source: 'https://www.letta.com/blog/memory-blocks',
  },
  {
    title: 'Production teams care about latency and token footprint, not just recall quality',
    summary: 'Mem0 frames memory as a cost and latency optimization surface in addition to a personalization surface.',
    source: 'https://arxiv.org/abs/2504.19413',
  },
  {
    title: 'Temporal and multimodal memory are becoming table stakes',
    summary: 'MIRIX and Graphiti both model time and state change explicitly instead of assuming memories stay forever true.',
    source: 'https://arxiv.org/abs/2507.07957',
  },
];
