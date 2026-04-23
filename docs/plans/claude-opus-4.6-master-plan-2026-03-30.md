# Audrey Continuity Engine Master Plan For Claude Opus 4.6 - 2026-03-30

Audience: Claude Opus 4.6 or another frontier implementation agent continuing work in `B:\Projects\Claude\audrey\Audrey`.

Interpret this document as the canonical execution doctrine for the next major Audrey arc.
This is not marketing copy, not a human-friendly explainer, and not a lightweight product brief.
It is an implementation, positioning, research, and systems strategy document for building a category-defining memory runtime.

When this document conflicts with older roadmap prose, this document wins.

## 0. Hard Context

- Correct repo: `B:\Projects\Claude\audrey\Audrey`
- Do not work in the outer folder except to enter the nested repo.
- Current Audrey already ships:
  - MCP integration
  - CLI + hooks
  - REST server
  - JavaScript package
  - Python SDK
  - Docker path
  - local benchmark harness with retrieval + operations tracks
  - basic lifecycle hardening and recall diagnostics
- Current Audrey still does not own the category because its strongest primitives are not yet subordinated to one unmistakable systems thesis.

The next thesis must be stronger than "biologically inspired memory for agents."
That frame is descriptive, not destiny.

The next thesis is:

**Audrey is the continuity engine for machine selves.**

More precise form:

**Audrey is the runtime where an agent's beliefs, commitments, contradictions, habits, and repairs persist through time under explicit cost, trust, and identity constraints.**

The category is not "LLM memory."
The category is "persistent cognitive state infrastructure."

Commercial consequence should emerge as a second-order effect of scientific usefulness plus operational indispensability.
If Audrey becomes the obvious substrate for persistent agents, monetization follows naturally through hosted control planes, enterprise governance, benchmark leadership, agent-platform integrations, and premium observability.
Do not optimize for money directly. Optimize for unavoidable dependency.

## 1. Why Current Audrey Still Does Not Fully Break Out

Current Audrey is already materially better than the median memory wrapper.
That is not enough.

The remaining failure mode is structural:

- Audrey still reads as "a sophisticated memory library"
- users still evaluate it as "storage + retrieval + consolidation"
- the repo surface still centers commands and tools more than the cognitive substrate
- the benchmark story is good internal hygiene, but not yet indisputable external proof
- setup is dramatically better than many competitors, but not yet absurdly easy
- token economy is discussed, but not yet a first-class runtime invariant

The next breakthrough must unify five things that most projects keep separated:

1. persistent selfhood
2. controllable plasticity
3. token-economical recall
4. operator-grade usability
5. science-grade falsifiability

If any one of those five is missing, Audrey remains "clever."
If all five lock together, Audrey becomes standard-setting.

## 2. Core Breakthrough

The breakthrough is not a new memory type.
The breakthrough is not a new benchmark wrapper.
The breakthrough is not another graph layer.

The breakthrough is a change of primitive.

Stop treating memory as stored content.
Start treating Audrey as a machine for managing **belief state transitions under constraint**.

The stable object is not "note."
The stable object is not even "memory."
The stable object is:

- what the agent currently believes
- under what scope
- with what confidence
- because of which evidence
- under which identity commitments
- at what maintenance cost
- with what unresolved contradiction pressure
- and what would be required to change it

That means the unit of value is not recall accuracy.
The unit of value is:

**future regret avoided without identity corruption and without token waste**

This is the controlling equation for the entire runtime.

If Audrey stores something that does not reduce future regret, it should probably not exist.
If Audrey recalls something that increases token spend without altering the local decision surface, it is dead weight.
If Audrey updates a belief in a way that damages continuity, it is systemically wrong even if a narrow benchmark improves.

## 3. The New System Name Internally

Use one internal name consistently:

**Self Engine**

The Self Engine is the controller-governed layer that:

- ingests observations
- computes deltas against existing state
- updates beliefs under policy
- assembles task-bounded local minds
- tracks wounds, forks, commitments, and habits
- emits inspectable receipts and mutation traces

Audrey as a product can keep the Audrey name.
But the implementation north star should be the Self Engine.

## 4. Non-Negotiable Design Laws

