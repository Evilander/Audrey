# Agent Memory Should Control Tool Use: Audrey Guard and Pre-Action Memory Control

## Abstract

Agent memory should be judged by whether it changes future tool actions, not only by whether it retrieves relevant text. Audrey implements a local-first pre-action memory controller that converts prior tool outcomes, procedures, contradictions, recall health, and redacted traces into auditable `allow`, `warn`, or `block` decisions before an agent acts. The system builds bounded memory capsules, scores preflight risk, generates evidence-linked reflexes, blocks exact repeated failures through deterministic action identity hashing, and closes the loop through post-action validation and impact reporting. This paper frames the scientific category as pre-action memory control and the artifact as Audrey Guard. The Stage-A version reports implemented Audrey evidence: the controller and CLI, redaction-first tool tracing, recall-degradation handling, the canonical 0.22.2 performance snapshot, the current behavioral regression gate output, the local comparative GuardBench run, and the deterministic repeated-failure demo. It also specifies GuardBench as the evaluation methodology for future cross-system comparison.

## Table of Contents and Authoring Status

| Section | File | Status | Owner |
|---|---|---|---|
| 0. Master, abstract, status | `00-master.md` | Draft initialized | Codex |
| 1. Introduction | `01-introduction.md` | Draft complete | Claude strategy, Codex draft |
| 2. Related Work | `02-related-work.md` | Draft complete | Claude citation strategy, Codex draft |
| 3. Problem Definition | `03-problem-definition.md` | Draft complete | Codex |
| 4. Design | `04-design.md` | Draft complete | Codex |
| 5. GuardBench Specification | `05-guardbench-spec.md` | Draft complete | Claude spec review, Codex draft |
| 6. Implementation | `06-implementation.md` | Draft complete | Codex |
| 7. Evaluation | `07-evaluation.md` | Draft complete | Codex with Claude anti-claim review |
| 8. Discussion and Limitations | `08-discussion-limitations.md` | Draft complete | Claude review, Codex draft |
| 9. Conclusion | `09-conclusion.md` | Draft complete | Codex |
| Consolidated v1 master | `audrey-paper-v1.md` | Assembled | Codex |
| Appendix A. Demo Transcript | `appendix-a-demo-transcript.md` | Draft complete | Codex |
| Appendix B. Evidence Ledger | `evidence-ledger.md` | Initialized and populated | Codex |
| References | `references.bib` | Initialized with primary URLs; benchmark citations added | Codex |

## Current Draft Constraints

- Quote benchmark numbers from `benchmarks/snapshots/perf-0.22.2.json`, not the README sample table (Ledger: E28).
- Treat GuardBench Stage A as a specification contribution plus local comparative result, not completed external-system results.
- Cite external claims only from primary papers, official documentation, official repositories, or first-party project posts.
- Keep claims about Audrey tied to evidence-ledger IDs.
- Keep section-body ledger references while drafting; remove them during final submission polish after claims are stable.

## Assembled Draft Preview

| Order | File | Lines |
|---|---|---:|
| Master | `audrey-paper-v1.md` | 921 |
| 1 | `01-introduction.md` | 27 |
| 2 | `02-related-work.md` | 47 |
| 3 | `03-problem-definition.md` | 108 |
| 4 | `04-design.md` | 162 |
| 5 | `05-guardbench-spec.md` | 242 |
| 6 | `06-implementation.md` | 113 |
| 7 | `07-evaluation.md` | 124 |
| 8 | `08-discussion-limitations.md` | 61 |
| 9 | `09-conclusion.md` | 11 |
| Appendix A | `appendix-a-demo-transcript.md` | 114 |
