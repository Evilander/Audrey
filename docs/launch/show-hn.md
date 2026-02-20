# Show HN: Audrey -- Biological memory for AI agents that forgets on purpose

I built an open-source memory SDK for AI agents that models how human brains actually work -- memories encode, decay over time, reinforce when recalled, and consolidate into principles while you sleep.

**The problem:** AI agents either forget everything between sessions or dump everything into a vector database forever. That's not memory -- that's a filing cabinet. Real memory is lossy, prioritized, and self-organizing.

**What Audrey does differently:**

- **Episodic encoding** -- observations stored with source, confidence, timestamps
- **Ebbinghaus forgetting curves** -- unused memories decay naturally, high-value ones persist
- **Consolidation** -- clusters of related episodes get extracted into generalized principles (like sleep)
- **Contradiction detection** -- new information is checked against existing knowledge, conflicts flagged
- **Causal graphs** -- tracks WHY things cause other things, not just that they co-occur
- **Confidence scoring** -- composite formula weighing source reliability, evidence count, recency, retrieval frequency

Everything runs locally on SQLite with sqlite-vec for vector search. No cloud, no API keys required for core functionality. Ships as both a Node.js SDK and an MCP server for Claude Code.

```js
import { Audrey } from 'audrey';
const brain = new Audrey({ dataDir: './memory', embedding: { provider: 'mock', dimensions: 8 } });

await brain.encode({ content: 'Stripe rate limit is 100/s', source: 'direct-observation' });
await brain.encode({ content: 'Stripe rate limit is 100/s', source: 'tool-result' });
await brain.encode({ content: 'Stripe rate limit is 100/s', source: 'told-by-user' });

await brain.consolidate(); // extracts: "Stripe enforces ~100 req/s rate limit"
const memories = await brain.recall('stripe api limits');
```

**Tech:** Node.js ES modules, better-sqlite3, sqlite-vec (native vector KNN), pluggable LLM providers (Anthropic/OpenAI) for principle extraction and contradiction resolution. 184 tests.

I'm particularly interested in feedback on:
- Does the biological metaphor (decay, consolidation, reinforcement) add real value over simpler key-value memory?
- Is the confidence formula reasonable or over-engineered?
- What memory operations are missing for real agent workflows?

GitHub: https://github.com/Evilander/Audrey
npm: `npm install audrey`
