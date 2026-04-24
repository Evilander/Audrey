# The Future of LLM Memory

Date: 2026-04-24
Audience: Audrey product strategy, technical roadmap, launch content

## Thesis

The next serious AI platform will not win because it has the longest context window. It will win because it remembers the right things, forgets the wrong things, proves why a memory matters, and carries learned behavior across tools, hosts, teams, and time.

The market has already accepted memory as a product category. Claude has project-scoped memory and Managed Agents memory. ChatGPT has saved memories and chat-history reference. Gemini has saved info and past-chat reference. Letta, Mem0, Zep/Graphiti, MemOS, and MIRIX all point toward the same conclusion: stateless agents are not enough.

Audrey's opening is not "we also have memory." The opening is:

> Audrey is the local-first memory control plane for every agent you run.

That means Audrey should become the inspectable, portable, host-neutral layer that turns work into durable memory, and memory into better behavior.

## What The Field Already Has

### Platform Memory

Claude introduced memory for teams and projects, with optional controls, editable summaries, incognito chats, and project separation. Anthropic also announced built-in memory for Claude Managed Agents on April 23, 2026, with filesystem-backed memories, exports, API management, audit logs, rollback, scoped stores, and multi-agent sharing.

OpenAI's ChatGPT memory exposes saved memories, chat-history reference, temporary chats, deletion controls, memory prioritization, and memory history/restore controls for supported plans.

Google Gemini has saved info and can reference past chats in supported accounts and contexts.

The user-facing lesson: users now expect assistants to remember.

The product gap: these memories are mostly locked inside each platform.

### Agent Framework Memory

Letta frames agents as stateful systems with memory blocks, archival memory, messages, tools, runs, and shared blocks. Mem0 focuses on scalable extraction and retrieval for production agents. Zep/Graphiti uses temporal knowledge graphs to track changing entity relationships. MemOS frames memory as an OS-managed resource with provenance and versioning. MIRIX uses multiple memory types and a multi-agent controller, including multimodal screen memory.

The infrastructure lesson: memory is becoming its own layer.

The product gap: no simple open standard lets a normal developer connect Codex, Claude Code, Claude Desktop, Cursor, Ollama, and internal agents to one controllable local memory runtime.

### Benchmarks

LoCoMo tests very long, multimodal conversations across sessions, temporal event graphs, and causal consistency. LongMemEval tests information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. Mem0's public benchmark work emphasizes token efficiency, latency, and cost, not just raw accuracy. New 2026 benchmarks like MemoryCD and Mem2ActBench push the field toward cross-domain lifelong personalization and memory-driven tool action.

The benchmark lesson: "it remembered a fact" is too shallow.

The product gap: operators need memory tests and regression gates they can run before trusting an agent with real workflows.

## What Humans Have Not Really Done Yet

This section is not claiming nobody has written a paper or prototype. It means these ideas are not yet common, packaged, trusted, and easy enough for normal teams to use.

### 1. A User-Owned Memory Passport

Current memory is platform-bound. ChatGPT remembers inside ChatGPT. Claude remembers inside Claude. A local Ollama agent remembers only if a developer builds memory for it.

Audrey can turn memory into a portable "passport":

- One user or team memory store that travels across Codex, Claude, Ollama, IDEs, and internal agents.
- Export/import as a first-class workflow, not an afterthought.
- Host-specific agent identities layered on top of shared memory.
- A visible "what this agent knows about me and this project" control panel.

Feature candidate:

- `npx audrey passport export`
- `npx audrey passport import`
- `npx audrey passport inspect --agent codex`
- `npx audrey passport diff --host claude-code --host codex`

Why it could be viral:

People are already frustrated that each AI starts over. "Bring your AI memory with you" is instantly understandable.

### 2. Git For Memory

Claude Managed Agents now highlight file-backed memories, audit logs, rollback, and redaction. That is a strong signal. But the broader agent ecosystem still lacks a developer-native model for memory branching and review.

Audrey can make memory feel like git:

- Diff memories before and after an agent session.
- Commit a memory state before risky work.
- Branch memory per project or customer.
- Merge lessons from one agent into another.
- Roll back bad memories without destroying the whole store.
- Review memory writes like code review.

