# XConfess Deployment

This repo deploys as two apps plus managed services:

- `xconfess-backend`: NestJS API on port `5000`.
- `xconfess-frontend`: Next.js app on port `3000`.
- PostgreSQL: required.
- Redis: required when `ENABLE_BACKGROUND_JOBS=true`..

## Local Smoke Start

From the repo root:

```powershell
npm install
docker compose up -d postgres redis
npm run dev:backend
npm run dev:frontend
```,

Backend liveness:

```powershell
Invoke-WebRequest -Uri http://localhost:5000/api/health/live -UseBasicParsing
```

Backend readiness:

```powershell
Invoke-WebRequest -Uri http://localhost:5000/api/health/ready -UseBasicParsing
```

If Docker says the `dockerDesktopLinuxEngine` pipe does not exist, start Docker Desktop and make sure it is using Linux containers.

## Production Environment

Never deploy the local `.env` values. Generate real secrets and put them in your hosting provider's secret manager.

Required backend variables:

```env
NODE_ENV=production
APP_ENV=production
PORT=5000
FRONTEND_URL=https://your-frontend-domain
BACKEND_URL=https://your-backend-domain

DB_HOST=your-postgres-host
DB_PORT=5432
DB_USERNAME=your-postgres-user
DB_PASSWORD=your-postgres-password
DB_NAME=your-postgres-database
DB_READ_HOST=
DB_READ_PORT=
TYPEORM_SYNCHRONIZE=false
TYPEORM_MIGRATIONS_RUN=true

JWT_SECRET=generate-a-strong-32-plus-character-secret
APP_SECRET=generate-a-strong-32-plus-character-secret
CONFESSION_ENCRYPTION_KEY=64-hex-characters
ENCRYPTION_CURRENT_KEY_VERSION=v1
ENCRYPTION_MASTER_KEY_v1=64-hex-characters

ENABLE_BACKGROUND_JOBS=true
REDIS_HOST=your-redis-host
REDIS_PORT=6379

STELLAR_FEATURES_ENABLED=false
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC_URL=https://soroban-rpc-testnet.stellar.org
CONFESSION_ANCHOR_CONTRACT_ID=CB5XMDHT66EISB4WXM4YGNDHYRMZDX42TOHZEAENIUTSSMRFHJSFRNHB
REPUTATION_BADGES_CONTRACT_ID=CDAN4HZHY6XNQR3TRPLPJKVKNURVMMQMF7XNZ6AUNJNFLR77J4DNAEYI
TIPPING_SYSTEM_CONTRACT_ID=CC74UWNAAYDTPEPVKR4CPANWJSF6GI2PCI7BLN6M46KB6CSQYVYLHIWM
STELLAR_SERVER_SECRET=

MAIL_HOST=your-smtp-host
MAIL_PORT=587
MAIL_SECURE=false
MAIL_FROM=noreply@your-domain
MAIL_USER=your-smtp-user
MAIL_PASSWORD=your-smtp-password
```

Staging uses the same shape with staging hosts and isolated staging databases:

```env
NODE_ENV=production
APP_ENV=staging
PORT=5000
FRONTEND_URL=https://staging.your-frontend-domain
BACKEND_URL=https://staging.your-backend-domain
DB_HOST=staging-postgres-host
DB_PORT=5432
DB_USERNAME=staging-app-user
DB_PASSWORD=staging-db-password
DB_NAME=xconfess_staging
JWT_SECRET=staging-strong-secret
APP_SECRET=staging-strong-secret
CONFESSION_ENCRYPTION_KEY=64-hex-characters
TYPEORM_SYNCHRONIZE=false
TYPEORM_MIGRATIONS_RUN=true
ENABLE_BACKGROUND_JOBS=true
REDIS_HOST=staging-redis-host
REDIS_PORT=6379
```

Required frontend variables:

```env
BACKEND_API_URL=https://your-backend-domain/api
NEXT_PUBLIC_API_URL=https://your-backend-domain/api
NEXT_PUBLIC_WS_URL=wss://your-backend-domain
NEXT_PUBLIC_APP_URL=https://your-frontend-domain
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_CONTRACT_ID=CB5XMDHT66EISB4WXM4YGNDHYRMZDX42TOHZEAENIUTSSMRFHJSFRNHB
NEXT_PUBLIC_DEV_BYPASS_AUTH=false
```

