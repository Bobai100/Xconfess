# Operational Resilience Runbook

Covers issues #96, #97, #98, #99, and #100.

---

## Table of Contents

1. [Dependency Outage Behavior (#96)](#dependency-outage-behavior)
2. [Alert Deduplication and Ownership (#97)](#alert-deduplication-and-ownership)
3. [Backup Restore Verification (#98)](#backup-restore-verification)
4. [Chaos Experiments (#99)](#chaos-experiments)
5. [Abuse-Resistant Rate Limits (#100)](#abuse-resistant-rate-limits)

---

## 1. Dependency Outage Behavior (#96)

**Source files:**
- `xconfess-backend/src/health/circuit-breaker.service.ts`
- `xconfess-backend/src/health/outage-policy.ts`

### How it works

Each external dependency (postgres, redis, email, stellar-rpc) is classified into a **tier**:

| Tier     | Examples              | Behaviour when down                            |
|----------|------------------------|--------------------------------------------------|
| critical | postgres, schema      | Returns 503; readiness probe shows "down"        |
| optional | redis, email, stellar | Fallback activated; readiness probe shows "degraded" |

The `CircuitBreakerService` implements the classic three-state machine:

```
CLOSED → (threshold failures) → OPEN → (reset timeout) → HALF_OPEN → (probe success) → CLOSED
                                                                → (probe failure)  → OPEN
```

Thresholds and timeouts are set per dependency at module initialisation.

### Injecting CircuitBreakerService

```typescript
import { CircuitBreakerService } from '../health/circuit-breaker.service';

constructor(private readonly cb: CircuitBreakerService) {
  // Register once at startup
  this.cb.register('email', { failureThreshold: 5, resetTimeoutMs: 30_000, tier: 'optional' });
}

async sendEmail(payload: EmailPayload) {
  if (this.cb.isOpen('email')) {
    this.logger.warn('email circuit open — skipping send, will retry later');
    return; // graceful degraded mode
  }
  try {
    await this.mailer.send(payload);
    this.cb.recordSuccess('email');
  } catch (err) {
    this.cb.recordFailure('email');
    throw err;
  }
}
```

### Fallback levels

| Level    | Behaviour                                                                 |
|----------|---------------------------------------------------------------------------|
| none     | Request fails immediately with 503 (critical deps only)                           |
| cached   | Serve stale data from in-process or Redis cache                                   |
| skip     | Fire-and-forget: log the failure and move on (email, webhooks)                        |
| disabled | Feature is disabled until circuit closes (Redis queues when ENABLE_BACKGROUND_JOBS=false) |

### Checking circuit status

```bash
# Via the /health/status endpoint:
curl http://localhost:5000/api/health/status
# Returns { state: "ready" | "degraded" | "down", checks: {...} }
```

### Manual reset (maintenance window)

```typescript
// Inject CircuitBreakerService and call:
circuitBreaker.reset('email');
```

---

## 2. Alert Deduplication and Ownership (#97)

**Source file:** `xconfess-backend/src/health/alert-manager.ts`

### Problem

Without deduplication, a single Postgres outage fires a new alert every health-check cycle (every 30 s), flooding the on-call channel and hiding the incident in noise.

### How AlertManager works

1. **Identity key** — built from `alertName + service + labels`. Two alerts with the same key are considered duplicates.
2. **Dedup window** — critical alerts are deduplicated for 5 minutes; warnings for 15 minutes; info for 1 hour.
3. **Maintenance mode** — call `alertManager.setMaintenanceMode(true)` during planned maintenance to suppress all alerts.

### Ownership map

Every service area has a registered owner in `ALERT_OWNERSHIP_MAP`:

| Service     | Owner handle          | Channel                | Runbook                              |
|------------|----------------------|----------------------|--------------------------------------|
| database    | @xconfess/backend    | #incidents             | disaster-recovery-runbook.md         |
| redis       | @xconfess/backend    | #incidents             | incident-runbook.md                  |
| queues      | @xconfess/backend    | #incidents             | notification-delivery-reliability.md |
| auth        | @xconfess/backend    | #security             | incident-runbook.md                  |
| stellar-rpc | @xconfess/backend    | #stellar-incidents     | stellar-anchor-and-tipping-runbook.md|
| email       | @xconfess/backend    | #incidents             | notification-delivery-reliability.md |
| frontend    | @xconfess/frontend   | #incidents             | production-critical-path.md          |


To add a new service area, add an entry to `ALERT_OWNERSHIP_MAP` in `alert-manager.ts`.

### Using AlertManager

```typescript
import { AlertManager } from '../health/alert-manager';

const alerts = new AlertManager();

// Fire an alert (deduplicated automatically)
const alert = alerts.fire({
  alertName: 'postgres.down',
  severity: 'critical',
  service: 'database',
  message: 'Postgres is unreachable',
});

if (alert.state === 'firing') {
  // Page the owner
  console.log(`Page ${alert.owner.handle} at ${alert.owner.channel}`);
  console.log(`Runbook: ${alert.owner.runbookUrl}`);
}

// Resolve when dependency recovers
alerts.resolve(alert.identityKey);
```

---

## 3. Backup Restore Verification (#98)

**Source file:** `scripts/verify-backup-restore.js`

### Purpose

Backups are only useful if they can be restored. This drill verifies:
1. **RPO check** — the backup is recent enough (default: ≤ 1 hour old).
2. **Restore check** — `pg_restore` completes within the RTO (default: ≤ 4 hours).
3. **Integrity check** — the restored database contains at least one `confessions` row.

### Running a drill

```bash
# Dry run (no actual restore):
node scripts/verify-backup-restore.js --dry-run --backup-file=/tmp/xconfess-backup.dump

# Full drill against a sandbox database:
node scripts/verify-backup-restore.js \
  --backup-file=/tmp/xconfess-backup.dump \
  --target-db=postgres://user:pass@localhost:5432/drill_test \
  --rto-minutes=30 \
  --rpo-hours=1
```

### Safety guarantees

- -*Never runs against production.** The script refuses connections matching `*.render.com`, `*.rds.amazonaws.com`, or hostnames containing `prod`.
- All encryption keys come from the secrets manager — the dump file is never co-located with key material.
- Results are written to `readiness-results/backup-drill-<timestamp>.json` for audit trail.

### Scheduling drills

The repository schedules a secret-free dry-run rehearsal every Monday at 09:15
UTC through `.github/workflows/rollback-drills.yml`. Maintainers can also select
a drill with `workflow_dispatch`. Each run retains the evidence report and any
generated remediation-gap checklist as a 90-day workflow artifact.

The scheduled job does not inject faults, connect to a deployment, or use
production secrets. It checks the available procedures and records gaps. A
maintainer must arrange and authorize any live staging exercise separately.

For another scheduler, use the same dry-run command:

```yaml
# Example — schedule in an isolated runner and retain the report directory.
- name: Backup restore drill
  run: |
    npm run rollback:drills:dry-run -- --drill all \
      --report-dir "$RUNNER_TEMP/rollback-drill-results"
```

### RPO / RTO targets

| Metric | Target  |
|--------|---------|
| RPO    | ≤ 1 hour |
| RLO    | ≤ 4 hours |

See [`docs/disaster-recovery-runbook.md`](disaster-recovery-runbook.md) for the full restore procedure.

---

## 4. Chaos Experiments (#99)

**Source files:**
- `xconfess-backend/src/health/chaos-experiments.ts` — catalogue
- `scripts/run-chaos-experiment.js` — dry-run runner / documentation tool

### Available experiments

| ID                            | Target       | Duration |
|--------------------------------|--------------|----------|
| exp-01-postgres-loss          | postgres     | 60 s     |
| exp-02-redis-loss             | redis        | 60 s     |
| exp-03-duplicate-jobs         | queue-worker | 30 s     |
| exp-04-process-kill           | process      | 15 s     |
| exp-05-stellar-rpc-timeout    | stellar-rpc  | 120 s    |

### Running experiments

```bash
# List all experiments:
node scripts/run-chaos-experiment.js --list

# Print the plan for a specific experiment (dry run):
node scripts/run-chaos-experiment.js --experiment=exp-01-postgres-loss

# All experiments (dry run):
node scripts/run-chaos-experiment.js --experiment=all --dry-run
```

Actual fault injection is done ** manually** by following the `injectionSteps` documented in each experiment. This is intentional — automated injection requires dedicated tooling (e.g. Chaos Monkey, Chaos Mesh) that exceeds the current infrastructure scope.

### Safety guarantees

- All experiments declare `NODE_ENV !== "production"` as a precondition.
- `assertStagingEnvironment()` throws before any experiment runs if `NODE_ENV=production` or `DATABASE_URL` matches a production hostname.
- Each experiment has an `abortCondition` that must be checked every 30 s during the run.

### When an experiment fails its hypothesis

1. Note the observed vs. expected metrics.
2. Open a follow-up issue using the `remediationOnFailure` text as the title.
3. Link the experiment ID and the failing metric in the issue body.
4. Do not re-run the experiment until the remediation issue is resolved.

### Adding a new experiment

Add a new `ChaosExperiment` object to the `CHAOS_EXPERIMENTS` array in
`xconfess-backend/src/health/chaos-experiments.ts`.  All fields are required.
The corresponding unit test (chaos-experiments.spec.ts`) will automatically
validate the new entry's structure.

---

## 5. Abuse-Resistant Rate Limits (#100)

**Source files:**
- `xconfess-backend/src/rate-limit/rate-limit.service.ts` — layered limit engine
- `xconfess-backend/src/rate-limit/rate-limit.guard.ts` — HTTP guard / bypass checks
- `xconfess-backend/src/rate-limit/identity.ts` — anonymous identity derivation
- `xconfess-backend/src/rate-limit/rate-limit.constants.ts` — route cost + budget tables

### Why IP-only throttling is insufficient

IP-only limits fail in two opposite directions:

- **NAT blind spot** — many legitimate users share one public IP, so a single abuser exhausts the budget for everyone behind that IP.
- -*Trivial evades** — an attacker with a proxy pool gets a fresh budget per IP.

The layered model below combines **who** the caller is (identity), **account** budgets, **IP reputation**,
**route cost**, and **trusted admin bypasses** so that no single dimension can be gamed.

### Layers

Every request is evaluated against all applicable layers. The most restrictive result wins.

| Layer            | Key                                     | Default budget                          |
|------------------|---------------------------------------|--------------------------------------|
| anon-identity   | `anon` hash of (cookie id ∥ fallback to normalised IP) | 60 req/min                              |
| account         | authenticated user id                        | 300 req/min                             |
| ip-reputation   | client IP + reputation score bucket              | 300/150/60/20 req/min by bucket          |
| route-cost      | route class (cheap / normal / expensive / critical) | multiplier applied to the above          |
| admin-bypass     | trusted admin token + scope                   | unlimited (still audited)               |

### Anonymous identity

When the caller is not authenticated, the guard derives a stable identity from an ``anon`` cookie
(`set-cookie: anon_id=<token>; HttpOnly; SameSite=Lax; Secure; Max-Age=1)`). When cookies are not available
(e.g. server-to-server calls), the guard falls back to a normalised IP key. The anon identity is
therefore not a hidden auth mechanism — it only separates callers that share an IP.

### Route cost multipliers

High-risk operations have separate budgets so a flood of expensive requests cannot be absorbed by
the general pool. The cost of a route is declared in `route-cost.ts` and applied as a multiplier
(and a separate budket) on top of the identity / account / IP layers.

| Route class | Examples                                         | Multiplier | Separate budget          |
|--------------|----------------------------------------------------|------------|-------------------------|
| cheap        | `GET` feeds, health checks, cache reads                | 1×         | none                      |
| normal       | `GIET` detail, list pagination                       | 2×         | none                      |
| expensive    | `POST` create confession, search, export            | 5É         | yes (`expensive`)          |
| critical     | auth login, password reset, tipping, webhook register | 10×        | yes (`critical`)           |

### IP reputation buckets

The guard maintains a reputation score per IP (default 0). Scores are derived from auth failures,
aborted connections, and explicit admin marks. The score maps to a bucket that caps the IP layer:

| Bucket   | Score range   | IP layer budget (req/min) | Notes                           |
|----------|---------------|-------------------------|------------------------------------|
| trusted | ≥ 80         | 300                     | long-lived good actors                 |
| neutral | 40–79        | 150                     | default for unknown IPs                |
| suspect | 20–39        | 60                      | some auth failures                    |
| hostile | < 20          | 20                      | auto-decay after 1 hour without abuse |

Reputation is stored in Redis with a TTL and is updated atomically with the counter increments.

### Atomic across instances

All counters and reputation scores live in Redis and are updated via a single Lua script per
request. The script increments every applicable bucket and returns the maximum retry after in one
round trip, so two instances cannot both grant the same token.

```lua
-- keys: [1] anon, [2] account, [3] ip, [4] expensive, [5] critical
-- args: windowSeconds, cost, budgets...
local now_ms = tonnumber(REDIS.call('TIME'))
local window = tonnumber(ARR[1])
local cost = tonnumber(ARR[2])
local maxRetry = 0
for i, key in ipairs(KEYS) do
  local budget = tonnumber(ARG[2+i])
  if budget > 0 then
    local current = REDIS.call('INCREBY', key, cost)
    if current == cost then REDIS.call('EXPIRE', key, window) end
    if current > budget then
      local ttl = REDIS.call('TTL', key)
      if ttl > 0 then maxRetry = math.max(maxRetry, ttl) end
    end
  end
end
return maxRetry
```

If Redis is unavailable, the guard fails closed for `critical` and `expensive` routes and fails open
for `cheap` and `normal` routes, matching the dependency tiers in section 1.

### Response contract

When a limit is exceeded the guard returns a `RateLimitError` that includes the retry timing:

```json
{
  "error": "rate_limited",
  "message": "Too many requests",
  "layer": "anon-identity",
  "limit": 60,
  "remaining": 0,
  "retryAfterSeconds": 27,
  "resetAt": "2025-01-01T00:00:00Z"
}
```

The guard also sets the following HTTP response headers on every request (not only on 429):

| Header                  | Meaning                                                 |
|-------------------------|-----------------------------------------------------------|
| `RateLimit-Limit`       | Budget of the most restrictive layer                          |
| `RateLimit-Remaining`   | Remaining tokens in that layer                              |
| `RateLimit-Reset`      | Unix timestamp when the budget refills                      |
| `Retry-After`           | Seconds to wait before retrying (429 responses only)         |

### Trusted admin bypasses

Admin bypass is explicit and narrow:

- The caller must present a valid admin token with the `rate-limit:bypass` scope.
- The bypass is audited (`admin.bypass.rate-limit` event) with the admin id and route.
- The bypass is still subject to the `critical` route budget to prevent an admin token from being used as a DoS vector.
- Admin bypasses can be revoked at runtime by removing the scope from the token.

### Configuration

| Env var                        | Default | Description                                     |
|--------------------------------|---------|---------------------------------------------------------|
| `RATE_LIMIT_ENABLED`            | `true` | Master switch (disable only in local development)       |
| `RATE_LIMIT_ANON_PER_MIN`       | `60`   | Anonymous identity budget                            |
| `RATE_LIMIT_ACCOUNT_PER_MIN`     | `300`  | Authenticated account budget                         |
| `RATE_LIMIT_IP_TRUSTED_PER_MIN` | `300`  | IP budget for the trusted bucket                     |
| `RATE_LIMIT_IP_HOSTILE_PER_MIN` | `20`    | IP budget for the hostile bucket                      |
| `RATE_LIMIT_REDIS_URL`          | —      | Redis connection string (required in production)          |

### Operational runbook:
rate limit firing

1. Check the layer reported in the 429 body (`layer`).
2. If the layer is `ano-identity`, confirm the client is not sharing an IP with a noisy peer.
3. If the layer is `ip-reputation`, check the reputation bucket and the audit log for the IP before manually raising it.
4. If the layer is `route-cost`, confirm the route class in `route-cost.ts` matches the expected cost.
5. Never disable the guard globally to unblock a single caller — use an admin bypass instead.

### Rollback

To roll back to IP-only throttling:

1. Set `RATE_LIMIT_ENABLED=false` and redeploy.
2. Confirm the guard is bypassed by checking the `/health/status` endpoint for `rateLimit: "disabled by config"`.
3. Re-enable once the root cause is understood. The Redis keys expire naturally, so no manual cleanup is required.

### Testing

- `unit`: `xconfess-backend/src/rate-limit/rate-limit.service.spec.ts` covers each layer, bypasses, and fail-closed behaviour.
- `integration`: `xconfess-backend/test/rate-limit.integration.spec.ts` runs two backend instances against one Redis and asserts the budget is shared.
- `load`: `xconfess-backend/test/load/rate-limit.load.ts` verifies throughput and retry timing under sustained load.

Run the full validation suite:

```bash
npm run secret-scan && npm run audit:ci && npm run backend:test
```
