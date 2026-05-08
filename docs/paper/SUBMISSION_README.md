# Submission README

## What's Complete

- Nine drafted body sections in `01-introduction.md` through `09-conclusion.md`.
- Consolidated Markdown master: `audrey-paper-v1.md`.
- Evidence ledger with 97 rows: `evidence-ledger.md`.
- Machine-readable claim register: `claim-register.json`.
- Machine-readable publication pack: `publication-pack.json`.
- Machine-readable browser launch plan: `browser-launch-plan.json`.
- Machine-readable browser launch results ledger: `browser-launch-results.json`.
- Machine-readable arXiv source package: `docs/paper/output/arxiv/`.
- Machine-readable arXiv compile report: `docs/paper/output/arxiv-compile-report.json`.
- Compiled arXiv PDF and compile log: `docs/paper/output/arxiv-compile/main.pdf`, `docs/paper/output/arxiv-compile/arxiv-compile.log`.
- Machine-readable paper submission bundle: `docs/paper/output/submission-bundle/`.
- Primary-source bibliography with 21 entries: `references.bib`.
- Verbatim repeated-failure demo transcript: `appendix-a-demo-transcript.md`.
- GuardBench Stage-A specification with scenario manifest, baselines, metrics, reproducibility contract, JSON schemas, and Stage-A/Stage-B boundary.
- Machine-readable GuardBench manifest schema: `benchmarks/schemas/guardbench-manifest.schema.json`.
- Machine-readable GuardBench summary schema: `benchmarks/schemas/guardbench-summary.schema.json`.
- Machine-readable GuardBench raw-output schema: `benchmarks/schemas/guardbench-raw.schema.json`.
- Machine-readable GuardBench external-run metadata schema with SHA-256 artifact hashes: `benchmarks/schemas/guardbench-external-run.schema.json`.
- Machine-readable GuardBench external dry-run matrix schema: `benchmarks/schemas/guardbench-external-dry-run.schema.json`.
- Machine-readable GuardBench external evidence verification schema: `benchmarks/schemas/guardbench-external-evidence.schema.json`.
- Machine-readable GuardBench conformance-card schema: `benchmarks/schemas/guardbench-conformance-card.schema.json`.
- Machine-readable GuardBench submission-manifest schema: `benchmarks/schemas/guardbench-submission-manifest.schema.json`.
- Machine-readable GuardBench leaderboard schema: `benchmarks/schemas/guardbench-leaderboard.schema.json`.
- Machine-readable GuardBench adapter self-test schema: `benchmarks/schemas/guardbench-adapter-self-test.schema.json`.
- Machine-readable GuardBench adapter registry schema: `benchmarks/schemas/guardbench-adapter-registry.schema.json`.
- Machine-readable GuardBench publication verifier schema: `benchmarks/schemas/guardbench-publication-verification.schema.json`.
- Machine-readable browser launch-plan schema: `docs/paper/browser-launch-plan.schema.json`.
- Machine-readable browser launch-results schema: `docs/paper/browser-launch-results.schema.json`.
- Machine-readable arXiv source-manifest schema: `docs/paper/arxiv-source.schema.json`.
- Machine-readable arXiv compile-report schema: `docs/paper/arxiv-compile-report.schema.json`.
- Machine-readable paper submission-bundle schema: `docs/paper/paper-submission-bundle.schema.json`.
- Standalone GuardBench artifact validator: `npm run bench:guard:validate`.
- Public artifact path normalizer and local absolute-path sweep: `benchmarks/public-paths.mjs`.
- Shareable GuardBench conformance-card generator: `npm run bench:guard:card`.
- Portable GuardBench submission-bundle generator: `npm run bench:guard:bundle`.
- Offline GuardBench submission-bundle verifier: `npm run bench:guard:bundle:verify`.
- Verified GuardBench leaderboard builder: `npm run bench:guard:leaderboard`.
- Adapter registry: `benchmarks/adapters/registry.json`.
- Adapter registry validator: `npm run bench:guard:adapter-registry:validate`.
- Adapter author kit: `benchmarks/adapter-kit.mjs`.
- Fast adapter module validator: `npm run bench:guard:adapter-module:validate`.
- External adapter self-test: `npm run bench:guard:adapter-self-test`.
- Saved adapter self-test validator: `npm run bench:guard:adapter-self-test:validate`.
- GuardBench publication artifact verifier: `npm run bench:guard:publication:verify`.
- External adapter dry-run matrix: `npm run bench:guard:external:dry-run`.
- External evidence verifier: `npm run bench:guard:external:evidence`.
- Strict external evidence gate for credentialed runs: `npm run bench:guard:external:evidence:strict`.
- Local comparative GuardBench runner with a passing 10-scenario Audrey Guard check via `npm run bench:guard:check`.
- Strict external GuardBench adapter contract via `node benchmarks/guardbench.js --adapter ./adapter.mjs --check`.
- External adapters: `benchmarks/adapters/mem0-platform.mjs` (requires runtime `MEM0_API_KEY`) and `benchmarks/adapters/zep-cloud.mjs` (requires runtime `ZEP_API_KEY`).
- External evidence-bundle runners: `npm run bench:guard:mem0` and `npm run bench:guard:zep` with dry-run metadata capture.
- Paper metric sync command: `npm run paper:sync`.
- Paper claim verifier: `npm run paper:claims`.
- Publication pack verifier: `npm run paper:publication-pack`.
- arXiv source-package generator: `npm run paper:arxiv`.
- arXiv source-package verifier: `npm run paper:arxiv:verify`.
- arXiv compile-report gate: `npm run paper:arxiv:compile`.
- Strict arXiv compile gate: `npm run paper:arxiv:compile:strict`.
- Browser launch-plan verifier: `npm run paper:launch-plan`.
- Browser launch-results verifier: `npm run paper:launch-results`.
- Strict browser launch-results gate: `npm run paper:launch-results:strict`.
- Paper submission-bundle generator: `npm run paper:bundle`.
- Paper submission-bundle verifier: `npm run paper:bundle:verify`.
- Paper artifact verifier: `npm run paper:verify`.
- Pending-aware 1.0 release readiness verifier: `npm run release:readiness`.
- Strict 1.0 release readiness verifier: `npm run release:readiness:strict`.
- Source-control release-state check inside `npm run release:readiness`.
- Live remote-head verification inside `npm run release:readiness`.
- npm registry/auth readiness check inside `npm run release:readiness`.
- Dry-run release cut planner: `npm run release:cut:plan`.
- Final release cut writer: `npm run release:cut:apply`.
- Python package release verifier: `npm run python:release:check`.
- Paper-aware release gate: `npm run release:gate:paper`.
- Stage-A scope is explicit: implemented Audrey evidence, existing performance snapshot, current regression gate output, local comparative GuardBench output, and deterministic demo transcript.

