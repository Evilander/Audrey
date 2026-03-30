# Audrey Production Readiness

Audrey is ready to be the memory layer inside a production agent system, but it is not a complete regulated-platform package by itself. Treat it as stateful infrastructure: pin providers, isolate tenants, monitor health, and wrap it with the controls your environment requires.

## Best Vertical Fit

### 1. Financial Services Operations

Best fit:

- Payments operations copilots
- Fraud and dispute investigation agents
- KYC/KYB review assistants
- Internal support agents that need durable incident and policy memory

Why Audrey fits:

- Contradiction tracking helps surface conflicting customer, tool, and policy evidence.
- Confidence scoring and source lineage make escalations more reviewable.
- Local SQLite storage keeps memory close to the application boundary.
- Dream-cycle consolidation turns repeated incidents into reusable operational principles.

Guardrails:

- Do not store PAN, CVV, raw bank credentials, or secrets in memory.
- Isolate memory stores by environment, customer, and business unit.
- Keep export and purge paths in your incident-response runbook.
- Add encryption at rest and backup retention outside Audrey.

### 2. Healthcare Operations

Best fit:

- Care coordination assistants
- Prior-authorization workflow agents
- Intake, referral, and scheduling copilots
- Internal knowledge assistants for clinical operations teams

Why Audrey fits:

- Longitudinal recall preserves operational context across multi-step handoffs.
- Private memories support role-specific context without making it part of public recall.
- Contradiction detection helps catch conflicting workflow instructions and stale operating assumptions.
- Local embeddings allow offline-first or reduced-data-egress deployments.

Guardrails:

- Audrey is not a medical device and should not be treated as a clinical decision engine.
- Use de-identified or minimum-necessary data unless the full deployment boundary is HIPAA-ready.
- Enforce access controls and audit logging in the host application, not just in Audrey.
- Separate patient-facing and staff-only memory scopes.

## Production Checklist

1. Pin `AUDREY_EMBEDDING_PROVIDER` and `AUDREY_LLM_PROVIDER` explicitly. Do not rely on key-based auto-detection in production.
2. Set a dedicated `AUDREY_DATA_DIR` per environment and per tenant boundary.
3. Add a health check that runs `npx audrey status --json --fail-on-unhealthy`.
4. Alert on `health.healthy=false` or `health.reembed_recommended=true`.
5. Schedule `npx audrey dream` during low-traffic windows so consolidation and decay stay current.
6. Backup the SQLite data directory before changing embedding dimensions or providers.
7. Treat re-embedding as a controlled maintenance action and validate with `npx audrey status`.
8. Keep API keys, bearer tokens, and raw credentials out of encoded memory content.
9. Decide whether `private` memories are allowed for your use case and document who can create them.
10. Add application-level encryption, access control, logging, and retention policies around Audrey.
11. On graceful shutdown paths, call `await brain.waitForIdle()` before `brain.close()` so tracked background work drains cleanly.

## Operations Commands

```bash
# Human-readable health
npx audrey status

# Monitoring-friendly health
npx audrey status --json

# Fail the process if the index is unhealthy or unreadable
npx audrey status --json --fail-on-unhealthy

# Nightly memory maintenance
npx audrey dream

# Repair vector/index drift after provider or dimension changes
npx audrey reembed
```

## Example Deployment Pattern

Use Audrey as a local sidecar to the agent service:

- One Audrey data directory per tenant or deployment shard
- Health checks wired to `status --json`
- Scheduled dream/reembed jobs
- Backups handled by the host platform
- Regulated-data filtering handled before `memory_encode`

That keeps Audrey focused on memory integrity while the host system owns compliance, tenancy, and transport security.
