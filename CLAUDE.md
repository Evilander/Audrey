# Audrey

## What This Is
Biological memory architecture SDK for AI agents. Node.js, ES modules, SQLite.

## Commands
- `npm test` — run all tests
- `npm run test:watch` — watch mode

## Architecture
- `src/db.js` — SQLite connection, schema, migrations
- `src/confidence.js` — compositional confidence formula
- `src/ulid.js` — time-sortable unique IDs
- `src/embedding.js` — pluggable embedding providers
- `src/encode.js` — episodic memory creation
- `src/recall.js` — confidence-weighted retrieval
- `src/validate.js` — contradiction detection, reinforcement
- `src/decay.js` — Ebbinghaus forgetting curves
- `src/consolidate.js` — episode → principle extraction
- `src/causal.js` — causal graph management
- `src/rollback.js` — consolidation undo
- `src/audrey.js` — main class, ties everything together
- `src/index.js` — barrel export

## Conventions
- ES modules only (import/export)
- All tests in `tests/` mirroring `src/` structure
- SQLite is canonical store, WAL mode
- Episodes are immutable (append-only)
- All functions are pure where possible, side effects isolated to db.js
