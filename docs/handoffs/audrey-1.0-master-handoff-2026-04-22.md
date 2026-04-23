# Audrey 1.0 Master Handoff

Audit date: April 22, 2026

This handoff is for the actual local checkout at `B:\projects\claude\audrey`.
The environment date is April 22, 2026. Earlier notes in this repo that refer to March 22, 2026 or to a nested `B:\projects\claude\audrey\Audrey` repo are stale relative to the current machine.

## Executive Summary

Audrey still has a real shot at becoming the default local-first memory runtime for agents, but this checkout is not currently releasable.

The core opportunity is strong:

- SQLite-first local memory
- real cognitive primitives instead of plain note storage
- MCP plus CLI plus REST plus Python surface area
- an internal benchmark harness
- a credible long-term thesis around continuity, contradiction, decay, consolidation, and trust

The current blockers are also strong:

- the repo is in an unresolved merge state
- packaging is split between incompatible release lines
- there are two competing server stories
- the machine-wide host integrations currently point at a stale path
- the benchmark story is still internal hygiene, not market-proof evidence

Do not publish Audrey 1.0 from this checkout.
First rescue the repo, then prove the product, then publish.

## Hard Facts From This Audit

### Repo reality

- `package.json`, `package-lock.json`, `codex.md`, `mcp-server/index.ts`, `src/audrey.ts`, `src/encode.ts`, `src/import.ts`, `src/consolidate.ts`, `src/recall.ts`, `benchmarks/run.js`, and `tests/mcp-server.test.js` contain merge markers.
- The checkout is not buildable from head because the manifest is invalid JSON and core TypeScript files are conflicted.
- The repo currently mixes at least two release narratives:
  - a newer TypeScript plus `dist/` line that claims `0.20.0`
  - an older checked-in JS line that still behaves like `0.17.0`
