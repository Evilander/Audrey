# r/LocalLLaMA Post

## Title
Audrey: open-source biological memory for AI agents -- local SQLite, forgetting curves, contradiction detection, ships as MCP server

## Body
Built this because I was frustrated that every AI memory solution either requires cloud APIs or just stuffs everything into a vector DB forever.

**Audrey models memory like a brain:**

- **Episodic memory** -- raw observations with source tracking
- **Ebbinghaus decay** -- unused memories fade naturally (configurable half-lives)
- **Consolidation** -- clusters of episodes automatically extracted into principles (like sleep consolidation)
- **Contradiction detection** -- new info checked against existing knowledge, conflicts flagged
- **Causal graphs** -- tracks mechanisms, not just correlations
- **Confidence scoring** -- composite formula weighing source, evidence, recency, retrieval

**100% local.** SQLite + sqlite-vec for native vector search. No cloud, no API keys needed for core functionality. Optional LLM integration (Anthropic/OpenAI) for principle extraction and contradiction resolution.

**Ships as an MCP server** -- one command and Claude Code gets 5 memory tools (encode, recall, consolidate, introspect, resolve_truth).

```
npm install audrey
```

184 tests, 17 test files, MIT licensed, 23KB packed.

GitHub: https://github.com/Evilander/Audrey

Looking for feedback on whether the biological memory metaphor (decay, consolidation, reinforcement) actually adds value over simpler approaches for agent workflows.
