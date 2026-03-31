# Contributing

Audrey is a production-focused memory layer, so contributions should optimize for correctness, observability, and safe operations.

## Local Setup

```bash
npm ci
npm test
npm run pack:check
```

Node `>=20` is required.

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
- `docs/production-readiness.md`
- `examples/`

## Reporting Problems

- Use the GitHub issue templates for bugs and feature requests.
- Use the security reporting path in [SECURITY.md](SECURITY.md) for vulnerabilities.
