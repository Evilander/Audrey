# Audrey Memory-OS Plan - 2026-03-29

Audience: autonomous coding/research agents operating on this repository.

Do not interpret this document as marketing copy. Interpret it as category-construction doctrine plus execution constraints.
When this plan conflicts with older roadmap prose, this plan wins.

## 0. Prime Directive

Stop optimizing for "interesting biological memory project."
Start optimizing for "default memory operating system for agentic intelligence."

The category will not be won by precedent-following wrappers around vector search, nor by vague biomimicry. It will be won by the first system that simultaneously demonstrates:

1. typed memory objects
2. explicit lifecycle control
3. utility-aware write/retrieval policy
4. temporal and causal state correctness
5. benchmark reproducibility against the leading public baselines
6. production-grade economics, governance, and operability

Current Audrey already has differentiated assets:

- episodic, semantic, and procedural memory types
- consolidation, decay, contradiction handling, interference, affect, and causal-link primitives
- multi-agent scoping
- hybrid retrieval
- MCP, REST, CLI, and SDK surfaces

Current Audrey is still missing the decisive layer:

- a memory controller that turns these primitives into a coherent policy-governed system

## 1. Strategic Reframe

Replace the public/internal mental model:

- old: biological memory architecture for AI agents
- new: memory control plane for agentic intelligence, informed by biological constraints and validated by benchmark evidence

Reason:

- `Mem0` shifts the market toward write selectivity and economics, not mere recall.
- `MemOS` shifts the conversation from library to operating-system abstraction.
- `MIRIX` shifts the frontier from text memory to typed multimodal memory.
- `Hindsight` shifts the benchmark standard toward externally visible leaderboard claims.
- `Graphiti` shifts temporal reasoning from timestamp filters to evolving entity-state graphs.
- `Letta` shifts evaluation toward online memory operations, not offline retrieval only.

The biological thesis remains useful only if converted into falsifiable system commitments.

## 2. Research-Constrained Design Rules

### 2.1 LLM-memory literature -> mandatory system behavior