These are not suggestions. They are rejection criteria.

### 4.1 Write law

No write without state delta.

Every incoming observation must answer:

- what changed
- why this changed enough to deserve persistence
- which existing beliefs were touched
- what future regret this write is expected to reduce
- what cost and contamination risk it introduces

If there is no meaningful delta, do not write a durable object.

### 4.2 Recall law

No recall without assembly.

Raw top-k retrieval is a candidate-generation step only.
Task answers should come from an assembled local mind constructed from multiple state classes.

### 4.3 Identity law

No identity mutation through ordinary observation flow.

Durable self-structure must live behind a higher-threshold policy.
Temporary observations do not get to casually rewrite what the agent is.

### 4.4 Contradiction law

No contradiction collapse by default.

Conflicts should remain live, scoped, and inspectable until enough evidence exists to resolve them.
A hallucinated forced resolution is worse than preserved tension.

### 4.5 Replay law

No stabilization without reuse or outcome evidence.

First writes are provisional.
Stability is earned.

### 4.6 Forgetting law

No forgetting without utility and risk accounting.

Deletion is a policy act, not a cleanup detail.

### 4.7 Token law

Every memory operation must justify its token footprint.

Audrey wins partly by reducing model-context spend, not by adding silent memory taxes.

### 4.8 Audit law

Every meaningful mutation must leave a reconstructable trace.

If an operator cannot inspect why a belief changed, Audrey does not deserve production trust.

## 5. The Novel Ontology

Do not overfit to the old episodic / semantic / procedural triplet.
Preserve backward compatibility, but do not let it define the future shape.

Adopt the following ontology as the target internal model.

### 5.1 `pulse`

The smallest ingestable perturbation.

Examples:

- a statement fragment
- a correction
- a tool result
- a file-derived claim
- a user preference signal
- a failure outcome
- a conflict event

Pulses are not durable truth.
They are input energy.

### 5.2 `lesion`

A registered instability or wound in the mind-state.

Examples:

- contradiction between old and new evidence
- failed procedure
- poisoned source
- unstable schema
- repeated correction on the same claim
- identity-conflicting instruction

Lesions are not errors to hide.
They are adaptation hotspots.

### 5.3 `strand`

A persistent worldline for one entity, relationship, workflow, project, system, or self-aspect.

The strand is where temporal continuity lives.

Examples:

- one user
- one deployment service
- one project
- one vendor relationship
- one persistent task
- one internal agent goal

### 5.4 `latch`

A currently active high-confidence constraint.

This is not metaphysical truth.
It is an active lock that should influence inference until displaced.

### 5.5 `fork`

A scoped divergence where incompatible states remain alive simultaneously.

Forks solve:

- conflicting reports
- role-specific truths
- environment-specific truths
- time-window differences
- ambiguous ownership

### 5.6 `attractor`

A compressed reusable regularity with low deliberation cost.

Attractors are what repeated experience turns into generalized bias or schema.

### 5.7 `reflex`

A procedure that has hardened enough to execute cheaply and reliably.

This is stronger than "semantic memory about how to do something."
This is near-automatic operational behavior.

### 5.8 `vow`

A protected long-horizon commitment in the identity partition.

Examples:

- user non-negotiable preferences
- role definitions
- safety boundaries
- persistent tone/style invariants
- mission commitments
- "this agent does not do X"

### 5.9 `ghost`

A superseded prior belief retained for explanation, rollback, audit, and longitudinal analysis.

### 5.10 `local_mind`

A temporary assembled decision-state for the current task.

Local mind is what should answer the query.
The global memory store should not answer the query directly.

## 6. The Architecture Shift

Current Audrey has strong methods.
It now needs a kernel.

The target execution model:

1. observations arrive
2. delta extraction computes candidate state changes
3. policy engine decides whether to ignore, write, fork, quarantine, or escalate
4. mutation log records the decision
5. replay scheduler revisits fragile and high-value structures
6. task recall assembles a bounded local mind
7. outcome feedback updates utility estimates and stability

That implies the following module family should be introduced.

## 7. Target Module Graph

Create these modules deliberately. Do not scatter logic.

