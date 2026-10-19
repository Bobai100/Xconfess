/**
 * Chaos experiment catalogue for xConfess.
 *
 * Each experiment follows the standard hypothesis-driven format:
 *
 *   hypothesis  — what we expect the system to do
 *   abort       — condition that stops the experiment immediately
 *   metrics     — what to observe during the run
 *   remediation — issue / action to file when the experiment fails
 *
 * All experiments are STAGING-ONLY.  The `validate()` helper refuses to
 * run if it detects a production environment (DATABASE_URL matches
 * production patterns or NODE_ENV === 'production').
 *
 * Running experiments:
 *   node scripts/run-chaos-experiment.js --experiment=<id>
 *
 * Issue: #99 — Create chaos experiments for critical workflows
 */

export type ChaosTarget =
  | 'postgres'
  | 'redis'
  | 'email'
  | 'stellar-rpc'
  | 'queue-worker'
  | 'process';

export interface ChaosMetric {
  name: string;
  /** What value we expect to observe (e.g. "< 1% error rate on /api/confessions"). */
  expected: string;
  /** How to measure it (manual, prometheus query, log grep, etc.). */
  method: string;
}

export interface ChaosExperiment {
  /** Stable identifier — used in CLI flag and CI matrix. */
  id: string;
  title: string;
  target: ChaosTarget;
  /**
   * What the system is expected to do when the failure is injected.
   * Written as: "When X fails, the system should Y."
   */
  hypothesis: string;
  /**
   * Pre-conditions that must be true before starting.
   * If any are false, the experiment is skipped (not failed).
   */
  preconditions: string[];
  /** Steps to inject the failure in a staging environment. */
  injectionSteps: string[];
  /** Metrics to observe while the failure is active. */
  metrics: ChaosMetric[];
  /**
   * Condition that triggers an immediate abort of the experiment.
   * Checked every 30 s during the run.
   */
  abortCondition: string;
  /** Steps to restore normal state after the experiment. */
  recoverySteps: string[];
  /**
   * What to do when the system's observed behaviour misses the hypothesis.
   * Typically: open a remediation issue and link it here.
   */
  remediationOnFailure: string;
  /** Estimated duration of the injection phase in seconds. */
  durationSecs: number;
}

/**
 * All defined chaos experiments.
 *
 * Add new experiments as new objects in this array.
 * Each experiment is independently runnable via `--experiment=<id>`.
 */