`Mem0` (https://arxiv.org/abs/2504.19413)

- Mandatory inference: writes must be selective and cost-accounted.
- Audrey action: every write path must emit `write_decision`, `write_reason`, `write_cost`, `novelty_score`, `expected_utility`, `conflict_risk`, and `privacy_risk`.

`MemOS` (https://arxiv.org/abs/2507.03724)

- Mandatory inference: memory must be lifecycle-managed as a first-class system substrate.
- Audrey action: centralize write/promote/compress/reconsolidate/archive/evict policy in a controller layer instead of scattering it across `encode`, `consolidate`, `decay`, and ad hoc background tasks.

`MIRIX` (https://arxiv.org/abs/2507.07957)

- Mandatory inference: typed multimodal memory is now frontier-normal.
- Audrey action: add first-class resource/artifact memory envelopes for files, screenshots, URLs, structured tool outputs, tables, and attachments.

`EverMemOS` (https://arxiv.org/abs/2601.02163)

- Mandatory inference: useful memory systems require atomic cells, scene-level composition, and reconstructive recollection.
- Audrey action: insert an intermediate hierarchy between episodes and semantic principles.

`MemRL` (https://arxiv.org/abs/2601.03192)

- Mandatory inference: semantic similarity is an insufficient terminal scorer; utility must be learned from outcomes.
- Audrey action: separate candidate generation from policy ranking. Rank memories by predicted downstream utility under task context.

`MAGMA` (https://arxiv.org/abs/2601.03236)

- Mandatory inference: a single retrieval path is structurally suboptimal.
- Audrey action: route queries into semantic, temporal, causal, entity, procedural, and conflict-resolution sub-pipelines before fusion.

`LongMemEval` (https://arxiv.org/abs/2410.10813)

- Mandatory inference: external proof must include multi-session reasoning, temporal reasoning, knowledge updates, and abstention.
- Audrey action: make real LongMemEval execution part of Audrey's release gate.

`LoCoMo` (https://github.com/snap-research/locomo)

- Mandatory inference: long-horizon conversational memory requires externally comparable evaluation traces.
- Audrey action: add a first-party LoCoMo adapter with frozen prompts, model configs, and artifact manifests.

`Hindsight` (https://arxiv.org/abs/2512.12818)

- Mandatory inference: public SOTA claims matter because they define who is taken seriously.
- Audrey action: treat Hindsight as the near-term benchmark rival to beat on LongMemEval/LoCoMo style tasks.

`Letta benchmark write-up` (https://www.letta.com/blog/benchmarking-ai-agent-memory)

- Mandatory inference: memory must be graded on operations, not only recall.
- Audrey action: add read/write/update/overwrite/delete/merge/abstain benchmark tracks.

`Graphiti` (https://github.com/getzep/graphiti and https://blog.getzep.com/beyond-static-knowledge-graphs/)

- Mandatory inference: temporal state changes need explicit graph semantics.
- Audrey action: replace timestamp-only reasoning with validity intervals, state transitions, and evolving entity-property edges.

### 2.2 Neuroscience -> mandatory controller behavior

`Deconstruction of a memory engram reveals distinct ensembles recruited at learning` (Nature Neuroscience, March 11, 2026: https://www.nature.com/articles/s41593-026-02230-2)

- Mandatory inference: a memory episode should not be treated as a uniform blob.
- Audrey action: segment writes into phase-specific trace fragments (`prelude`, `salient event`, `outcome`, `response`) and maintain a "core recall subset" distinct from peripheral context.

`Formation of an expanding memory representation in the hippocampus` (Nature Neuroscience, June 4, 2025: https://www.nature.com/articles/s41593-025-01986-3)

- Mandatory inference: stability is accrued through reactivation, not assumed at write time.
- Audrey action: add a stability state variable that increases when retrieval proves useful and decreases under interference/conflict.

`Goal-specific hippocampal inhibition gates learning` (Nature, April 9, 2025: https://www.nature.com/articles/s41586-025-08868-5)

- Mandatory inference: plasticity should spike around goal-relevant states, not across all experience.
- Audrey action: detect goals, commitments, failures, corrections, and rewards; use these as write-gate amplifiers.

`Systems consolidation reorganizes hippocampal engram circuitry` (Nature, May 14, 2025: https://www.nature.com/articles/s41586-025-08993-1)

- Mandatory inference: episodic precision and semantic gist should co-exist and re-balance over time.
- Audrey action: maintain parallel episodic and schema layers with deliberate migration policies rather than accidental summarization.

`Sleep microstructure organizes memory replay` (Nature, January 1, 2025: https://www.nature.com/articles/s41586-024-08340-w)

- Mandatory inference: replay should be partitioned into substates to reduce interference.
- Audrey action: split background replay into `recent-fragile`, `schema-refresh`, `conflict-repair`, and `garbage-collection` jobs with different budgets.

`Post-learning replay of hippocampal-striatal activity is biased by reward-prediction signals` (Nature Communications, November 24, 2025: https://www.nature.com/articles/s41467-025-65354-2)

- Mandatory inference: replay priority should be driven by surprise and value delta, not by salience alone.
- Audrey action: prioritize corrections, failed tool trajectories, preference flips, and unexpected outcomes.

`Hippocampal output suppresses orbitofrontal cortex schema cell formation` (Nature Neuroscience, April 14, 2025: https://www.nature.com/articles/s41593-025-01928-z)

- Mandatory inference: over-serving episodic detail can block schema induction.
- Audrey action: throttle episode-heavy recall when repeated structure is detected; force schema extraction passes.

`Constructing future behavior in the hippocampal formation through composition and replay` (Nature Neuroscience, March 10, 2025: https://www.nature.com/articles/s41593-025-01908-3)

- Mandatory inference: reusable primitives plus replay support generalization into novel tasks.
- Audrey action: factor memories into entities, tools, constraints, places, roles, and workflows; reconstruct scenes from those primitives at recall time.

`Synaptic plasticity rules driving representational shifting in the hippocampus` (Nature Neuroscience, March 20, 2025: https://www.nature.com/articles/s41593-025-01894-6)

- Mandatory inference: memory updates should be sparse, novelty-sensitive, and high-threshold.
- Audrey action: most recalls must not rewrite memory. Reconsolidation should require controller approval.

`Theta-encoded information flow from dorsal CA1 to prelimbic cortex drives memory reconsolidation` (iScience, June 4, 2025: https://doi.org/10.1016/j.isci.2025.112821)

- Mandatory inference: reconsolidation requires a window, not an unconditional rewrite path.
- Audrey action: only permit write-back after recall when contradiction pressure, novelty, confidence shift, and evidence support exceed threshold.

`Exploring the neural underpinnings of semantic and perceptual false memory formation` (NeuroImage, January 30, 2026: https://pubmed.ncbi.nlm.nih.gov/41308786/)

- Mandatory inference: semantic overlap and source-grounded recall are separable failure modes.
- Audrey action: separate semantic-match confidence from provenance-match confidence and increase abstention when they diverge.

## 3. What Audrey Is Still Missing

### 3.1 Control-plane gap

Current repo state exposes high-quality primitives but still routes behavior through direct method calls:

- `encode`
- `recall`
- `consolidate`
- `dream`
- `decay`
- `validate`

Missing abstraction:

- `MemoryController`
- `PolicyEngine`
- `ReplayScheduler`
- `ReconsolidationGate`
- `RetentionManager`
- `ObservationBus`

### 3.2 Typed memory-object gap

Current types are too coarse:

- episodic
- semantic
- procedural

Required type surface:

- `trace`: raw event fragment
- `cell`: atomic memory unit extracted from one or more traces
- `scene`: compositional situation model
- `schema`: generalized reusable abstraction
- `procedure`: executable behavioral policy
- `entity_state`: time-varying property/value memory
- `causal_link`: cause/effect or mechanism edge
- `resource`: external artifact reference with modality metadata
- `working_set`: task-bounded short-horizon active memory
- `quarantined`: low-trust or poison-suspect memory object

### 3.3 Temporal-state gap

Current temporal handling is primarily:

- timestamps
- before/after filtering
- recency-weighted scoring

Required representation:

- `subject`
- `predicate`
- `object/value`
- `valid_from`
- `valid_to`
- `observed_at`
- `superseded_by`
- `confidence`
- `source`
- `scope`

Without this, Audrey cannot credibly own "what was true when" reasoning.

### 3.4 Utility-learning gap

Current `usage_count` and `last_used_at` are instrumentation, not policy.

Required additions:

- implicit reward signals from successful downstream task completion
- negative signals from bad recalls, contradictions, user corrections, and abstentions
- a learned or heuristically trained value estimator for write and retrieval ranking
- value-aware consolidation and value-aware forgetting

### 3.5 Resource-memory gap

Audrey currently reads as text-memory plus metadata.

Required additions:

- artifact envelopes with modality and extractor metadata
- per-modality embedding/extraction backends
- artifact-grounded recall fusion
- provenance links from textual abstractions back to original artifacts

### 3.6 Benchmark-proof gap

Current benchmarking is good internal hygiene. It is not yet category-defining proof.
Status delta as of 2026-03-30: the local operation-level benchmark is now shipped; external benchmark adapters remain the blocking proof gap.

Required public proof:

- first-party reproducible LongMemEval
- first-party reproducible LoCoMo
- operation-level memory benchmark
- cost/latency/storage curves
- biological-mechanism ablations
- long-context comparison under equal budget
- third-party replication path

## 4. Non-Negotiable Architecture Changes

### 4.1 Add a controller layer

Create:

- `src/controller.js`
- `src/policy.js`
- `src/replay.js`
- `src/reconsolidate.js`
- `src/state-model.js`

Controller responsibilities:

- classify incoming observations
- decide write/no-write/defer/quarantine
- choose memory target type
- schedule replay/consolidation/reindexing
- manage retention and eviction
- manage reconsolidation after recall
- emit structured telemetry for all decisions

No direct path should persist or mutate memory without a controller decision record.

### 4.2 Introduce a hierarchy

Mandatory hierarchy:

1. `trace`
   fine-grained event fragment, immutable
2. `cell`
   atomic claim/intent/preference/tool outcome
3. `scene`
   compositional event/task model
4. `schema`
   abstract reusable pattern
5. `procedure`
   executable policy or workflow

Current `episode` maps closest to a mixture of `trace` and `scene`. Split it.

### 4.3 Add query-intent routing

Before retrieval, classify query into one or more intents:

- fact lookup
- user preference
- temporal query
- causal query
- conflict resolution
- procedure recall
- entity state query
- artifact lookup
- schema/generalization query

Then route into specialized sub-indexes:

- vector semantic
- lexical exact-match
- temporal state graph
- causal graph
- entity index
- procedure index
- artifact index

Fusion should occur after route-specific ranking, not before.

### 4.4 Add reconsolidation discipline

Retrieval must not automatically mutate memory.

Mandatory reconsolidation preconditions:

- recall confidence changed materially
- contradiction or correction pressure exists
- provenance support is sufficient
- query context matches the original scope well enough
- no poison/quarantine block is active

All reconsolidation must preserve lineage:

- parent versions
- merge/split history
- supersession graph
- reason code

### 4.5 Add quarantine and source policy

Low-trust memory must be segregated.

Required policy fields:

- source trust tier
- privacy classification
- tenant scope
- poison risk
- verification state
- approval requirement

Required actions:

- quarantine
- require-human-approval
- require-second-source
- soft-store-with-abstain-only

## 5. Proof Stack Required For Category Leadership

### 5.1 External benchmark program

Implement:

- `benchmarks/external/longmemeval/`
- `benchmarks/external/locomo/`
- `benchmarks/external/operations/`
- `benchmarks/external/cost/`
- `benchmarks/external/ablations/`

Release gate must publish:

- dataset version
- prompt templates
- model version
- embedding version
- hardware/runtime profile
- raw outputs
- scoring script version
- summary tables

### 5.2 Ablation matrix

Audrey cannot claim a biological advantage unless each mechanism can be toggled and measured.

Required ablations:

- no consolidation
- no decay
- no contradiction handling
- no provenance-aware abstention
- no affect/context weighting
- no replay scheduler
- no utility scorer
- no temporal state graph
- no causal retrieval boost

Evaluate each on:

- LongMemEval capability breakdown
- LoCoMo
- operation benchmark
- cost/latency/storage overhead
- false-memory rate

### 5.3 Long-context comparison

Mandatory comparison groups:

- brute-force long-context baseline
- vector-only baseline
- hybrid lexical+vector baseline
- Hindsight-style retain/recall/reflect baseline
- Audrey full system

Compare under:

- equal token budget
- equal wall-clock budget
- equal update frequency

Required message:

- Audrey is not just more "biological"
- Audrey is better under change, cheaper to update, and safer to trust

## 6. Execution Order

### Phase A: Benchmark legitimacy first

Why first:

- without external proof, architecture work remains easy to dismiss

Tasks:

1. implement real LongMemEval adapter
2. implement real LoCoMo adapter
3. add artifact manifests and frozen run configs
4. add operations benchmark for update/overwrite/delete/merge/abstain
5. publish cost curves against long-context and simple memory baselines

Exit criteria:

- Audrey can run `npm run bench:external`
- results are reproducible on a clean machine
- README can truthfully present external benchmark numbers

### Phase B: Memory controller and typed object migration

Tasks:

1. add controller layer
2. split episode into trace/cell/scene
3. add lifecycle state machine
4. make all mutations controller-mediated
5. emit structured decision telemetry

Exit criteria:

- no write path bypasses controller
- every memory object carries lifecycle and provenance metadata

### Phase C: Temporal + causal + entity-state retrieval

Tasks:

1. add entity-state tables with validity windows
2. add query router
3. integrate causal links into recall ranking
4. expose state-history queries over REST/MCP/SDK

Exit criteria:

- Audrey answers "what was true when" from state memory, not text search
- causal queries outperform hybrid text retrieval baselines

### Phase D: Utility learning and replay scheduling

Tasks:

1. convert `usage_count` into reward signals
2. learn or heuristically update utility scores
3. partition replay into recent-fragile, schema-refresh, conflict-repair, and garbage-collection queues
4. use surprise and value delta to prioritize replay

Exit criteria:

- measured lift from utility-aware ranking
- replay budget measurably improves benchmark outcomes

### Phase E: Resource/multimodal memory

Tasks:

1. add `resource` memory type
2. persist artifact metadata and references
3. attach extractor outputs to resources
4. support retrieval plans that fuse artifact and textual memories

Exit criteria:

- Audrey can ground answers in files/tool outputs/artifacts, not just text memories

### Phase F: Governance and neutral trust

Tasks:

1. tenant isolation
2. audit log
3. retention/erasure enforcement
4. encryption integration hooks
5. third-party evaluation harness and replication guide

Exit criteria:

- enterprise objections shift from "is this serious?" to procurement and adoption questions

## 7. File-Level Starting Points In This Repo

Exploit existing assets instead of rewriting the system from scratch.

Primary surfaces:

- `src/audrey.js`
- `src/recall.js`
- `src/db.js`
- `src/consolidate.js`
- `src/decay.js`
- `src/causal.js`
- `src/confidence.js`
- `src/interference.js`
- `src/affect.js`
- `src/import.js`
- `benchmarks/run.js`
- `benchmarks/cases.js`
- `docs/benchmarking.md`
- `mcp-server/serve.js`
- `mcp-server/index.js`

Recommended insertion points:

- controller hooks around `encode`, `recall`, `consolidate`, `dream`
- schema changes in `src/db.js`
- benchmark adapters under `benchmarks/external`
- telemetry surfaces through REST `/analytics` and MCP status outputs

## 8. Do Not Waste Cycles On These Failure Modes

- do not spend another major cycle polishing README rhetoric without new proof
- do not present internal synthetic benchmarks as category-defining evidence
- do not add more memory "types" without a controller and routing policy
- do not overfit to single-vector similarity improvements
- do not let retrieval mutate stored memory by default
- do not keep calling the system "biological" unless the mechanism is measurable

## 9. Category-Winning Claim Audrey Should Eventually Earn

Not current claim. Target claim.

"Audrey is the first reproducibly benchmarked memory operating system for agents: typed, lifecycle-managed, utility-aware, temporally correct, causally grounded, and production-economical."

Do not claim this before the proof stack exists.

## 10. Immediate Next Moves

Execute in this order:

1. external benchmark adapters
2. ablation toggles for existing biological mechanisms
3. controller-layer scaffold
4. typed trace/cell/scene schema migration design
5. temporal entity-state model
6. utility-aware ranking
7. replay scheduler
8. resource memory

If an implementation choice does not improve one of:

- benchmark legitimacy
- controller coherence
- temporal correctness
- utility learning
- governance/economics

it is probably not on the critical path.