- `src/kernel/observation-bus.js`
- `src/kernel/controller.js`
- `src/kernel/delta-extractor.js`
- `src/kernel/policy-engine.js`
- `src/kernel/identity-kernel.js`
- `src/kernel/tension-engine.js`
- `src/kernel/strand-manager.js`
- `src/kernel/local-mind.js`
- `src/kernel/replay-scheduler.js`
- `src/kernel/reconsolidator.js`
- `src/kernel/utility-estimator.js`
- `src/kernel/mutation-log.js`
- `src/kernel/transplant.js`
- `src/kernel/receipts.js`

Compatibility bridges:

- `src/compat/episodes-view.js`
- `src/compat/semantics-view.js`
- `src/compat/procedures-view.js`

The compatibility bridges let current public APIs survive while the kernel matures.

## 8. Data Model Changes

Target new tables or equivalent persisted structures:

- `pulses`
- `lesions`
- `strands`
- `latches`
- `forks`
- `attractors`
- `reflexes`
- `vows`
- `ghosts`
- `assemblies`
- `outcomes`
- `mutation_log`
- `resource_memory`
- `working_sets`

Additional fields to standardize across stateful objects:

- `scope`
- `confidence`
- `stability`
- `utility_score`
- `contradiction_pressure`
- `privacy_risk`
- `identity_weight`
- `observed_at`
- `valid_from`
- `valid_to`
- `source_provenance`
- `superseded_by`
- `quarantine_reason`

Absolute requirement:

The DB must support reconstruction of "mind as of time t."
Without time-travel introspection, Audrey cannot credibly become cognitive infrastructure.

## 9. Token Economy Doctrine

This is a first-class deliverable, not a perf-afterthought.

Audrey should aim to become the default memory system partly because it makes persistent agents cheaper to operate.

### 9.1 Token objective

Primary optimization target:

**decision_quality_per_token**

Minimize:

- write-time LLM usage
- recall-time context injection
- repeat summarization
- redundant replay
- unused semantic baggage in assembled context

while maximizing:

- decision improvement
- correction retention
- scoped-truth accuracy
- procedure reuse
- abstention quality

### 9.2 Required mechanisms

#### A. Query routing before retrieval

Every recall should start with cheap classification:

- identifier lookup
- preference lookup
- temporal state query
- procedural query
- causal diagnosis
- relationship query
- conflict-resolution query
- broad open-ended context request

Only then choose the retrieval path.

#### B. Candidate generation separate from assembly

Fast candidate generation can remain hybrid:

- FTS
- vector similarity
- recency
- tag/context filters
- multi-agent scope

But the expensive step is assembly, and assembly should be bounded by a strict token budget.

#### C. Local mind budgeter

Implement a token governor that allocates a context budget across:

- vows
- active strands
- relevant latches
- unresolved forks
- high-value lesions
- attractors
- reflexes
- ghost pointers only when explanation is requested

Budgeting should be utility-weighted, not fixed by category.

#### D. No raw replay of whole episodes by default

Episodes are archival material.
Most tasks should consume compressed state objects, not full textual transcripts.

#### E. Incremental summarization receipts

When a local mind is assembled, emit a compact receipt object:

- direct recalls used
- abstractions used
- inferred joins
- uncertainty zones
- omitted candidates due to budget

Receipts make assembly inspectable and enable future incremental reuse.

#### F. Outcome-weighted caching

If a local_mind assembly repeatedly succeeds for a task family, Audrey should cache the assembly recipe, not only the resulting text.

#### G. Claim-card default output

Default prompt-facing recall should not inject raw memories.

Default representation should be compact claim cards:

- `claim`
- `scope`
- `confidence`
- `provenance`
- `updated_at`
- `contradiction_state`

Only expand back to source traces when:

- the answer path requires it
- contradiction pressure is high
- the operator explicitly requests evidence expansion

#### H. Multi-tier model strategy

Use the cheapest sufficient model or no model at all for each stage:

- deterministic parsing and filters first
- embedding and lexical routing second
- small-model classification third
- expensive model only for high-regret promotion, contradiction repair, schema extraction, or reconsolidation

#### I. First-class budget knobs

Expose budget control on every major surface:

- `recall(query, { budget })`
- `dream({ tokenBudget })`
- `encode({ importanceHint, writeBudget })`
- CLI profiles such as `tiny`, `balanced`, and `research`

Operator defaults should fail closed when a budget would be exceeded.

#### J. Token ledger

Track token spend and write amplification in telemetry for:

- retrieval assembly
- promotion
- replay
- summarization
- contradiction repair
- trace expansion
- write rejection
- write acceptance

### 9.3 Token metrics Audrey must own

Add benchmark and production metrics for:

- tokens spent per write accepted
- tokens spent per write rejected
- tokens spent per successful recall
- tokens spent per corrected stale fact
- tokens spent per durable procedure formed
- utility gain per 1k tokens
- decision quality per 1k tokens
- regret reduction per 1k tokens
- average local_mind size by task family
- assembly omission rate under budget
- write amplification
- time to first useful memory

These metrics should become visible in docs, reports, and observatory surfaces.

### 9.4 Token anti-patterns to eliminate

- re-summarizing stable content every session
- injecting whole memory lists into prompts
- using one expensive model for all control decisions
- allowing reflection/dream cycles to scale linearly with memory mass
- letting dead or duplicated episodic detail survive indefinitely in prompt-facing surfaces

## 10. Ease-Of-Use Doctrine

If Audrey requires a high-ceremony setup, it will lose even if the architecture is superior.

Ease of use is not packaging polish. It is part of the moat.

The target is:

**A non-expert should obtain useful persistent memory in minutes, while an expert should be able to scale to governance-heavy deployments without leaving the Audrey ecosystem.**

### 10.1 Setup invariants

The default path must be:

- local
- offline-capable
- one command
- zero mandatory config files
- zero mandatory hosted keys
- obvious health signal
- obvious uninstall

Primary onboarding metric:

**first-run success in under 3 minutes**

### 10.2 Required UX surfaces

#### A. `doctor`

Add an explicit `npx audrey doctor` command.

It should validate:

- Node/runtime version
- SQLite access
- provider resolution
- hook installation status
- MCP registration status
- Docker availability
- Python SDK compatibility
- permissions and data-dir status
- benchmark asset freshness if relevant

This should become the first support primitive.

#### B. `init`

Add an opinionated `npx audrey init` flow.

It should produce:

- recommended mode selection
  - Claude hooks local mode
  - REST sidecar mode
  - Docker sidecar mode
  - SDK embedding mode
- resolved data directory
- mock/local/provider defaults
- optional API key generation for REST mode
- immediate post-init smoke checks

It should support named install modes instead of environment archaeology:

- `local-offline`
- `hosted-fast`
- `ci-mock`
- `sidecar-prod`

#### C. `quickstart` profile

Define one sanctioned quickstart profile:

- local embeddings
- mock or no-op LLM optionality
- one command to install
- one command to verify
- one command to uninstall

#### D. sidecar-first deployment

Treat Audrey sidecar deployment as the operational default for broader adoption.

Why:

- easier mental model
- decouples memory from application language
- supports JS, Python, and future clients uniformly
- makes observability and auth easier

#### E. copy-paste-safe snippets

Docs must show:

- local Claude flow
- Node app flow
- Python app flow
- Docker flow
- snapshot backup/restore flow

No doc path should require editorial inference.

### 10.3 Installation friction removal backlog

Mandatory near-term work:

1. add `doctor`
2. add `init`
3. add explicit install presets (`local-offline`, `hosted-fast`, `ci-mock`, `sidecar-prod`)
4. ship `.env.example` and `.env.docker.example`
5. add first-run smoke command in README
6. add one-command mock-provider startup
7. add portable data-dir guidance per platform
8. add explicit migration diagnostics for version upgrades
9. add GHCR image publishing and image signing
10. add cross-platform install tests
11. make error messages operator-literate rather than implementation-literate

### 10.4 Adoption theorem

Audrey becomes standard when teams no longer ask:

- "How do I host it?"
- "How do I migrate it?"
- "How do I secure it?"
- "How do I know it is working?"
- "How do I integrate it from my stack?"

and instead ask:

- "Which Audrey mode should I use?"

That is the threshold where a project stops being optional.