export const CHAOS_EXPERIMENTS: ChaosExperiment[] = [
  // -------------------------------------------------------------------------
  // EXP-01: Postgres connection loss
  // -------------------------------------------------------------------------
  {
    id: 'exp-01-postgres-loss',
    title: 'Postgres connection loss during feed read',
    target: 'postgres',
    hypothesis:
      'When the Postgres connection is severed mid-request, the API returns a 503 ' +
      'with a retryable error code; the readiness probe reflects "down"; ' +
      'no unhandled exceptions propagate to the client; ' +
      'and reads resume automatically within 30 s of restore.',
    preconditions: [
      'Staging Postgres is running and healthy (/health/ready returns 200)',
      'At least 5 RPS of confession feed traffic is active against staging',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Block TCP to Postgres from the app container: `iptables -A OUTPUT -p tcp --dport 5432 -j DROP`',
      '2. Observe /health/ready — should transition to 503 within one poll interval (~15 s)',
      '3. Observe GET /api/confessions — should return 503 with a retryable body',
      '4. Hold for 60 s, then restore: `iptables -D OUTPUT -p tcp --dport 5432 -j DROP`',
      '5. Observe /health/ready — should return 200 within 30 s of restoration',
    ],
    metrics: [
      {
        name: 'api-error-rate',
        expected: '100% of /api/confessions requests return 503 while blocked; 0% after restore',
        method: 'Grep access logs or Prometheus http_requests_total by status code',
      },
      {
        name: 'readiness-probe-latency',
        expected: '/health/ready transitions to 503 within 15 s of blocking',
        method: 'Poll /health/ready every 5 s and record first failure timestamp',
      },
      {
        name: 'no-unhandled-exceptions',
        expected: 'No 500 responses; only 503',
        method: 'Check application logs for "UnhandledPromiseRejection" or 5xx != 503',
      },
      {
        name: 'recovery-time',
        expected: 'First successful /health/ready within 30 s of TCP restore',
        method: 'Poll /health/ready every 5 s after iptables rule removed',
      },
    ],
    abortCondition:
      'Data corruption detected (unexpected row mutations) OR process crashes with non-503 error',
    recoverySteps: [
      'Remove the iptables rule: `iptables -D OUTPUT -p tcp --dport 5432 -j DROP`',
      'Verify /health/ready returns 200',
      'Check TypeORM connection pool logs for reconnect events',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Postgres loss does not return clean 503 — improve error boundary"',
    durationSecs: 60,
  },

  // -------------------------------------------------------------------------
  // EXP-02: Redis eviction / loss during notification dispatch
  // -------------------------------------------------------------------------
  {
    id: 'exp-02-redis-loss',
    title: 'Redis loss during BullMQ job dispatch',
    target: 'redis',
    hypothesis:
      'When Redis becomes unreachable, BullMQ workers pause gracefully; ' +
      'in-flight jobs are not lost; core confession reads from Postgres continue; ' +
      'and the health endpoint reports "degraded" (not "down").',
    preconditions: [
      'ENABLE_BACKGROUND_JOBS=true in staging',
      'At least one notification worker is active',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Stop the Redis container: `docker stop <redis-container-id>`',
      '2. Observe /health/status — "state" should become "degraded" within 30 s',
      '3. Submit a new notification trigger (e.g. react to a confession) and verify it is retained',
      '4. Verify GET /api/confessions still returns 200 (Postgres-backed reads unaffected)',
      '5. After 60 s, restart Redis: `docker start <redis-container-id>`',
      '6. Verify queued jobs are processed once workers reconnect',
    ],
    metrics: [
      {
        name: 'health-state',
        expected: '"degraded" (not "down") while Redis is stopped',
        method: 'GET /health/status and check .state field',
      },
      {
        name: 'feed-availability',
        expected: 'GET /api/confessions returns 200 throughout the experiment',
        method: 'Poll every 10 s during the injection window',
      },
      {
        name: 'job-retention',
        expected: 'Jobs submitted during outage are processed after Redis recovers',
        method: 'Count notification rows in DB with status "pending" before / after restore',
      },
    ],
    abortCondition:
      'Core API (GET /api/confessions) starts returning 503 OR process crashes',
    recoverySteps: [
      'Restart Redis: `docker start <redis-container-id>`',
      'Verify /health/status returns state: "ready"',
      'Check BullMQ dashboard for any jobs stuck in "failed" state',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Redis outage causes feed unavailability — decouple queue from read path"',
    durationSecs: 60,
  },

  // -------------------------------------------------------------------------
  // EXP-03: Duplicate BullMQ job delivery
  // -------------------------------------------------------------------------
  {
    id: 'exp-03-duplicate-jobs',
    title: 'Duplicate job delivery in notification queue',
    target: 'queue-worker',
    hypothesis:
      'When the same job is enqueued twice (simulating an at-least-once delivery scenario), ' +
      'the notification worker delivers the notification exactly once; ' +
      'duplicate jobs are deduplicated by job ID and do not produce double-sends.',
    preconditions: [
      'ENABLE_BACKGROUND_JOBS=true in staging',
      'At least one notification worker is active',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Use the BullMQ CLI or a test script to add the same job payload twice with identical IDs:',
      '   `queue.add("send-notification", payload, { jobId: "dedup-test-001" })`',
      '   `queue.add("send-notification", payload, { jobId: "dedup-test-001" })` // duplicate',
      '2. Observe the notification_log table — exactly one row should appear for "dedup-test-001"',
      '3. Verify the email delivery log shows a single send (check SMTP or Ethereal stub)',
    ],
    metrics: [
      {
        name: 'notification-delivery-count',
        expected: 'Exactly 1 notification delivered per unique job ID',
        method: 'SELECT COUNT(*) FROM notification_logs WHERE job_id = \'dedup-test-001\'',
      },
      {
        name: 'email-send-count',
        expected: 'Exactly 1 email sent to the target address',
        method: 'Check SMTP stub log or Ethereal inbox count',
      },
    ],
    abortCondition: 'Worker crashes or job enters permanent "failed" state',
    recoverySteps: [
      'Drain any remaining test jobs: `queue.drain()`',
      'Delete test notification_log rows if needed',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Notification worker does not deduplicate job IDs — add idempotency check"',
    durationSecs: 30,
  },

  // -------------------------------------------------------------------------
  // EXP-04: Process termination during active request
  // -------------------------------------------------------------------------
  {
    id: 'exp-04-process-kill',
    title: 'Graceful shutdown under SIGTERM during active HTTP requests',
    target: 'process',
    hypothesis:
      'When the NestJS process receives SIGTERM while serving requests, ' +
      'it stops accepting new connections, drains in-flight requests within 10 s, ' +
      'and exits with code 0; no active request returns a connection-reset error.',
    preconditions: [
      'Staging backend is running under a process manager or Docker',
      'At least 2 RPS of traffic is active against staging',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Identify the NestJS process PID: `pgrep -f "node dist/main"`',
      '2. While traffic is running, send SIGTERM: `kill -TERM <pid>`',
      '3. Observe process logs — should log "Received SIGTERM, starting graceful shutdown"',
      '4. Check that no in-flight requests received a connection reset (ECONNRESET in client logs)',
      '5. Confirm the process exits within 15 s',
    ],
    metrics: [
      {
        name: 'graceful-drain',
        expected: 'All in-flight requests complete or return 503 (not ECONNRESET)',
        method: 'Client-side error log analysis; look for ECONNRESET vs 503',
      },
      {
        name: 'exit-code',
        expected: 'Process exits with code 0',
        method: 'Check `echo $?` after process exits or inspect Docker exit code',
      },
      {
        name: 'drain-time',
        expected: 'Process exits within 15 s of SIGTERM',
        method: 'Measure time between SIGTERM and process exit in logs',
      },
    ],
    abortCondition: 'Process does not exit within 30 s (hung shutdown) OR data corruption detected',
    recoverySteps: [
      'Restart the backend: `npm run start:backend` or re-deploy container',
      'Verify /health/live returns 200',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "SIGTERM handler does not drain connections before exit"',
    durationSecs: 15,
  },

  // -------------------------------------------------------------------------
  // EXP-06: Redis connection loss during export queue processing
  // -------------------------------------------------------------------------
  {
    id: 'exp-06-redis-export-connection-loss',
    title: 'Redis connection loss during export queue processing',
    target: 'redis',
    hypothesis:
      'When the Redis connection backing the export queue is severed, the export ' +
      'worker stops consuming without losing in-flight jobs; export requests are ' +
      'accepted and persisted as "pending" rather than failing; and once Redis ' +
      'reconnects the worker resumes and completes the backlogged exports.',
    preconditions: [
      'ENABLE_BACKGROUND_JOBS=true in staging',
      'At least one export worker is active and the export queue is empty',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Block TCP to Redis from the app container: `iptables -A OUTPUT -p tcp --dport 6379 -j DROP`',
      '2. Submit an export request via POST /api/exports and verify it returns 202 with status "pending"',
      '3. Verify the export worker logs a connection error and pauses (no job loss)',
      '4. Hold for 60 s, then restore: `iptables -D OUTPUT -p tcp --dport 6379 -j DROP`',
      '5. Verify the worker reconnects and the pending export transitions to "completed"',
    ],
    metrics: [
      {
        name: 'export-request-acceptance',
        expected: 'POST /api/exports returns 202 (not 5xx) while Redis is unreachable',
        method: 'Check HTTP response status in staging request log',
      },
      {
        name: 'export-job-retention',
        expected: 'No export jobs lost; pending count unchanged during outage',
        method: 'SELECT COUNT(*) FROM exports WHERE status = \'pending\' before / after restore',
      },
      {
        name: 'export-recovery-time',
        expected: 'Pending exports complete within 60 s of Redis restore',
        method: 'Poll SELECT status FROM exports ORDER BY created_at DESC LIMIT 1',
      },
    ],
    abortCondition:
      'Export request returns 5xx OR export rows are lost / corrupted',
    recoverySteps: [
      'Remove the iptables rule: `iptables -D OUTPUT -p tcp --dport 6379 -j DROP`',
      'Verify /health/status returns state: "ready"',
      'Confirm the export worker drains the backlog and marks exports "completed"',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Export queue loses jobs on Redis connection loss — add durable retry"',
    durationSecs: 60,
  },

  // -------------------------------------------------------------------------
  // EXP-07: Redis recovery and backlog growth for the notification queue
  // -------------------------------------------------------------------------
  {
    id: 'exp-07-redis-notification-backlog',
    title: 'Notification queue backlog growth and recovery after Redis outage',
    target: 'queue-worker',
    hypothesis:
      'When Redis is unavailable long enough for the notification queue to accumulate ' +
      'a backlog, the worker drains the backlog after recovery without dropping jobs, ' +
      'without unbounded memory growth, and without duplicate notifications.',
    preconditions: [
      'ENABLE_BACKGROUND_JOBS=true in staging',
      'At least one notification worker is active',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Stop the Redis container: `docker stop <redis-container-id>`',
      '2. Generate 200 notification triggers (e.g. reactions) while Redis is down',
      '3. Verify triggers are persisted (DB rows with status "pending") and no worker crash occurs',
      '4. After 120 s, restart Redis: `docker start <redis-container-id>`',
      '5. Observe the worker drain the backlog and process all 200 notifications',
    ],
    metrics: [
      {
        name: 'backlog-retention',
        expected: 'All 200 triggers persisted; none lost during outage',
        method: 'SELECT COUNT(*) FROM notification_logs WHERE status = \'pending\'',
      },
      {
        name: 'backlog-drain-time',
        expected: 'Backlog fully drained within 5 min of Redis restore',
        method: 'Poll pending count every 15 s after restart',
      },
      {
        name: 'duplicate-delivery',
        expected: 'Exactly one notification per trigger after drain',
        method: 'SELECT job_id, COUNT(*) FROM notification_logs GROUP BY job_id HAVING COUNT(*) > 1',
      },
    ],
    abortCondition:
      'Worker crashes OR backlog is not drained within 10 min of restore OR duplicate sends detected',
    recoverySteps: [
      'Restart Redis if still stopped: `docker start <redis-container-id>`',
      'Verify /health/status returns state: "ready"',
      'Drain any remaining test jobs and clean up test notification_log rows',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Notification queue backlog not drained after Redis recovery"',
    durationSecs: 120,
  },

  // -------------------------------------------------------------------------
  // EXP-08: Duplicate delivery in the drafts queue
  // -------------------------------------------------------------------------
  {
    id: 'exp-08-redis-drafts-duplicate',
    title: 'Duplicate delivery in the drafts autosave queue',
    target: 'queue-worker',
    hypothesis:
      'When the same draft autosave job is delivered twice (at-least-once delivery), ' +
      'the drafts worker applies the autosave idempotently so the draft is persisted ' +
      'exactly once per revision and no conflicting versions are created.',
    preconditions: [
      'ENABLE_BACKGROUND_JOBS=true in staging',
      'At least one drafts worker is active',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Enqueue the same draft autosave payload twice with identical job IDs:',
      '   `queue.add("autosave-draft", payload, { jobId: "draft-dedup-001" })`',
      '   `queue.add("autosave-draft", payload, { jobId: "draft-dedup-001" })` // duplicate',
      '2. Observe the drafts table — exactly one revision should be written for "draft-dedup-001"',
      '3. Verify no optimistic-lock conflict or duplicate version row is produced',
    ],
    metrics: [
      {
        name: 'draft-revision-count',
        expected: 'Exactly 1 revision persisted per unique job ID',
        method: 'SELECT COUNT(*) FROM draft_revisions WHERE job_id = \'draft-dedup-001\'',
      },
      {
        name: 'draft-conflict-errors',
        expected: 'No version-conflict errors logged by the drafts worker',
        method: 'Grep backend logs for "draft" + "conflict" during the run',
      },
    ],
    abortCondition: 'Worker crashes OR draft data is corrupted / duplicated',
    recoverySteps: [
      'Drain any remaining test jobs: `queue.drain()`',
      'Delete test draft_revisions rows if needed',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Drafts worker is not idempotent under duplicate delivery"',
    durationSecs: 30,
  },

  // -------------------------------------------------------------------------
  // EXP-09: Redis connection loss and recovery for the tips queue
  // -------------------------------------------------------------------------
  {
    id: 'exp-09-redis-tips-recovery',
    title: 'Tips queue connection loss, recovery, and duplicate delivery',
    target: 'queue-worker',
    hypothesis:
      'When Redis is unreachable, tip processing is deferred without losing the tip; ' +
      'after Redis recovers the tips worker processes each tip exactly once; ' +
      'and a duplicate delivery of the same tip job does not credit the recipient twice.',
    preconditions: [
      'ENABLE_BACKGROUND_JOBS=true in staging',
      'At least one tips worker is active',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Stop the Redis container: `docker stop <redis-container-id>`',
      '2. Submit a tip via POST /api/tips and verify it is persisted with status "pending"',
      '3. Restart Redis after 60 s: `docker start <redis-container-id>`',
      '4. Verify the tips worker processes the pending tip exactly once',
      '5. Re-enqueue the same tip job ID to simulate duplicate delivery and verify no double credit',
    ],
    metrics: [
      {
        name: 'tip-retention',
        expected: 'Tip persisted with status "pending" during outage; none lost',
        method: 'SELECT status FROM tips ORDER BY created_at DESC LIMIT 1',
      },
      {
        name: 'tip-processing-count',
        expected: 'Exactly 1 credit per tip after recovery and duplicate delivery',
        method: 'SELECT COUNT(*) FROM tip_credits WHERE tip_id = <test-tip-id>',
      },
      {
        name: 'tips-recovery-time',
        expected: 'Pending tip processed within 60 s of Redis restore',
        method: 'Poll SELECT status FROM tips ORDER BY created_at DESC LIMIT 1',
      },
    ],
    abortCondition:
      'Tip is lost OR recipient is credited more than once OR worker crashes',
    recoverySteps: [
      'Restart Redis if still stopped: `docker start <redis-container-id>`',
      'Verify /health/status returns state: "ready"',
      'Clean up test tip and tip_credits rows',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Tips worker double-credits or loses tips on Redis recovery"',
    durationSecs: 60,
  },

  // -------------------------------------------------------------------------
  // EXP-05: Stellar RPC timeout during confession anchoring
  // -------------------------------------------------------------------------
  {
    id: 'exp-05-stellar-rpc-timeout',
    title: 'Stellar RPC timeout does not block confession creation',
    target: 'stellar-rpc',
    hypothesis:
      'When the Stellar RPC endpoint times out, confession creation still succeeds ' +
      'and the confession is saved to Postgres with anchoring_status="pending"; ' +
      'the circuit breaker opens after 5 consecutive timeouts; ' +
      'and the reconciliation worker retries anchoring once the circuit closes.',
    preconditions: [
      'STELLAR_FEATURES_ENABLED=true in staging',
      'At least one confession has been successfully anchored previously',
      'NODE_ENV !== "production"',
    ],
    injectionSteps: [
      '1. Configure a proxy (e.g. toxiproxy) to add a 30 s delay to RPC calls:',
      '   `toxiproxy-cli toxic add rpc-proxy -t latency -a latency=30000`',
      '2. Submit a new confession via POST /api/confessions',
      '3. Verify the HTTP response is 201 (not a timeout error)',
      '4. Verify the confession row has anchoring_status = "pending"',
      '5. After 5 such requests, verify the circuit breaker opens (logs "Circuit opened: stellar-rpc")',
      '6. Remove the proxy latency: `toxiproxy-cli toxic remove rpc-proxy latency`',
      '7. Verify the reconciliation worker picks up "pending" confessions and anchors them',
    ],
    metrics: [
      {
        name: 'confession-creation-success-rate',
        expected: 'POST /api/confessions returns 201 despite RPC timeout',
        method: 'Check HTTP response status in staging request log',
      },
      {
        name: 'anchoring-status',
        expected: 'confession.anchoring_status = "pending" immediately after creation',
        method: 'SELECT anchoring_status FROM confessions ORDER BY created_at DESC LIMIT 1',
      },
      {
        name: 'circuit-breaker-state',
        expected: 'Circuit opens after 5 consecutive timeouts (visible in logs)',
        method: 'Grep backend logs for "Circuit opened: stellar-rpc"',
      },
      {
        name: 'reconciliation',
        expected: 'Pending confessions anchored within 5 min of circuit closing',
        method: 'Poll SELECT anchoring_status FROM confessions WHERE anchoring_status = \'pending\'',
      },
    ],
    abortCondition:
      'POST /api/confessions returns 5xx OR confession data is lost',
    recoverySteps: [
      'Remove toxiproxy latency rule',
      'Verify reconciliation worker logs successful anchoring',
      'Run `npm run production:readiness` to confirm all checks pass',
    ],
    remediationOnFailure:
      'Open a follow-up issue: "Stellar RPC timeout causes confession creation failure — add async anchoring"',
    durationSecs: 120,
  },
];

/**
 * Look up an experiment by ID.  Returns undefined if not found.
 */
export function getExperiment(id: string): ChaosExperiment | undefined {
  return CHAOS_EXPERIMENTS.find((e) => e.id === id);
}

/**
 * Environment safety check.
 * Throws if the current environment looks like production.
 * Call this at the start of any script that runs experiments.
 */
export function assertStagingEnvironment(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[chaos] Refusing to run chaos experiments in NODE_ENV=production. ' +
      'Set NODE_ENV=staging or NODE_ENV=test.',
    );
  }

  const dbUrl = process.env.DATABASE_URL ?? '';
  const productionPatterns = [/\.render\.com/i, /\.rds\.amazonaws\.com/i, /prod/i];
  for (const pattern of productionPatterns) {
    if (pattern.test(dbUrl)) {
      throw new Error(
        `[chaos] DATABASE_URL appears to point at a production host (matched ${pattern}). ` +
        'Chaos experiments must only run against staging.',
      );
    }
  }
}
