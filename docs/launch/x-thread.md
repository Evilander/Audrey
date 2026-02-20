# X/Twitter Launch Thread

## Tweet 1 (Hook)
I built a memory system for AI agents that forgets things on purpose.

Not a bug. A feature. Here's why forgetting makes AI agents smarter:

## Tweet 2 (Problem)
Every AI memory tool stores everything forever. That's not memory -- that's hoarding.

Human brains forget 80% of what they learn. The 20% that survives? That's the signal.

Audrey models this: encode, decay, consolidate, recall. Like a brain, not a database.

## Tweet 3 (How it works)
The pipeline:

1. ENCODE -- store observations with source + confidence
2. DECAY -- Ebbinghaus forgetting curves prune low-value memories
3. CONSOLIDATE -- clusters of episodes become generalized principles
4. RECALL -- confidence-weighted retrieval (fresh + reinforced = strong)

All in SQLite. Zero cloud.

## Tweet 4 (Differentiator)
What no other memory SDK does:

- Contradiction detection (new fact conflicts with existing knowledge? flagged)
- Causal graphs (tracks WHY things cause other things)
- Source diversity (a fact confirmed by 3 different sources > 1 source repeated 3 times)
- Forgetting is a feature, not a failure mode

## Tweet 5 (Technical)
Under the hood:

- sqlite-vec for native vector KNN (cosine distance in C, not JS)
- LLM-powered principle extraction (Anthropic/OpenAI)
- Compositional confidence formula: source reliability * evidence * recency * retrieval reinforcement
- 184 tests, 17 test files

## Tweet 6 (MCP)
Ships as an MCP server for Claude Code.

5 tools: memory_encode, memory_recall, memory_consolidate, memory_introspect, memory_resolve_truth

One command to activate:
npm install audrey
npx audrey-mcp

Now every Claude session has persistent biological memory.

## Tweet 7 (Comparison)
Mem0 raised $24M for cloud-hosted AI memory.

Audrey does it locally in SQLite with:
- Forgetting curves (Mem0 doesn't)
- Contradiction detection (Mem0 doesn't)
- Causal reasoning (Mem0 doesn't)
- Zero cloud dependency

npm install audrey. Done.

## Tweet 8 (CTA)
Open source, MIT licensed, 23KB packed.

GitHub: https://github.com/Evilander/Audrey
npm: npm install audrey

What memory operations are missing for your agent workflows? Genuinely want to know.
