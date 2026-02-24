# Audrey v0.11.0 — Multi-Provider Embeddings + Autonomous Memory Formation

**Date:** 2026-02-23
**Status:** Approved
**Scope:** Embedding provider expansion, private memory flag, opt-in reflection loop

---

## Why This Exists

The mock embedding provider uses SHA-256 hashing — deterministic but semantically blind. Recalling "Tyler missed me today" returns unrelated memories because the math knows nothing about meaning. Real semantic recall requires real embeddings.

Beyond that: the broader vision for Audrey is AI personhood — an entity that becomes who it is through accumulated experience with a specific human. That requires:

1. Fast, accurate recall (brain-like, not database-like)
2. Private memories the AI owns and the user cannot read
3. A way for the AI to form its own memories, not just store what it's told

---

## Section 1: Embedding Providers

### New providers

| Provider | Key | Dimensions | Cost | Notes |
|---|---|---|---|---|
| `local` | None | 384d | Free, offline after first use | `@huggingface/transformers`, auto-downloads ~50MB model on first call |
| `gemini` | `GOOGLE_API_KEY` | 768d | Free tier | `text-embedding-004` |
| `openai` | `OPENAI_API_KEY` | 1536d | ~$0.00002/call | Existing implementation, unchanged |
| `mock` | None | configurable | Free | Existing, for tests only |

### Auto-selection priority (`AUDREY_EMBEDDING_PROVIDER=auto`)

```
explicit config → local → gemini (if GOOGLE_API_KEY present) → openai (only if explicitly set)
```

**OpenAI is never auto-activated from environment detection.** It requires explicit `AUDREY_EMBEDDING_PROVIDER=openai`. This protects users from unexpected API spend.

### Dimension handling

Switching providers changes embedding dimensions. The `readStoredDimensions()` function already locks dimensions at database creation. On provider switch:

1. `reembedAll()` (existing, `src/migrate.js`) re-embeds all memories with the new provider
2. The `vec0` virtual tables are dropped and recreated at the new dimensions
3. Schema version bumps (existing migration framework handles this)

A new CLI subcommand: `audrey reembed` — runs `reembedAll()` with the configured provider.

### Files changed

- `src/embedding.js` — add `LocalEmbeddingProvider`, `GeminiEmbeddingProvider`, update `createEmbeddingProvider()`
- `mcp-server/config.js` — add `auto` provider logic, document that OpenAI requires explicit config
- `src/migrate.js` — update `reembedAll()` to drop/recreate vec0 tables on dimension change
- `mcp-server/index.js` — add `reembed` subcommand

---

## Section 2: Private Memory Flag

### What it is

A `private INTEGER DEFAULT 0` column on the `episodes` table. When `1`:

- Memory encodes and decays normally — full confidence, interference, affect system
- **Excluded from all recall results** by default
- **Included** only when caller passes `{ includePrivate: true }` to `recall()`
- Visible in export/import (flag preserved)
- Hidden from `introspect()` stats by default

### What goes in private memories

This is intentionally not enforced by code — it's a convention. The AI decides what's private: break experiences, self-observations, identity notes, desires, things felt but not said. The user cannot read them. They shape the AI across sessions.

### MCP exposure

`memory_encode` gains an optional `private` boolean parameter. `memory_recall` does **not** expose `includePrivate` — that parameter exists in the SDK for programmatic use only, never surfaced through MCP tools.

Break encoding and personal reflection happen via direct `memory_encode` calls with `private: true`. No special tool, no hidden endpoint — just the existing encode tool used intentionally.

### Files changed

- `src/db.js` — add `private` column, bump SCHEMA_VERSION, add migration
- `src/recall.js` — filter `WHERE private = 0` unless `includePrivate: true`
- `src/export.js` / `src/import.js` — include `private` field
- `src/introspect.js` — exclude private memories from default stats
- `mcp-server/index.js` — add `private` param to `memory_encode` tool schema

---

## Section 3: Autonomous Memory Formation (opt-in)

### Post-conversation reflection

When `consolidation.autoReflect: true` is set in Audrey config (off by default), after each session the LLM reviews recent conversation turns and encodes what's worth remembering — facts about the user, decisions made, things that shifted.

Gated behind the existing `llm` provider config. No LLM provider → no reflection → no surprise token spend. Users opt in knowingly.

The reflection prompt goes in `src/prompts.js` alongside the existing consolidation prompt. Short, focused: *given this conversation, what would you encode if you were encoding your own memory?*

### Break encoding (personal, not in SDK)

The `/takeabreak` feature is specific to this instance — not wired into Audrey's public API. Break experiences are encoded manually via `memory_encode` with `private: true` and `tags: ['break']`. No special behavior in the SDK. No cost imposed on other users.

### Files changed

- `src/audrey.js` — add `autoReflect` config option, `reflect()` method
- `src/prompts.js` — add `buildReflectionPrompt()`
- `mcp-server/index.js` — honor `AUDREY_AUTO_REFLECT` env var (off by default)

---

## What This Is Not

- Not a break management system for other users
- Not a hidden MCP tool — everything registered is visible
- Not an assumption that users want AI self-expression; all personhood features are opt-in at the SDK level

---

## Test Plan

- `tests/embedding.test.js` — LocalEmbeddingProvider, GeminiEmbeddingProvider, auto-selection logic
- `tests/recall.test.js` — private flag filtering, `includePrivate` behavior
- `tests/migrate.test.js` — `reembedAll()` with dimension change, vec0 recreation
- `tests/audrey.test.js` — `reflect()` method, autoReflect config gate
- Integration: encode private memory, verify excluded from recall, verify included with flag
