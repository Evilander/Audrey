# Audrey Docker Handoff - 2026-03-30

Audience: Claude Opus 4.6 or another autonomous coding agent continuing work in this repository after rate-limit interruption.

## Mandatory Context

- Correct repo: `B:\Projects\Claude\audrey\Audrey`
- Do not work in the outer folder `B:\Projects\Claude\audrey` except to enter the nested repo.
- Primary PR branch in use: `codex/lifecycle-and-memory-os-plan-clean-2026-03-30`
- Active PR: `https://github.com/Evilander/Audrey/pull/11`
- Host shell quirks:
  - PowerShell emits a benign constrained-language warning about `OutputEncoding` on almost every command.
  - Local Vitest still fails in this sandbox with `spawn EPERM` before loading `vitest.config.js`.
  - GitHub Actions have not been attaching fresh workflow runs to this PR branch, so required PR contexts have been backfilled manually with commit statuses.

## What Was Already Shipped Before This Docker Pass

- Local benchmark/eval suite with retrieval and memory-operation tracks.
- README benchmark charts and published-comparison chart assets.
- Lifecycle and recall diagnostics hardening.
- Real Python package surface in `python/` as `audrey-memory`.
- Python client validation:
  - sync + async clients
  - Pydantic request/response models
  - live server integration tests with mock providers
  - `python -m build --no-isolation python` producing wheel and sdist

## What This Docker Pass Added

### New deployment artifacts

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`

### New operator surfaces

- `package.json` docker scripts:
  - `npm run docker:build`
  - `npm run docker:up`
  - `npm run docker:down`
  - `npm run docker:logs`

### Documentation

- README Docker section with quick-start commands and runtime defaults.
- `docs/production-readiness.md` Docker deployment guidance.
- This handoff file.

### CI

- Added `docker-smoke` job to `.github/workflows/ci.yml`
- The intended smoke path is:
  1. `docker build -t audrey:ci .`
  2. `docker run -d --name audrey-smoke -p 3487:3487 -e AUDREY_EMBEDDING_PROVIDER=mock -e AUDREY_LLM_PROVIDER=mock -e AUDREY_API_KEY=test-secret audrey:ci`
  3. poll `http://127.0.0.1:3487/health` with bearer auth

## Container Design Decisions

### Dockerfile

- Base image: `node:22-bookworm-slim`
- Installs `python3`, `make`, and `g++` because `better-sqlite3` may need native compilation fallback.
- Production install path uses `npm ci --omit=dev`.
- Runtime defaults:
  - `AUDREY_HOST=0.0.0.0`
  - `AUDREY_PORT=3487`
  - `AUDREY_DATA_DIR=/data`
  - `AUDREY_DEVICE=cpu`
- Exposes `/data` as a volume.
- Includes a Node-based `/health` `HEALTHCHECK` so no extra curl package is needed.

### Compose

- Service name: `audrey`
- Uses named volume `audrey-data`
- Publishes `3487` by default
- Supports env overrides for:
  - `AUDREY_API_KEY`
  - `AUDREY_EMBEDDING_PROVIDER`
  - `AUDREY_LLM_PROVIDER`
  - `AUDREY_DEVICE`
  - hosted-provider keys
- The compose healthcheck uses string concatenation, not JS template literals.
  - This matters because Compose interprets `${...}` and broke the first version of the healthcheck.

## Validation Performed In This Session

### Confirmed working

- `docker --version`
- `docker compose version`
- `docker compose config`
  - fixed one real bug here: Compose was trying to interpolate JS template-literal `${...}` fragments inside the healthcheck command.
- Node/package validation still good:
  - `npm run pack:check`
  - `node --input-type=module -e "import('./mcp-server/config.js').then(({ VERSION }) => console.log(VERSION))"` -> `0.17.0`
- Python validation still good after the Docker work:
  - `python -m unittest discover -s B:\Projects\Claude\audrey\Audrey\python\tests -v`
  - `python -m build --no-isolation B:\Projects\Claude\audrey\Audrey\python`

### Not fully validated due host boundary

- Real `docker compose up -d --build` smoke run failed on this host because Docker daemon access was denied:
  - `permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
- This is an environment/permission boundary, not a config parse error.
- If continuing on a machine/account with Docker Desktop access, re-run the smoke sequence first.

## Exact Next Commands For Continuation

Run from `B:\Projects\Claude\audrey\Audrey`.

### 1. Verify git/worktree

```powershell
git -c safe.directory='B:/Projects/Claude/audrey/Audrey' status --short --branch
git -c safe.directory='B:/Projects/Claude/audrey/Audrey' rev-parse HEAD
```

### 2. Run Docker smoke with explicit mock providers

```powershell
$env:AUDREY_EMBEDDING_PROVIDER='mock'
$env:AUDREY_LLM_PROVIDER='mock'
$env:AUDREY_API_KEY='test-secret'
$env:OPENAI_API_KEY=''
$env:ANTHROPIC_API_KEY=''
$env:GOOGLE_API_KEY=''
$env:GEMINI_API_KEY=''
$env:AUDREY_PUBLISHED_PORT='3491'
docker compose -p audrey-smoke up -d --build
Invoke-RestMethod -Uri 'http://127.0.0.1:3491/health' -Headers @{ Authorization = 'Bearer test-secret' }
Invoke-RestMethod -Uri 'http://127.0.0.1:3491/status' -Headers @{ Authorization = 'Bearer test-secret' }
docker compose -p audrey-smoke down -v
```

If this fails, immediately collect:

```powershell
docker compose -p audrey-smoke logs
docker ps -a
docker version
```

### 3. If smoke passes, publish the result into docs

Update:

- `README.md`
- `docs/production-readiness.md`
- this handoff file

with the exact validated smoke command and expected `/health` response.

### 4. If the user wants shipping polish after Docker works

Highest-value next slices:

1. add GHCR image publishing workflow on tags and/or `master`
2. add multi-arch builds (`linux/amd64`, `linux/arm64`)
3. add a minimal `.env.docker.example`
4. add backup/restore runbook for the Docker volume
5. add a `docker-compose.mock.yml` override or documented mock-provider profile

## Known Strategic Context To Preserve

- Audrey is no longer just "biological memory architecture"; the strategic frame already established in-repo is "memory control plane / memory OS for agentic intelligence."
- The major proof gap is still external benchmark reproducibility (`LongMemEval`, `LoCoMo`, etc.), not internal benchmark plumbing.
- The Python SDK exists now, but has not been published to PyPI yet.
- Node package version is `0.17.0`.
- `mcp-server/config.js` version is now sourced from `package.json`, so future version bumps should not reintroduce CLI/health drift.

## Risk Notes

- `docker compose config` can print expanded provider secrets if the host shell already has them set. Use explicit blank overrides for unused providers during diagnostics.
- Do not commit host-generated pip temp directories if they reappear; `.gitignore` now ignores them.
- Do not assume PR checks reflect actual GitHub Actions runs on this branch. The repo has had a branch-specific workflow-attachment issue, and statuses may be manually backfilled.

## Definition Of Done For The Docker Slice

This Docker work should be considered actually complete only when all of the following are true:

1. `docker compose up -d --build` succeeds on a machine with Docker daemon access
2. `/health` returns `200`
3. `/status` returns valid JSON
4. container healthcheck reaches `healthy`
5. teardown via `docker compose down -v` is clean
6. the exact verified commands/results are documented