Generate backend secrets:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the base64 values for `JWT_SECRET` and `APP_SECRET`. Use the 64-character hex value for `CONFESSION_ENCRYPTION_KEY`.

## Container Deployment

Build backend:

```powershell
docker build -f Dockerfile.backend -t xconfess-backend .
```

Build frontend:

```powershell
docker build -f Dockerfile.frontend -t xconfess-frontend `
  --build-arg BACKEND_API_URL=https://your-backend-domain/api `
  --build-arg NEXT_PUBLIC_API_URL=https://your-backend-domain/api `
  --build-arg NEXT_PUBLIC_WS_URL=wss://your-backend-domain `
  --build-arg NEXT_PUBLIC_APP_URL=https://your-frontend-domain .
```

Start the backend only after Postgres and Redis are reachable. The backend exposes `/api/health/live` for process health and `/api/health/ready` for dependency readiness.

## SSH/PM2 Deployment Order

Deploy backend first, then frontend.

1. Sync `xconfess-backend`.
2. Write the backend `.env`.
3. Run `npm ci --omit=dev`.
4. Restart `xconfess-backend` with PM2.
5. Verify `http://localhost:5000/api/health/ready` on the server.
6. Sync `xconfess-frontend`.
7. Run `npm ci --omit=dev`.
8. Restart `xconfess-frontend` with PM2.

The CD workflow follows this order and stops before frontend deployment if backend readiness fails.

## Rollback Runbook

Find the last successful deployment:

```powershell
gh run list --workflow cd.yml --status success --limit 10
```

Roll backend back first by rerunning CD against the previous known-good commit SHA, or by SSHing into the host and restoring the previous `~/xconfess/backend/dist` directory.

```powershell
gh workflow run cd.yml --ref <previous-good-sha> -f environment=production -f run_build=true
```

After the backend is restored, verify readiness:

```powershell
ssh <deploy-user>@<deploy-host> "curl -sf http://localhost:5000/api/health/ready"
```

Then roll frontend back to the matching commit or restore the previous `~/xconfess/frontend/.next` directory. Smoke check public routes after PM2 reload:

```powershell
Invoke-WebRequest -Uri https://your-frontend-domain -UseBasicParsing
Invoke-WebRequest -Uri https://your-frontend-domain/login -UseBasicParsing
Invoke-WebRequest -Uri https://your-frontend-domain/register -UseBasicParsing
```

## CI/CD Gates

Fast deploy gate for app hosts:

```powershell
npm run ci:apps
```

Full repo gate:

```powershell
npm run ci
```

The full gate includes frontend type-checking, frontend tests, backend tests, and Rust contract tests. Contract tests need enough free disk space for the MSVC linker on Windows.

`npm run deploy:preflight` checks Render config drift, migration timestamp duplicates, and required production env vars. It now also runs automatically as a required GitHub Actions check (`Deploy Preflight`) on every pull request against `main`, using dummy production-shaped env values — no live secrets are needed for the check to run.

## Transaction Latency and Failure Budgets

Transaction workflows are instrumented at the backend boundary with bounded labels so application latency can be separated from network-provider latency:

- `network`: one of `stellar-testnet`, `stellar-mainnet`, `stellar-futurenet`, `stellar-custom` (never a raw URL or passphrase).
- `operation`: one of `submit`, `include`, `confirm`, `anchor`, `tip`, `badge`.
- `outcome`: one of `success`, `timeout`, `provider_error`, `rejected`.

Each submission records three latency samples: submission (request accepted by the provider), inclusion (transaction observed in a ledger), and confirmation (final success/failure). Budgets are configured per network and operation class:

```env
TX_LATENCY_BUDGET_SUBMIT_MS=5000
TX_LATENCY_BUDGET_INCLUDE_MS=30000
TX_LATENCY_BUDGET_CONFIRM_MS=60000
TX_FAILURE_BUDGET_PERCENT=5
TX_BUDGET_WINDOW_SECONDS=300
```

When a budget is exceeded, the backend emits a structured warning (`tx_budget_exceeded`) with the bounded labels and the observed value. Budgets are advisory by default; set `TX_BUDGET_ENFORCE=true` to reject new submissions for a network/operation class once its failure budget is exhausted within the window. Rejections return `503` with `code: "TX_BUDGET_EXHAUSTED"` and are counted under `outcome=rejected`.

Operational notes:

- Budgets are evaluated over a rolling window and reset on process restart; they are not a substitute for provider-side alerting.
- Never add unbounded labels (transaction hashes, account IDs, raw URLs) to these metrics.
- Tune budgets per network; mainnet confirmation budgets are typically higher than testnet.

## Wallet Authorization Scopes

Wallet-connected actions map a user intent to exactly one contract operation and an explicit authorization footprint. The frontend declares the intent before signing; the backend and contract integration tests verify the signed invocation matches it.

| Intent | Contract operation | Authorization footprint |
| --- | --- | --- |
| `create_confession` | `anchor_confession` | `invoke` on the confession anchor contract only |
| `send_tip` | `transfer_tip` | `invoke` on the tipping contract; token transfer limited to the tip amount |
| `mint_badge` | `mint_badge` | `invoke` on the reputation badges contract only |

Rules enforced at the boundary:

- The requested footprint must be a subset of the declared intent's allowed footprint. Unexpected authorization requirements (extra contracts, admin functions, unbounded token approvals) are rejected before the wallet prompt is shown.
- The displayed intent (operation, contract, amount) must match the signed invocation; mismatches fail closed with `code: "AUTH_SCOPE_MISMATCH"`.
- Authorization failures are surfaced to the user without retrying automatically.

Contributors adding a new wallet action must add the intent to the scope map, document it in this table, and cover both the expected path and the rejection path in `npm run frontend:test` and `npm run contract:test:integration`.

## Deployment Configuration Drift Contract

Render (backend) and Vercel (frontend) must agree on a checked, non-secret configuration contract. `npm run production:readiness` compares the safe values below across both targets and fails readiness on drift:

- API origins: `BACKEND_URL` (Render) must equal the origin of `NEXT_PUBLIC_API_URL` and `BACKEND_API_URL` (Vercel).
- WebSocket origin: `NEXT_PUBLIC_WS_URL` must use `wss://` and share the backend host.
- Cookie settings: `COOKIE_SECURE=true`, `COOKIE_SAME_SITE` consistent with the frontend/backend origin relationship, and `NEXT_PUBLIC_APP_URL` matching the frontend origin.
- Feature flags: `STELLAR_FEATURES_ENABLED` (backend) must match `NEXT_PUBLIC_STELLAR_FEATURES_ENABLED` (frontend).
- Network selection: `STELLAR_NETWORK` must match `NEXT_PUBLIC_STELLAR_NETWORK`, and the contract IDs must match across targets.

Only non-secret values are compared; secrets are never read or logged. On drift, readiness fails with a per-field report naming the field, both observed values, and remediation, for example:

```text
CONFIG_DRIFT NEXT_PUBLIC_STELLAR_NETWORK: vercel="mainnet" render="testnet"
  remediation: set NEXT_PUBLIC_STELLAR_NETWORK=testnet in Vercel and redeploy the frontend
```

Remediation guidance:

1. Fix the drifted value in the owning provider's environment settings.
2. Redeploy the affected app (frontend changes require a rebuild because `NEXT_PUBLIC_*` values are inlined).
3. Re-run `npm run production:readiness` and confirm it passes before promoting.

## Regional Synthetic Checks

Privacy-critical user flows are exercised by low-volume synthetic journeys from multiple regions. Checks use synthetic accounts and fixtures only — never real user data — and report per-step availability with bounded labels:

- `region`: deployment region identifier (for example `us-east`, `eu-west`, `ap-southeast`).
- `step`: one of `landing`, `login`, `create_confession`, `view_confession`, `health`.
- `outcome`: one of `success`, `failure`, `timeout`.

Configuration:

```env
SYNTHETIC_CHECKS_ENABLED=true
SYNTHETIC_CHECK_REGIONS=us-east,eu-west,ap-southeast
SYNTHETIC_CHECK_INTERVAL_SECONDS=300
SYNTHETIC_CHECK_TIMEOUT_MS=10000
SYNTHETIC_CHECK_BASE_URL=https://your-frontend-domain
```

Operational notes:

- Keep volume low (one journey per region per interval) to avoid skewing real traffic metrics.
- Synthetic accounts are isolated and cleaned up; they must not be able to read or write real confessions.
- A failing step in any region fails the synthetic readiness report with the region and step named; regional routing, TLS, and edge-cache failures surface here before users report them.
- Roll out by enabling one region first, confirming a clean run, then adding regions incrementally.

Validation: `npm run readiness:test` covers the expected path, per-step failure reporting, and the regression risk of unbounded labels or real-user data leaking into synthetic journeys.