## 11. Scientific Contribution Doctrine

Audrey should contribute to the field by making persistent cognition experimentally legible.

The contribution is not "we used biology words."
The contribution is:

- a stronger state ontology
- a controller-centered theory of memory operations
- falsifiable metrics for continuity and repair
- open experimental protocols for long-horizon agent memory

### 11.1 Claim Audrey should eventually own

**Persistent agents should be evaluated on continuity quality, not only retrieval quality.**

This is the conceptual contribution.

### 11.2 Metrics Audrey should introduce

At minimum, define and publish:

#### A. Future regret reduction

How much downstream error or rework did the memory state prevent?

#### B. Self-drift index

How much did the agent's protected identity partition change under irrelevant or adversarial pressure?

#### C. Contradiction half-life

How long do unresolved conflicts persist before correct repair?

#### D. Repair latency

How many interactions does it take for Audrey to correctly update stale state after correction?

#### E. Scoped-truth accuracy

Can the system preserve different truths across times, roles, or environments without leakage?

#### F. Transplant fidelity

Can a bounded mind-state be moved into another agent and preserve intended vows/reflexes/strands without importing contamination?

#### G. Utility per token

How much measurable decision quality improvement results from a given token budget?

### 11.3 Experiments Audrey should run

#### A. Twin divergence experiment

Two identical seeds.
Different lived histories.
Measure:

- behavioral divergence
- identity divergence
- transplant compatibility
- contradiction maps

#### B. Mind transplant experiment

Move a selected subset of vows/reflexes/strands into a second agent.
Measure:

- what transfers
- what should not transfer
- identity contamination
- repair cost

#### C. Contradiction persistence experiment

Inject controlled conflicting evidence and measure:

- whether Audrey preserves forks appropriately
- whether Audrey abstains when it should
- whether Audrey collapses conflict too early

#### D. Maturation experiment

Same agent over long horizon.
Measure:

- reduced token usage over time
- improved task performance
- procedure formation
- schema extraction
- lower contradiction load

#### E. Poison resistance experiment

Introduce bad evidence from mixed trust sources.
Measure:

- quarantine rate
- erroneous adoption rate
- repair latency
- ghost trace quality

### 11.4 Benchmark doctrine

Audrey must not stop at internal evals.

The full benchmark stack must include:

- local retrieval suite
- local operations suite
- cost/latency/storage suite
- LongMemEval adapter
- LoCoMo adapter
- continuity-specific experimental suite introduced by Audrey

The local suites protect regression hygiene.
The external suites protect credibility.
The continuity suite defines the new category.

## 12. Viral Path Doctrine

Virality will not come from benchmark charts alone.
It will come from making cognitive change visible and emotionally intelligible.

The public still has not seen an AI mind in a way that feels inspectable and real.
Audrey can be the first system to make internal cognitive surgery legible.

### 12.1 Primary viral artifacts

#### A. Mind surgery replay

Timeline of belief birth, reinforcement, contradiction spike, fork formation, repair, and ghosting.

#### B. Twin selves

Same model, same seed, different histories, visibly different selves.

#### C. Belief autopsy

After a failure, Audrey shows the internal causal chain:

- which vow constrained the action
- which lesion was unresolved
- which strand carried stale state
- which attractor or reflex over-fired

#### D. Memory transplant

Move selected mind-state from one agent to another and show what persists.

#### E. Aging curve

Day 1 vs day 30 vs day 180.
Show:

- fewer tokens
- better judgment
- stronger habits
- fewer raw recalls
- more stable identity

### 12.2 Product surfaces that support virality

The viral path requires a UI layer, not only a runtime.

That UI should become:

**Audrey Lens**

Lens should expose:

- belief timeline
- lesion map
- fork browser
- vow registry
- reflex formation log
- mind diff
- transplant planner
- task-local mind inspector
- token burn vs utility charts

Lens is not optional polish.
Lens is how people perceive that Audrey is qualitatively different.

## 13. Product Stack To Build

Audrey should separate into four conceptual products, even if they initially live in one repo.

### 13.1 Audrey Kernel

The runtime for persistent cognitive state.

Responsibilities:

- storage
- mutation policy
- replay
- assembly
- telemetry
- SDK + API surfaces

