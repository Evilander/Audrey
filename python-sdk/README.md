# audrey-memory

Python SDK for [Audrey](https://github.com/Evilander/Audrey) -- biological memory for AI agents.

## Install

```bash
pip install audrey-memory
```

Requires a running Audrey server:
```bash
npx audrey serve
```

## Quick Start

```python
from audrey_memory import Audrey

brain = Audrey()  # connects to localhost:7437

# Encode a memory
result = brain.encode(
    content="Stripe API returns 429 above 100 req/s",
    source="direct-observation",
    tags=["stripe", "rate-limit"],
)

# Recall memories
memories = brain.recall("stripe rate limits", limit=5)

# Run dream cycle
dream = brain.dream()

brain.close()
```

### Async

```python
from audrey_memory import AsyncAudrey

async with AsyncAudrey() as brain:
    await brain.encode(content="...", source="direct-observation")
    memories = await brain.recall("search query")
```
