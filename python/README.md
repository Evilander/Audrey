# Audrey Python SDK

Typed Python client for the Audrey REST API.

## Install

```bash
pip install audrey-memory
```

For local development from this repository:

```bash
cd python
python -m pip install -e .
```

## Quick Start

Start Audrey's REST API:

```bash
npx audrey serve
```

Then use the client:

```python
from audrey_memory import Audrey

brain = Audrey(
    base_url="http://127.0.0.1:3487",
    api_key="secret",
    agent="support-agent",
)

memory_id = brain.encode(
    "Stripe returns HTTP 429 above 100 req/s",
    source="direct-observation",
    tags=["stripe", "rate-limit"],
)

results = brain.recall("stripe rate limits", limit=5)
snapshot = brain.snapshot()
brain.restore(snapshot)
brain.close()
```

Async usage:

```python
import asyncio

from audrey_memory import AsyncAudrey


async def main() -> None:
    async with AsyncAudrey(base_url="http://127.0.0.1:3487") as brain:
        await brain.health()
        await brain.encode("Deploy failed due to OOM", source="direct-observation")
        await brain.recall("deploy failure", limit=3)


asyncio.run(main())
```

## Features

- Sync and async clients powered by `httpx`
- Pydantic request and response models
- Bearer auth via `AUDREY_API_KEY`
- Agent scoping via `X-Audrey-Agent`
- Snapshot export and restore support