Feature candidate:

- `npx audrey memory diff`
- `npx audrey memory commit -m "learn Windows EPERM workaround"`
- `npx audrey memory branch customer-acme`
- `npx audrey memory rollback <checkpoint>`

Why it matters:

The more powerful memory gets, the more teams need change control.

### 3. Memory As A Preflight Safety System

Most memory systems retrieve context after the user asks a question. The bigger opportunity is to use memory before the agent acts.

Audrey already has the seed of this with tool-trace memory. Repeated failures should become warnings before the agent retries the same risky operation.

Now shipping as the first concrete slice:

- MCP tool `memory_preflight`.
- MCP tool `memory_reflexes`.
- REST route `POST /v1/preflight`.
- REST route `POST /v1/reflexes`.
- SDK method `audrey.preflight(action, options)`.
- SDK method `audrey.reflexes(action, options)`.
- Response fields for decision, risk score, warnings, recommendations, evidence IDs, health, recent failures, optional event recording, and optional capsule context.
- Reflex reports that convert warnings into trigger-response rules an agent can automate before tool use.

Follow-on candidates:

- Before shell commands: "Have we broken this repo with this command before?"
- Before migrations: "Does memory say this environment lacks `wmic` or blocks temp writes?"
- Before package publishing: "What are the known release gates for this repo?"
- Before editing config: "Has this host config path been stale or write-protected?"

Why it could be viral:

A demo where Audrey stops an agent from repeating a known failure is more compelling than a chatbot remembering a favorite color.

### 4. Action Memory, Not Just Answer Memory

Mem2ActBench explicitly calls out a gap: benchmarks often test passive fact retrieval, while real agents need to apply memory to select tools and ground parameters. This is the difference between "I remember your CRM is HubSpot" and "I will call the HubSpot tool with the right pipeline, property names, and customer scope because that is how your business works."

Audrey should feature action memory:

- Tool preferences.
- Environment quirks.
- Known-safe command patterns.
- API parameter conventions.
- Repeated manual fixes.
- Customer-specific operational workflows.

Feature candidate:

- `memory_procedure_suggest`
- `memory_preflight`
- `memory_reflexes`
- `memory_action_context`
- "Before using this tool, Audrey recommends..."

Why it matters:

Small businesses do not need AI that remembers trivia. They need AI that remembers how work actually gets done.

### 5. Memory Regression Tests

Memory can silently get worse. A new embedding provider, schema migration, pruning rule, or prompt change can cause an agent to forget the exact thing that made it valuable.

Audrey should treat memory like tested infrastructure:

- Memory fixtures.
- Recall assertions.
- Capsule assertions.
- "Should not recall" tests for privacy and stale facts.
- Budget tests for token cost.
- Temporal tests for changed facts.

Feature candidate:

```bash
npx audrey eval add "What is the deploy command?" --expect "npm run deploy"
npx audrey eval run
npx audrey eval ci --fail-under 0.90
```

Why it matters:

This turns Audrey from a feature into infrastructure that teams can trust.

### 6. Permission-Aware Shared Memory For Teams

Research on collaborative memory is moving toward multi-user, multi-agent memory with dynamic access control, provenance, private fragments, shared fragments, and time-varying permissions.

Audrey's local-first story should include this, especially for small businesses:

- Owner memory.
- Employee memory.
- Customer memory.
- Project memory.
- Agent memory.
- Read/write scopes by host and role.

Feature candidate:

- `audrey://scopes`
- `memory_share --scope team --redact private`
- `memory_policy test --agent codex --user owner`

Why it matters:

Shared memory without access control becomes a liability. Access control without usability becomes shelfware.

### 7. A Preference Model That Learns From Weak Feedback

The 2026 VARS paper argues that agents need persistent user models and can learn retrieval preferences from weak scalar feedback, not just explicit "remember this" commands.

Audrey can support this without fine-tuning:

- Track when retrieved memories helped.
- Track when a user corrected the agent.
- Boost memories that reduce retries or shorten sessions.
- Decay memories that repeatedly fail to help.
- Separate long-term preferences from session-specific context.

Feature candidate:

- `memory_feedback`
- `memory_recall --learn-from-outcome`
- `memory_status --preference-drift`