## arXiv Preprint v1 Checklist

1. Generate the deterministic TeX source package with `npm run paper:arxiv`.
2. Verify the generated source package with `npm run paper:arxiv:verify`.
3. Run `npm run paper:arxiv:compile`; it compiles with `tectonic`, `latexmk`, `pdflatex`/`bibtex`, or `uvx tecto` plus a local bundle proxy when present and otherwise records a pending toolchain blocker in `docs/paper/output/arxiv-compile-report.json`.
4. Preview the arXiv-compiled PDF in the browser before pressing final submit.
5. Confirm the workshop variant stays under the target page limit. arXiv can run longer; workshops often need approximately 9 body pages.
6. Upload to arXiv with `cs.AI` as the primary category and `cs.CR` as secondary.

## Pre-Submission Status - 2026-05-08

- Done: README benchmark table values now match `benchmarks/snapshots/perf-0.22.2.json` and Ledger `E28` is resolved.
- Done: Ledger `E25` was re-checked against the current repeated-failure demo at `mcp-server/index.ts:825-879`.
- Done: primary-source URLs in `references.bib` were re-checked live on 2026-05-08; all 21 entries were reachable. The MCP schema reference now points at the current `2025-11-25` schema page.
- Update 2026-05-12: `npm run bench:guard:check` now runs a local comparative GuardBench suite across Audrey Guard, no-memory, recent-window, vector-only, and FTS-only adapters. Audrey Guard passes 10/10 scenarios. The harness supports external ESM adapters, the first concrete Mem0 Platform adapter is implemented, the output bundle includes an artifact redaction sweep, and `npm run bench:guard:mem0 -- --dry-run` captures the live-run command and metadata without storing credentials. A live Mem0 run is still pending a runtime key (Ledger: E46-E51).
- Update 2026-05-13: the adapter registry now includes Zep Cloud. `benchmarks/adapters/zep-cloud.mjs` creates a benchmark user/session, writes scenario memory with `memory.add`, searches user graph memory with `graph.search`, deletes the benchmark user during cleanup, and is covered by module validation plus mocked REST-flow tests. A live Zep run is still pending a runtime key (Ledger: E77).
- Update 2026-05-13: `npm run bench:guard:external:dry-run` writes non-secret dry-run metadata for every runtime-env adapter in the registry and is included in the release gates so live-run readiness cannot silently drift (Ledger: E78).
- Update 2026-05-13: the external dry-run matrix is now schema-bound by `benchmarks/schemas/guardbench-external-dry-run.schema.json`, written to `benchmarks/output/external/guardbench-external-dry-run.json`, included in package dry-run contents, and validated by `paper:verify` (Ledger: E79).
- Update 2026-05-13: `npm run bench:guard:publication:verify` now checks the schema-bound external dry-run matrix alongside registry, module, self-test, artifacts, submission bundle, and leaderboard, so the one-command public benchmark verifier covers every current GuardBench readiness artifact (Ledger: E80).
- Update 2026-05-13: `npm run bench:guard:external:evidence` writes a schema-bound external evidence verification report at `benchmarks/output/external/guardbench-external-evidence.json`, reports Mem0/Zep as pending when only dry-run metadata exists, checks saved metadata for runtime credential leaks, and ships a strict mode that fails until credentialed live bundles pass (Ledger: E81).
- Update 2026-05-13: `docs/paper/claim-register.json` now records supported and pending public claims, and `npm run paper:claims` verifies claim text, forbidden overclaims, evidence files, GuardBench artifacts, and the external-score Stage-B boundary before publication (Ledger: E82).
- Update 2026-05-13: `docs/paper/publication-pack.json` now carries arXiv, Hacker News, Reddit, X, and LinkedIn launch copy, and `npm run paper:publication-pack` verifies character limits, required entries, claim IDs, forbidden overclaims, pending Mem0/Zep boundary language, and secret leakage before browser-based posting (Ledger: E83).
- Update 2026-05-13: `npm run paper:bundle` now writes `docs/paper/output/submission-bundle/` with paper files, claim and publication registers, GuardBench outputs, schemas, README/package metadata, and `paper-submission-manifest.json` hashes; `npm run paper:bundle:verify` checks the manifest, file hashes, required files, GuardBench snapshot, claim verifier, and publication-pack verifier before upload (Ledger: E84).
- Update 2026-05-13: `docs/paper/browser-launch-plan.json` now maps the verified publication copy to arXiv, Hacker News, Reddit, X, and LinkedIn browser targets, records current source URLs/rules checked on 2026-05-13, requires human login/captcha/manual rule checks where needed, and is verified by `npm run paper:launch-plan` before browser posting (Ledger: E85).
- Update 2026-05-13: `npm run paper:arxiv` now writes a deterministic arXiv TeX source package under `docs/paper/output/arxiv/`; `npm run paper:arxiv:verify` checks the manifest, hashes, bibliography count, converted citations, missing bib IDs, seeded-secret redaction, and absence of local absolute paths before browser upload (Ledger: E86).
- Update 2026-05-13: `docs/paper/browser-launch-results.json` now records the post-submit state for arXiv, Hacker News, Reddit, X, and LinkedIn targets. `npm run paper:launch-results` validates target alignment, post-submit URL hosts, completed checklist fields, blocker text, and leakage boundaries while allowing pending targets; `npm run paper:launch-results:strict` fails until every target has a submitted, operator-verified public URL (Ledger: E87).
- Update 2026-05-13: public GuardBench and paper bundle artifacts now normalize repo-local paths before writing saved JSON/Markdown and run a local absolute-path sweep in `bench:guard:publication:verify`, `bench:guard:bundle:verify`, `paper:bundle:verify`, and `paper:verify` (Ledger: E88).
- Update 2026-05-13: the X launch copy now reserves `reservedUrlChars: 24` for the final public artifact URL using the `x-counting-characters` source, and `paper:launch-results` rejects submitted artifact-url targets unless `artifactUrl` records the public paper or repo URL (Ledger: E89).
- Update 2026-05-13: `npm run release:readiness` now emits the pending-aware Audrey 1.0 prompt-to-artifact checklist, while `npm run release:readiness:strict` fails until the target version, Python artifacts, npm registry/auth readiness, PyPI publish readiness, browser publication URLs, live Mem0/Zep evidence, and package publish readiness are complete (Ledger: E90).
- Update 2026-05-13: `npm audit --omit=dev --audit-level=moderate` is clean after refreshing the transitive `protobufjs`/`@protobufjs/*` lockfile chain used through `onnxruntime-web` (Ledger: E91).
- Update 2026-05-13: `npm run release:cut:plan` now previews the exact 1.0 version/changelog edits with publishable release notes instead of TODO scaffolding, and `npm run release:cut:apply` writes them only when the final cut is intentional (Ledger: E92).
- Update 2026-05-13: `npm run python:release:check` now builds the Python wheel/sdist, verifies package metadata and typed package contents, checks for local path leakage, and runs `twine check`; release gates run it before package publishing checks (Ledger: E93).
- Update 2026-05-13: `npm run release:readiness` now also checks source-control release state: branch, upstream, origin push remote, ahead/behind count, clean working tree, and `v1.0.0` tag placement (Ledger: E94).
- Update 2026-05-13: `npm run release:readiness` now checks `audrey@1.0.0` on the npm registry and requires `npm whoami` when the version is still unpublished, so package publish readiness cannot pass from the version bump alone (Ledger: E95).
- Update 2026-05-13: `npm run release:readiness` now verifies the live `origin/<branch>` head with `git ls-remote`, retries through Git's OpenSSL backend when Windows Schannel fails with `SEC_E_NO_CREDENTIALS`, and blocks when the local tracking ref is stale (Ledger: E96).
- Update 2026-05-13: `npm run paper:arxiv:compile` now attempts a local TeX compile with `tectonic`, `latexmk`, `pdflatex`/`bibtex`, or `uvx tecto` through a local bundle proxy, writes the schema-bound `docs/paper/output/arxiv-compile-report.json`, and lets the release-readiness gate keep missing TeX tooling as an explicit pending blocker instead of an undocumented host gap (Ledger: E97).

