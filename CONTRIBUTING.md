# Contributing

Audrey is a production-focused memory layer, so contributions should optimize for correctness, observability, and safe operations.

## Local Setup

```bash
npm ci
npm run build
npm test
npm run pack:check
```

Node `>=20` is required.

`npm test` runs the Vitest suite through `scripts/run-vitest.mjs`. A `globalSetup`
hook (`tests/setup/ensure-release-artifacts.js`) generates whatever benchmark
and paper JSON artifacts the release/publication integration tests read, so a
plain `npm test` is self-contained — it does not rebuild or run the full
benchmark and paper pipeline.

`npm run test:artifacts` is the separate, heavier script that regenerates every
benchmark and paper artifact for real (GuardBench, adapter self-tests, arXiv
source, submission bundles). Its benchmark steps are folded into all three
release gates (`release:gate`, `release:gate:sandbox`, `release:gate:paper`);
its paper steps (`paper:sync` onward) only run as part of `release:gate:paper`.
None of this is something you need to run for a normal contribution.

`npm run paper:sync` (only reachable through `release:gate:paper` or directly)
overwrites `README.md`, `docs/paper/07-evaluation.md`,
`docs/paper/audrey-paper-v1.md`, and `docs/paper/evidence-ledger.md` with
locally measured numbers. It is a maintainer step for cutting a release with
updated benchmark claims, not part of routine contribution — running it will
leave those four files modified with your machine's numbers.

## What Good Contributions Look Like

- Reproduce the bug or gap before changing code.
- Keep fixes narrow and behaviorally clear.
- Add or update tests for runtime changes.
- Preserve operator visibility: health, error messages, and recovery paths matter.
- Update documentation when public behavior changes.

## Pull Request Expectations

- Explain the problem, not just the code change.
- Include validation steps you actually ran.
- Call out any behavior changes, migration concerns, or operational risks.
- Do not mix unrelated refactors into a production fix.

## Areas Where Precision Matters Most

- MCP install and runtime behavior
- database migration and re-embedding
- vector/index health and recall correctness
- provider error handling
- durability and shutdown behavior

## Documentation Changes

If you update the README, examples, CLI behavior, or production guidance, keep those surfaces aligned:

- `README.md`
- `examples/`

## Reporting Problems

- Use the GitHub issue templates for bugs and feature requests.
- Use the security reporting path in [SECURITY.md](SECURITY.md) for vulnerabilities.