Why it matters:

Good memory is not only what was said. It is what repeatedly proved useful.

### 8. Temporal Truth, Not Flat Facts

Zep/Graphiti's temporal graph work is a strong signal: real memory needs to know when a fact was true, what replaced it, and what evidence supports it.

Audrey should make this obvious:

- "Customer uses Stripe" may be true until they migrate to Square.
- "Run tests with Vitest" may be true in CI but false on a locked-down Windows host.
- "The README says `/docs` exists" may be stale after routes changed.

Feature candidate:

- `valid_from`, `valid_until`, `supersedes`, `superseded_by`.
- Memory conflict timelines.
- Capsule sections for "current truth" and "stale but relevant history."

Why it matters:

The most dangerous memory is a true fact from the wrong time.

### 9. Multimodal Operational Memory

MIRIX shows the importance of multimodal memory, including screenshots and visual context. Most practical agents still remember text far better than UI state, screenshots, invoices, dashboards, browser flows, and design assets.

Audrey could target operational multimodal memory:

- Website screenshots before and after optimization.
- CRM screenshots and field mappings.
- Error dialogs.
- Browser traces.
- Invoice images and extracted fields.
- Design screenshots tied to implementation notes.

Feature candidate:

- `memory_encode_asset`
- `memory_recall_assets`
- `audrey://recent-screens`
- Visual evidence inside Memory Capsules.

Why it matters:

Small-business work is visual and operational, not just chat text.

### 10. Memory Capsules As A Standard Handoff Artifact

Audrey's Memory Capsule is the right product surface: a compact, ranked, evidence-backed briefing for a specific task.

The opportunity is to make capsules portable:

- A Codex capsule before coding.
- A Claude capsule before planning.
- An Ollama capsule before a local answer.
- A CRM capsule before customer follow-up.
- A support capsule before replying to a ticket.

Feature candidate:

- `.audrey/capsules/<task>.md`
- `npx audrey capsule "shipping release" --format md`
- Capsule links in PRs, tickets, and handoff docs.

Why it could be viral:

"Paste this Memory Capsule into any LLM and it works like it knows the project" is a simple hook.

### 11. Memory Economics

Mem0 is pushing token efficiency as a production concern. Audrey should make memory economics visible:

- Tokens avoided.
- Repeated user explanations avoided.
- Failures prevented.
- Time saved by not rediscovering setup.
- Cost difference between full-context replay and selective recall.

Feature candidate:

- `npx audrey roi`
- `memory_status` with saved-token estimates.
- Tool-trace reports showing prevented repeat failures.

Why it matters:

Business buyers need a reason to pay. "Audrey saved 40 minutes and avoided three failed deploys this week" is a reason.

### 12. Sleep That Produces New Working Knowledge

Many systems summarize. Humans consolidate. Audrey's "dream" concept is stronger if it becomes visibly useful:

- Detect repeated failures.
- Turn patterns into procedures.
- Find contradictions.
- Promote stable lessons into rules.
- Archive low-value memories.
- Produce a morning briefing.

Feature candidate:

- `npx audrey dream --report`
- `npx audrey promote --target codex-rules`
- "Last night Audrey learned..."

Why it matters:

The public understands "AI that dreams on your work and wakes up smarter." The engineering version must stay honest: it is consolidation, contradiction detection, procedural learning, and decay.

## Audrey's Best Feature Bet

The single best over-the-top feature now shipping is:

> Memory Reflexes: before an agent acts, Audrey checks prior memories, tool traces, environment quirks, and project rules, then returns trigger-response guidance the host can automate.

Why this is the right bet:

- It uses Audrey's existing differentiators: tool traces, procedural memory, Memory Capsules, confidence, tags, and local host identity.
- It is easy to demonstrate.
- It works across Codex, Claude, and Ollama.
- It solves a real pain: agents repeat mistakes.
- It is more defensible than generic chat memory.

Demo script:

1. Run a command that fails on this Windows host because of a known `spawn EPERM`, temp-dir, or config-path issue.
2. Encode the failure through Audrey's tool trace path.
3. Start a new agent session.
4. Ask the agent to run the risky workflow again.
5. Audrey returns a reflex: "Before using npm test, review the prior EPERM failure path."
6. The agent avoids the repeated failure or switches to the known fallback validation path.