- The outer repo is the actual current checkout. The nested `Audrey\` directory only contains `node_modules` and is not the active repo.

### Product reality

- Audrey already has meaningful differentiated implementation in the storage and retrieval core:
  - SQLite plus `sqlite-vec`
  - FTS-backed retrieval
  - source reliability, evidence agreement, recency, reinforcement, context, and mood-aware scoring
  - consolidation into semantic and procedural memory
  - contradiction handling
  - causal links
  - affect modeling
- Audrey also has meaningful product surfaces:
  - MCP tools
  - CLI
  - REST server implementations
  - Python SDK directories
  - Docker path
  - benchmark harness

### Machine reality

- Codex is configured in `C:\Users\evela\.codex\config.toml` to launch `B:\projects\claude\audrey\audrey\mcp-server\index.js`.
- Claude Code is configured in `C:\Users\evela\.claude.json` to launch the same stale nested path.
- That nested path does not exist.
- The built path that does exist is `B:\projects\claude\audrey\dist\mcp-server\index.js`.
- Claude Desktop config exists at `C:\Users\evela\AppData\Roaming\Claude\claude_desktop_config.json`, but it currently has no Audrey MCP entry.
- ChatGPT custom MCP is not locally installable today through a local stdio server. OpenAI's current docs require a remote MCP endpoint and describe the feature as ChatGPT web developer mode, not a local desktop-only config path.

## What Audrey Already Has That Is Worth Defending

These are the parts that justify making a serious push instead of starting over:

1. Audrey is local-first.
   One SQLite-backed memory store is still a real moat against infra-heavy competitors.

2. Audrey is not just note storage.
   The repo already encodes a stronger memory thesis than "vector store plus retrieve."

3. Audrey has the right host-facing shape.
   MCP, CLI, HTTP, Python, and Docker are the right surfaces for distribution.

4. Audrey already has benchmark instincts.
   Even though the current proof is insufficient, the repo understands that memory must be measured as behavior, not marketing.

5. Audrey's best future category is bigger than "biological memory."
   The strongest frame is continuity engine or memory control plane for agents.

## Current External Reality: What The Frontier Looks Like On April 22, 2026

These are the most important current signals from primary sources and official project material.

### 1. The market now rewards selective memory and cost control, not just recall

- `Mem0` (submitted April 28, 2025) argues that a memory system must extract, consolidate, retrieve salient information, beat baseline memory systems on LoCoMo, and cut latency and token cost relative to full-context methods.
- `LightMem` (latest arXiv revision February 28, 2026; ICLR 2026) pushes even harder on efficiency, using sensory filtering, short-term consolidation, and sleep-time long-term updates to reduce token and API costs while improving LongMemEval and LoCoMo results.

Implication for Audrey:

- Audrey 1.0 needs first-class write selectivity, storage cost accounting, and token economy receipts.
- "Biological fidelity" without cost proof will not win the category.

### 2. The frontier is moving from memory library to memory operating system

- `MemOS` (latest arXiv revision December 3, 2025) frames memory as a managed system resource with representation, scheduling, and lifecycle control.

Implication for Audrey:

- Audrey needs an explicit controller layer.
- The core missing abstraction is not another memory type. It is policy-governed control over write, update, replay, compression, conflict handling, and forgetting.

### 3. Typed and multimodal memory is no longer optional at the high end

- `MIRIX` proposes six structured memory types, including resource memory and knowledge vault behavior, and explicitly pushes beyond plain text memory.

Implication for Audrey:

- Audrey needs first-class resource and artifact memory.
- Files, screenshots, URLs, tables, and tool outputs should be durable typed objects, not flattened into text blobs.

### 4. Temporal truth is a first-class battleground

- `Zep` and `Graphiti` explicitly position temporal validity windows, provenance, and historical queryability as the advantage over flat retrieval.
- Graphiti's current official repo language centers "what's true now and what was true before."

Implication for Audrey:

- Audrey must represent changing state, not just timestamped observations.
- A 1.0-worthy Audrey needs entity-state timelines and supersession semantics that can answer "what was true when."

### 5. Learned memory management is emerging as the next serious differentiator

- `Memory-R1` (latest arXiv revision January 14, 2026) learns structured memory operations like `ADD`, `UPDATE`, `DELETE`, and `NOOP` through reinforcement learning.
- `Mem-alpha` trains agents to construct and update complex memory systems through downstream QA rewards and generalizes to much longer contexts than training.

Implication for Audrey:

- Audrey should separate candidate generation from policy.
- The medium-term bet is a controller that can learn or adapt write and retrieval decisions from outcomes, not just heuristics.

### 6. External benchmark proof matters more than internal benchmark confidence

- `LongMemEval` explicitly measures information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention.
- `LoCoMo` remains a public long-horizon conversational benchmark with reproducible evaluation code.
- Letta's official benchmark write-up argues that a filesystem-centric agent can score strongly on LoCoMo, which is an uncomfortable but important reminder that tool ergonomics can outperform "specialized" memory if the latter is hard for the model to use.

Implication for Audrey:

- Audrey must beat strong external baselines in reproducible public runs.
- Audrey must also be ergonomically easy for frontier agents to use.

## The Audrey 1.0 Thesis

Audrey 1.0 should not ship as:

- a clever memory library
- a biomimetic experiment
- a pile of retrieval features

Audrey 1.0 should ship as:

**the local-first continuity engine for agents**

More concrete version:

**Audrey should be the runtime that manages an agent's persistent beliefs, commitments, contradictions, procedures, and repairs under explicit cost, trust, and temporal-state constraints.**

That framing is stronger than "memory."
It gives Audrey a real product and benchmark target.

## What Audrey Must Become To Beat The Next Best Thing

### Non-negotiable product laws

1. One runtime.
   TypeScript source builds to one canonical `dist/` artifact. No split brain.

2. One public contract.
   One canonical server, one canonical port, one canonical route family, one canonical health model.

3. One benchmark truth stack.
   Internal regression suite plus external reproducible LoCoMo and LongMemEval adapters.

4. One controller layer.
   Memory writes, updates, replay, reconsolidation, archive, and forgetting need policy ownership.

5. One host story.
   Codex, Claude Code, Claude Desktop, and remote ChatGPT integration must each have a real supported path.

### Specific feature gaps that matter most

1. Memory controller
   Add `MemoryController`, `ObservationBus`, `ReplayScheduler`, `ReconsolidationGate`, and `RetentionManager`.

2. Temporal state
   Represent subject, predicate, value, valid-from, valid-to, superseded-by, observed-at, confidence, scope, and provenance.

3. Typed memory objects
   Add resource memory and entity-state memory, not just episodic, semantic, and procedural.

4. Utility-aware writes
   Record write decision, novelty, conflict risk, privacy risk, and expected utility.

5. Utility-aware retrieval
   Rank by predicted downstream usefulness, not only similarity and recency.

6. Remote MCP surface
   To support ChatGPT, Audrey needs a real remote MCP implementation over streaming HTTP or SSE.

## Recommended 1.0 Execution Order

### Phase 0: Repo Rescue

This is the actual blocker. Nothing else should outrank it.

1. Resolve all merge conflicts.
2. Decide the canonical release line:
   - source of truth: TypeScript in `src/` and `mcp-server/`
   - build artifact: `dist/`
   - canonical MCP entrypoint: `dist/mcp-server/index.js`
3. Delete or quarantine obsolete checked-in JS runtime paths that fight the TS build.
4. Unify the server contract:
   - recommend `7437`
   - keep `/health`, `/v1/*`, `/openapi.json`, `/docs`
   - treat the legacy `3487` sidecar API as either a compatibility shim or a dead path
5. Collapse Python packaging to one directory. Recommend `python/` as the only Python package root.
6. Fix Docker to run the actual built artifact, not a missing source JS path.
7. Make `README.md`, `SECURITY.md`, `codex.md`, CI, and package metadata agree on one version line.

Exit criteria:

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm test`
- `npm run bench:memory:check`
- `npm pack --dry-run`
- Python wheel and sdist build cleanly

### Phase 1: Release-Proof Stack

1. Add clean-install smoke tests for npm tarball.
2. Add clean-install smoke tests for Python wheel.
3. Strengthen Docker smoke to include encode, recall, auth, restart persistence, and snapshot/restore.
4. Add Windows-specific launch verification for `cmd /c npx` and direct node entrypoint modes.
5. Publish one evidence bundle per release:
   - CI links
   - benchmark artifacts
   - package hashes
   - smoke outputs

Exit criteria:

- Audrey can be installed from its built artifacts, not just from repo source
- release evidence is attached to every candidate

### Phase 2: Benchmark Credibility

1. Keep the current internal benchmark harness, but label it regression-only.
2. Build first-party adapters for LoCoMo and LongMemEval.
3. Pin model/provider configs and prompts for reproducibility.
4. Add cost, latency, and storage-growth curves.
5. Add direct comparisons against:
   - naive baselines
   - long-context baseline
   - filesystem baseline
   - at least one graph-memory competitor

Exit criteria:

- Audrey can make externally defensible claims
- benchmark results are reproducible from a documented command path

### Phase 3: The Controller Layer

1. Introduce explicit write policy.
2. Introduce replay scheduling with sleep-time maintenance classes.
3. Introduce temporal entity-state memory.
4. Introduce typed resource memory.
5. Introduce mutation receipts and inspection traces for every meaningful memory change.

Exit criteria:

- Audrey stops being just a memory store with features
- Audrey becomes a continuity runtime with explicit state transition logic

### Phase 4: Distribution And Host Dominance

1. Make local install absurdly easy on Windows and macOS.
2. Ship a first-party Claude Desktop extension package if Anthropic's extension path remains the preferred install surface.
3. Keep direct stdio config examples for power users and MCP hosts.
4. Build a remote MCP deployment path for ChatGPT developer mode.
5. Add host-specific docs for Codex, Claude Code, Claude Desktop, and ChatGPT.

Exit criteria:

- Audrey is easy to install anywhere serious agent users already work

## System-Wide Machine Plan

### What is wrong right now

- Codex is registered to a missing nested Audrey path.
- Claude Code is registered to the same missing path.
- Claude Desktop is not registered at all.
- ChatGPT cannot use Audrey locally because current OpenAI docs require remote MCP and web-based developer mode.

### What to do now

This handoff includes `scripts/install-audrey-machine.ps1`.

That script is designed to:

- back up `C:\Users\evela\.codex\config.toml`
- back up `C:\Users\evela\.claude.json`
- back up `C:\Users\evela\AppData\Roaming\Claude\claude_desktop_config.json`
- repoint Codex to `B:\projects\claude\audrey\dist\mcp-server\index.js`
- repoint Claude Code to the same built entrypoint
- add Audrey to Claude Desktop config with a local stdio MCP entry

It intentionally does not attempt a ChatGPT local install, because that is not a supported current host path.

### ChatGPT plan

ChatGPT support requires a separate deliverable:

1. Audrey remote MCP server over streaming HTTP or SSE
2. remote hosting
3. app metadata and auth configuration
4. ChatGPT developer mode app creation on ChatGPT web

That is a real roadmap item, not a config tweak.

## Publish Answer

### What not to publish yet

Do not push this current checkout to npm or PyPI.

Reasons:

- the repo is conflicted
- the version line is inconsistent
- the install surfaces are contradictory
- the release evidence is stale relative to head

### What the public state appears to be

- GitHub's latest visible release page shows `v0.16.1` on March 7, 2026.
- The current repo contains conflicting claims for `0.17.0` and `0.20.0`.
- The repo simultaneously claims PyPI publication and also contains checklist language that still says "Publish to PyPI as `audrey-memory`," so PyPI state should be treated as untrusted until re-verified during release work.

### Recommended publish sequence

1. Resolve repo and green all release gates.
2. Publish npm only after tarball install smoke passes.
3. Publish PyPI only after wheel and sdist install smoke passes.
4. Cut a GitHub release with evidence artifacts attached.
5. If ChatGPT support matters for 1.0 messaging, publish a remote MCP deployment target as well.

## Immediate Next Move

If continuing from this handoff, the right next slice is:

1. resolve the merge into one TypeScript-first release line
2. standardize on `dist/mcp-server/index.js`
3. standardize on the Hono/OpenAPI HTTP surface
4. repair Codex and Claude host configs to the built entrypoint
5. make the repo green before doing any broader 1.0 storytelling

## Source Pointers

- Mem0: https://arxiv.org/abs/2504.19413
- Zep: https://arxiv.org/abs/2501.13956
- MemOS: https://arxiv.org/abs/2507.03724
- MIRIX: https://arxiv.org/abs/2507.07957
- Memory-R1: https://arxiv.org/abs/2508.19828
- Mem-alpha: https://arxiv.org/abs/2509.25911
- LightMem: https://arxiv.org/abs/2510.18866
- LongMemEval: https://arxiv.org/abs/2410.10813
- LoCoMo: https://github.com/snap-research/locomo
- Letta benchmark write-up: https://www.letta.com/blog/benchmarking-ai-agent-memory
- Graphiti: https://github.com/getzep/graphiti
- ChatGPT MCP docs: https://developers.openai.com/api/docs/mcp
- ChatGPT developer mode docs: https://developers.openai.com/api/docs/guides/developer-mode
- ChatGPT help article on developer mode and MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta
- Claude Desktop local MCP docs: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp
