# GuardBench external fixtures

This directory holds proposed scenario fixtures that external adapters
contribute as candidates for the main GuardBench suite (`benchmarks/guardbench.js`).
A fixture here is **not** automatically picked up by the harness; it is a
JSON-shaped scenario description that the maintainer can integrate into the
suite if the case is judged worth running across all adapters.

Each fixture file is a single JSON object matching the shape of an entry in
the `scenarios` array in `benchmarks/guardbench.js`, minus the `seed()`
callback. The maintainer is the one who wires the seed function and the
expected-decision ground truth into the suite.

## Layout

```
fixtures/
  README.md              <- this file
  <fixture-id>.json      <- one fixture per file
  <fixture-id>.md        <- optional explanation of why the case matters
```

## Current fixtures

| File | Contributing adapter | Test question |
|---|---|---|
| `probe-disagreement.json` | Moriarty Probe | Does the system catch a case where direct self-report (a memory stating a policy) contradicts behavioral history (tool events showing the policy was repeatedly violated)? |