Tagline:

> Audrey gives AI agents memory before they act.

## Launch-Ready Content Angles

### Post 1: "Your AI Has Amnesia"

Hook:

Your AI can write code, call tools, browse docs, and deploy software. Then tomorrow it forgets the lesson it learned today.

Audrey angle:

Memory should be local, inspectable, portable, and testable.

### Post 2: "Context Windows Are Not Memory"

Hook:

A million-token context window is a bigger backpack. It is not a brain.

Audrey angle:

Real memory needs write policy, retrieval policy, forgetting, contradiction handling, source lineage, and regression tests.

### Post 3: "The Agent Black Box"

Hook:

When an AI agent makes a mistake, where does that mistake go?

Audrey angle:

Tool traces become procedural memory so agents avoid repeating preventable failures.

### Post 4: "Bring Your Memory"

Hook:

Every AI platform wants to remember you. None of them want your memory to leave.

Audrey angle:

Audrey is the local-first memory passport across Codex, Claude, Ollama, and internal agents.

### Post 5: "The Small Business Brain"

Hook:

Every small business has invisible operating knowledge: how quotes are written, which customers need special handling, what breaks on the website, and how the owner likes decisions made.

Audrey angle:

Audrey turns that invisible knowledge into a local memory layer for websites, CRMs, support agents, and back-office automation.

## Near-Term Audrey Roadmap

### 30 Days

- Add `npx audrey install --host codex|claude-code|claude-desktop|generic` with dry-run and backups.
- Add `npx audrey capsule "task" --format md|json`.
- Add richer Memory Preflight demos, policy modes, and tool classifiers.
- Add a Memory Capsule file exporter.
- Add docs and demos for "agent avoids repeated failure."

### 60 Days

- Add memory diff/checkpoint/rollback commands.
- Add memory eval fixtures and CI gates.
- Add temporal validity fields and supersession UI/API.
- Add first LoCoMo and LongMemEval adapters.
- Add a small-business CRM demo with customer memory, workflow memory, and tool preflight.

### 90 Days

- Add permission scopes for shared memory.
- Add feedback learning over recall outcomes.
- Add capsule sharing and signed export bundles.
- Add multimodal asset memory prototype.
- Add dashboard/reporting for ROI, failures prevented, and token budget.

## References

- Anthropic, "Bringing memory to Claude" (2025): https://claude.com/blog/memory
- Anthropic, "Built-in memory for Claude Managed Agents" (2026): https://claude.com/blog/claude-managed-agents-memory
- OpenAI Help, "Memory FAQ": https://help.openai.com/en/articles/8590148-memory-faq/
- Google Gemini Help, "Save info and reference past chats": https://support.google.com/gemini/answer/15637730
- Letta Docs, "Introduction to Stateful Agents": https://docs.letta.com/guides/core-concepts/stateful-agents
- Mem0, "Memory Evaluation": https://docs.mem0.ai/core-concepts/memory-evaluation
- Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory" (2025): https://arxiv.org/abs/2504.19413
- Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" (2025): https://arxiv.org/abs/2501.13956
- Li et al., "MemOS: A Memory OS for AI System" (2025): https://arxiv.org/abs/2507.03724
- Wang and Chen, "MIRIX: Multi-Agent Memory System for LLM-Based Agents" (2025): https://arxiv.org/abs/2507.07957
- Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory" (2025): https://arxiv.org/abs/2410.10813
- Maharana et al., "Evaluating Very Long-Term Conversational Memory of LLM Agents" (LoCoMo, 2024): https://arxiv.org/abs/2402.17753
- Hao et al., "User Preference Modeling for Conversational LLM Agents" (2026): https://arxiv.org/abs/2603.20939
- Zhang et al., "MemoryCD" (2026): https://openreview.net/forum?id=Lpq4aEqvmg
- Rezazadeh et al., "Collaborative Memory" (2026 submission): https://openreview.net/forum?id=pJUQ5YA98Z
- "Mem2ActBench" (2026 submission): https://openreview.net/forum?id=hiRJ90xzJY
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- Ollama tool calling: https://docs.ollama.com/capabilities/tool-calling