### 13.2 Audrey Lens

The observability and debugging surface.

Responsibilities:

- inspect state
- inspect transitions
- compare minds
- audit privacy and risk
- debug failures
- demonstrate cognition publicly

### 13.3 Audrey Spec

The portable exchange and object model.

Responsibilities:

- JSON schema for mind-state objects
- transplant format
- mutation log format
- diff format
- identity partition semantics
- scope and validity semantics

### 13.4 Audrey Bench

The proof system.

Responsibilities:

- local suites
- external adapters
- continuity experiments
- report generation
- cost curves
- leaderboard artifacts

If Audrey owns Kernel + Lens + Spec + Bench, it stops being a library and becomes infrastructure.

## 14. Updated Roadmap

This roadmap is ordered by dependency, not by glamour.

### Phase 0: Contact-quality and friction collapse

Goal: make Audrey absurdly easy to try, validate, and deploy.

Deliverables:

- `npx audrey doctor`
- `npx audrey init`
- named install presets
- `.env.example`
- `.env.docker.example`
- documented mock-provider profile
- GHCR publish workflow
- version alignment across npm, PyPI, and container artifacts
- explicit install-smoke commands for Node, MCP, Python, and Docker
- operator-readable diagnostics everywhere

Files likely touched:

- `mcp-server/index.js`
- `mcp-server/serve.js`
- `README.md`
- `docs/production-readiness.md`
- `.github/workflows/ci.yml`
- `package.json`
- `python/README.md`

Success condition:

new user reaches working state in under 3 minutes for the common path and under 10 minutes for every blessed path, without interpretive debugging.

### Phase 1: Mutation log and controller foundation

Goal: no significant write or replay path bypasses central policy.

Deliverables:

- `mutation_log`
- `controller.js`
- decision telemetry on encode/consolidate/dream/restore flows
- hidden shadow-mode policy outputs exposed in tests and diagnostics

Files likely touched:

- `src/audrey.js`
- `src/encode.js`
- `src/consolidate.js`
- `src/decay.js`
- `src/import.js`
- `src/export.js`
- new `src/kernel/*`

Success condition:

every accepted or rejected durable write can explain itself.

### Phase 2: Identity partition and vows

Goal: distinguish self-structure from ordinary learned facts.

Deliverables:

- `vows` storage
- privileged mutation path
- identity weight scoring
- user-visible vow management APIs
- refusal to mutate vows through ordinary low-confidence observation flow

Success condition:

protected preferences and role commitments stop drifting under noisy experience.

### Phase 3: Lesions, forks, and contradiction pressure

Goal: make unresolved instability first-class.

Deliverables:

- `lesions`
- `forks`
- contradiction propagation rules
- scoped abstention behavior
- repair workflows

Success condition:

Audrey preserves uncertainty honestly and repairs it transparently.

### Phase 4: Strands and temporal state

Goal: represent what is true when, for whom, and under what circumstances.

Deliverables:

- `strands`
- validity intervals
- supersession chains
- ghost objects
- time-sliced mind reconstruction

Success condition:

Audrey can answer temporal state questions without flattening history.

### Phase 5: Local mind assembly and receipts

Goal: answer queries from bounded assembled state, not raw retrieval lists.

Deliverables:

- `local_mind`
- assembly policies
- assembly receipts
- candidate omission accounting
- token budgets per task family

Success condition:

recall becomes cheaper, more structured, and more inspectable than current top-k surfaces.

### Phase 6: Utility learning and outcome-coupled plasticity

Goal: memory quality improves through consequences, not only exposure.

Deliverables:

- `outcomes`
- utility estimator
- reflex promotion/demotion
- latch stabilization rules
- reward/failure weighted replay priority

Success condition:

useful memories become cheaper and stronger; useless memories die.

### Phase 7: Lens

Goal: visible cognition.

Deliverables:

- belief timeline
- lesion map
- fork browser
- vow registry
- mind diff
- transplant preview
- token-vs-utility dashboards

Success condition:

engineers and non-engineers can both see why Audrey is different in minutes.

### Phase 8: Spec and transplant format

Goal: Audrey-native minds become portable.