## Final Upload Checks

- Re-run URL verification if the arXiv upload moves to a later day.
- Run `npm run paper:sync` after benchmark outputs change.
- Run `npm run paper:claims` before public posts or submissions.
- Run `npm run paper:publication-pack` before using the launch copy.
- Run `npm run paper:arxiv` before arXiv browser upload.
- Run `npm run paper:arxiv:verify` before arXiv browser upload.
- Run `npm run paper:arxiv:compile` before arXiv browser upload; run `npm run paper:arxiv:compile:strict` only when a supported TeX toolchain is installed and compile proof must be complete.
- Run `npm run paper:launch-plan` before opening browser submission targets.
- Run `npm run paper:launch-results` after any browser submission or skipped/failed target update.
- Run `npm run paper:launch-results:strict` only when you intend to prove every launch target has a recorded public result.
- Run `npm run paper:bundle` after `paper:sync` and before upload.
- Run `npm run paper:bundle:verify` before uploading `docs/paper/output/submission-bundle/`.
- Run `npm run paper:verify` after any benchmark or paper edit.
- Run `npm run release:readiness` to capture the current 1.0 checklist without hiding pending publish blockers.
- Run `npm run release:readiness:strict` only after version bump, committed/tagged source-control state, live remote-head verification, Python artifacts, npm registry/auth readiness, PyPI publish readiness, browser public URLs, and live Mem0/Zep evidence are complete.
- Run `npm run release:cut:plan -- --target-version 1.0.0 --json` before applying the final version/changelog bump.
- Run `npm run release:cut:apply -- --target-version 1.0.0` only when the final 1.0 cut is intentional, then confirm strict readiness sees no placeholder changelog markers.
- Run `npm run python:release:check` after the final version cut and before PyPI upload.
- Run `npm audit --omit=dev --audit-level=moderate` before publishing package artifacts.
- Run `npm run release:gate:paper` before publishing or submitting public claims.
- Compile `docs/paper/output/arxiv/main.tex` with a local TeX toolchain before final arXiv upload; on hosts without `tectonic`, `latexmk`, `pdflatex`/`bibtex`, or `uvx tecto`, `paper:arxiv:compile` records the blocker and strict readiness remains pending.
- Upload to arXiv with `cs.AI` as the primary category and `cs.CR` as secondary.
- Use `publication-pack.json` for the first HN, Reddit, X, and LinkedIn drafts after `paper:publication-pack` passes.
- Keep the first X post's `reservedUrlChars` budget intact when adding the final public artifact URL.
- Use `browser-launch-plan.json` for target order, login/captcha handling, manual platform-rule checks, and post-submit URL capture.
- Update `browser-launch-results.json` with returned public URLs or blockers after each browser action.
- Use `docs/paper/output/submission-bundle/` as the machine-readable browser/upload package after `paper:bundle:verify` passes.

## Stage-B Work for v2

- Run `npm run bench:guard:mem0` with a runtime `MEM0_API_KEY` and publish the output bundle.
- Run `npm run bench:guard:zep` with a runtime `ZEP_API_KEY` and publish the output bundle.
- Run `npm run bench:guard:external:evidence:strict` after both live bundles exist.
- Add adapters for additional external memory systems using the current GuardBench ESM adapter contract and verify each one with `npm run bench:guard:adapter-self-test -- --adapter <adapter.mjs>`.
- Add external per-scenario confusion matrices, expanded multi-secret redaction sweeps, machine-provenance latency tables, and raw output artifacts.
- Strip evidence-ledger references from prose after the GuardBench claim set is stable.
- Compress the body to approximately 7,000 words for workshop submission.

## Suggested Venue Order

1. arXiv preprint: immediate, no review gate, stakes priority date.
2. NeurIPS workshop on foundation models for decision making, memory and agents, or LLM systems, depending on accepted workshop calls.
3. EMNLP Industry Track if GuardBench results land before the deadline.
4. SOSP/OSDI as a stretch target after full GuardBench results across external systems are ready.