Deliverables:

- object schema
- diff schema
- transplant format
- cross-agent import/export semantics
- compatibility guarantees

Success condition:

third-party frameworks can become Audrey-native without forking Audrey internals.

### Phase 9: External benchmark proof

Goal: indisputable public evidence.

Deliverables:

- first-party LongMemEval adapter
- first-party LoCoMo adapter
- reproducible artifacts
- continuity suite paper/report
- cost and latency curves

Success condition:

Audrey stops asking for attention and starts receiving it by necessity.

## 15. Code-Approach Details

### 15.1 Compatibility strategy

Do not break the current public surface immediately.

Preserve:

- `Audrey.encode`
- `Audrey.recall`
- `Audrey.dream`
- `Audrey.consolidate`
- `Audrey.status`
- CLI, MCP, REST, Python SDK

Internally:

- route methods through the controller
- shadow-write new structures first
- keep legacy tables as projections during transition
- compare legacy recall and local_mind assembly before cutover

### 15.2 Migration strategy

Migration should happen in four passes:

1. add new tables and write telemetry with no behavior change
2. shadow-write new ontology while preserving old behavior
3. run dual recall in diagnostics mode and compare outputs
4. switch default recall to local_mind assembly after benchmark superiority is demonstrated

### 15.3 API strategy

Add advanced API modes without destroying simple ones.

Example recall response expansion:

- default mode: current friendly compact result
- advanced mode:
  - `results`
  - `assembly_receipt`
  - `partialFailure`
  - `omittedCandidates`
  - `localMindSummary`
  - `tokenBudget`
  - `contradictionPressure`

### 15.4 Replay strategy

Replay must become stratified:

- `fragile_replay`
- `schema_refresh`
- `conflict_repair`
- `garbage_collection`
- `procedure_strengthening`

Different jobs need different budgets and triggers.

### 15.5 Resource-memory strategy

Introduce artifact-grounded memory envelopes for:

- files
- screenshots
- URLs
- tables
- tool outputs
- structured JSON artifacts

Every abstraction derived from a resource should preserve provenance links back to the artifact.

## 16. Business Consequence Without Corrupting The Thesis

Do not design Audrey as a money grab.
Design it so that the field and the market both have to route through it.

The durable business wedge is:

- open core state model and benchmark layer
- premium control plane / Lens / hosted orchestration
- enterprise governance, observability, and deployment
- premium benchmark labs and certification
- managed memory fleets for teams and agents

But all of that only works if the core product is genuinely category-defining.

Therefore:

- science contribution is not charity work relative to monetization
- ease of use is not separate from monetization
- token efficiency is not a perf detail

All three are the economic engine.

## 17. Immediate Next Execution Order

For the next serious implementation cycle, do this exact order:

1. add `doctor` and `init`
2. add `mutation_log`
3. route write/replay paths through controller telemetry
4. add `vows` and identity partition
5. add `lesions` and contradiction pressure
6. add `strands` and temporal validity
7. add `ghosts` and supersession chains
8. implement local_mind assembly
9. add token governor and assembly receipts
10. add `outcomes` and utility estimator
11. add Lens foundations
12. add transplant/spec groundwork
13. add external benchmark adapters

Do not invert that order.
The front half creates the true kernel.
The back half makes it visible, portable, and undeniable.

## 18. Definition Of Success

Audrey should be considered on-track for category leadership only when all of the following are true:

1. setup takes minutes, not hours
2. operators can inspect why state changed
3. token spend trends downward as the agent matures
4. identity does not drift under ordinary noise
5. contradictions remain explicit until resolved
6. temporal truths remain scoped correctly
7. procedures form from experience rather than being hand-authored only
8. the Lens surface makes cognitive change publicly legible
9. external benchmark claims are reproducible
10. transplant and diff semantics exist

## 19. Final Directive

Do not chase the mean.
Do not ship another "smart memory layer."
Do not mistake added retrieval modes for category creation.

Build the first runtime where an agent can:

- remember
- doubt
- change
- explain
- mature
- preserve identity
- expose its own internal repairs

That is the thing that contributes to science, creates the viral surface, and becomes commercially inevitable.

Everything else is subordinate.
