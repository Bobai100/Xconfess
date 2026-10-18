import { Controller, Get, Optional } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { RedisHealthIndicator } from './redis.health';
import { SchemaReadinessHealthIndicator } from './schema-readiness.health';
import { QueueHealthIndicator } from './queue.health';
import { PostgresHealthIndicator } from './postgres.health';
import { ReplicaLagHealthIndicator } from './replica-lag.health';
import { RegionalSyntheticHealthIndicator } from './regional-synthetic.health';

interface SubsystemStatus {
  name: string;
  status: 'up' | 'down' | 'degraded' | 'disabled';
}

function getNestedStatuses(detail: Record<string, unknown>): string[] {
  return Object.values(detail)
    .filter((value): value is { status?: string } =>
      Boolean(value && typeof value === 'object' && 'status' in value),
    )
    .map((value) => value.status)
    .filter((status): status is string => Boolean(status));
}

function buildSubsystemSummary(
  result: HealthCheckResult,
): SubsystemStatus[] {
  const subsystems: SubsystemStatus[] = [];
  const info = result.info ?? {};
  const errors = result.error ?? {};

  const keys = ['database', 'redis', 'queues', 'schema', 'email', 'synthetic'];
  for (const key of keys) {
    const detail = info[key] ?? errors[key];
    if (!detail) {
      subsystems.push({ name: key, status: 'down' });
      continue;
    }

    if (detail.mode === 'disabled') {
      subsystems.push({ name: key, status: 'disabled' });
      continue;
    }

    const nestedStatuses = getNestedStatuses(detail);
    if (nestedStatuses.includes('down')) {
      subsystems.push({ name: key, status: 'down' });
    } else if (nestedStatuses.includes('degraded')) {
      subsystems.push({ name: key, status: 'degraded' });
    } else if (detail.status === 'up') {
      subsystems.push({ name: key, status: 'up' });
    } else {
      subsystems.push({ name: key, status: 'down' });
    }
  }

  return subsystems;
}

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: PostgresHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly schemaReadiness: SchemaReadinessHealthIndicator,
    private readonly queues: QueueHealthIndicator,
    private readonly email: EmailHealthIndicator,
    private readonly configService: ConfigService,
    private readonly replicaLag: ReplicaLagHealthIndicator,
    @Optional()
    private readonly regionalSynthetic?: RegionalSyntheticHealthIndicator,
  ) {}

  @Get('database-pool')
  @ApiOperation({
    summary: 'Database connection pool and lock contention observability metrics',
  })
  getDatabasePoolMetrics() {
    return this.poolObservability?.getPoolAndLockMetrics();
  }

  /**
   * Regional synthetic checks — per-region, per-step availability for
   * privacy-critical user flows (issue #285).
   *
   * Returns bounded labels only (region, journey, step, status). No user data
   * or free-form error strings are exposed. When the indicator is not
   * configured the endpoint reports `disabled` rather than failing.
   */
  @Get('synthetic')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Regional synthetic check status',
    description:
      'Reports per-region, per-step availability for low-volume synthetic ' +
      'journeys of privacy-critical flows. Labels are bounded; no real user ' +
      'data is included. Returns `disabled` when synthetic checks are off.',
  })
  @ApiResponse({ status: 200, description: 'Synthetic check summary returned' })
  async synthetic() {
    if (!this.regionalSynthetic) {
      return {
        status: 'disabled',
        regions: [],
        steps: [],
        timestamp: new Date().toISOString(),
      };
    }
    return this.regionalSynthetic.getSummary();
  }


  /**
   * Liveness probe — is the process responsive?
   * No external dependency checks. Safe to poll at high frequency.
   */
  @Get('live')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 while the Node process is responsive. ' +
      'No external dependency checks. Use for Kubernetes liveness probes.',
  })
  @ApiResponse({ status: 200, description: 'Process is alive' })
  liveness() {
    return { status: 'ok' };
  }

  /**
   * Readiness probe — are all dependencies available?
   * Returns 503 when any dependency is unavailable.
   * Includes per-subsystem diagnostics with actionable error messages.
   */
  @Get('ready')
  @HealthCheck()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Checks Postgres (latency, version, connections), Redis (latency, version), ' +
      'BullMQ queue workers, confession-table schema, and SMTP reachability. ' +
      'Returns 503 with per-subsystem diagnostics and actionable hints on failure. ' +
      'Use for Kubernetes readiness probes.',
  })
  @ApiResponse({ status: 200, description: 'All dependencies ready' })
  @ApiResponse({
    status: 503,
    description: 'One or more dependencies unavailable',
  })
  async readiness() {
    const result = await this.health.check([
      async () => this.db.isHealthy('database'),
      async () => this.redis.isHealthy('redis'),
      async () => this.queues.isHealthy('queues'),
      async () => this.schemaReadiness.isHealthy('schema'),
      // Issue #107: replica lag is observable via readiness probe
      async () => this.replicaLag.isHealthy('replica_lag'),
      // Issue #285: regional synthetic checks are observable via readiness
      async () =>
        this.regionalSynthetic
          ? this.regionalSynthetic.isHealthy('synthetic')
          : { synthetic: { status: 'up', mode: 'disabled' } },
    ]);
    const jobsEnabled =
      this.configService?.get<string>('ENABLE_BACKGROUND_JOBS') === 'true';
    return {
      ...result,
      backgroundJobMode: jobsEnabled ? 'enabled' : 'disabled',
      subsystems: buildSubsystemSummary(result),
    };
  }

  /** Backward-compatible alias for GET /health/ready. */
  @Get()
  @HealthCheck()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Health check (readiness alias)',
    description:
      'Backward-compatible alias for GET /health/ready. ' +
      'Prefer /health/ready for new integrations.',
  })
  @ApiResponse({ status: 200, description: 'All checks passed' })
  @ApiResponse({ status: 503, description: 'One or more checks failed' })
  async check() {
    const result = await this.health.check([
      async () => this.db.isHealthy('database'),
      async () => this.redis.isHealthy('redis'),
      async () => this.queues.isHealthy('queues'),
      async () => this.schemaReadiness.isHealthy('schema'),
      async () => this.replicaLag.isHealthy('replica_lag'),
      async () =>
        this.regionalSynthetic
          ? this.regionalSynthetic.isHealthy('synthetic')
          : { synthetic: { status: 'up', mode: 'disabled' } },
    ]);
    const jobsEnabled =
      this.configService?.get<string>('ENABLE_BACKGROUND_JOBS') === 'true';
    return {
      ...result,
      backgroundJobMode: jobsEnabled ? 'enabled' : 'disabled',
      subsystems: buildSubsystemSummary(result),
    };
  }

  /**
   * Startup probe — are all critical dependencies reachable at boot time?
   *
   * Semantics differ from the readiness probe:
   *  - Runs only during the startup window (Kubernetes `startupProbe`).
   *  - Checks only the dependencies needed before the process accepts traffic.
   *  - Does NOT check queue workers (they may not have started yet).
   *  - Does NOT check email (optional dependency for startup).
   *  - A 503 here signals that the container should be restarted, not
   *    temporarily removed from load balancing (which is readiness).
   *
   * Set `failureThreshold * periodSeconds` in your Kubernetes manifest to
   * allow enough time for cold-start database migrations.
   */
  @Get('startup')
  @HealthCheck()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Startup probe',
    description:
      'Checks critical dependencies (Postgres, schema) required before the ' +
      'process can serve any traffic. Intended for Kubernetes startupProbe. ' +
      'Returns 503 if core dependencies are not yet reachable.',
  })
  @ApiResponse({ status: 200, description: 'Critical dependencies reachable' })
  @ApiResponse({ status: 503, description: 'Critical dependency unavailable' })
  async startup() {
    return this.health.check([
      async () => this.db.isHealthy('database'),
      async () => this.schemaReadiness.isHealthy('schema'),
    ]);
  }

  /**
   * Simplified health state classification.
   *
   * Returns a flat JSON object with an explicit `state` field that
   * classifies the system as one of:
   *
   *  • **live**       — the process is responsive (no dependency checks).
   *  • **ready**      — all dependencies are healthy.
   *  • **disabled**   — optional dependencies (Redis, queues) are intentionally
   *                     off (ENABLE_BACKGROUND_JOBS=false) but core deps are up.
   *  • **degraded**   — at least one critical dependency is down OR a queue is
   *                     unhealthy (high latency, no workers), but the system can
   *                     still serve partial traffic.
   *  • **down**       — a critical dependency (database, schema) is unreachable.
   *
   * Use this endpoint when you need a single, machine-readable state value
   * for dashboards, alerting, or load-balancer routing.
   */
  @Get('status')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Health state classification',
    description:
      'Returns a flat JSON object with a `state` field: ' +
      'live | ready | disabled | degraded | down. ' +
      'Includes per-check detail for diagnostics.',
  })
  @ApiResponse({ status: 200, description: 'Health state returned' })
  async status() {
    const result = await this.health.check([
      async () => this.db.isHealthy('database'),
      async () => this.redis.isHealthy('redis'),
      async () => this.queues.isHealthy('queues'),
      async () => this.schemaReadiness.isHealthy('schema'),
      async () => this.email.isHealthy('email'),
    ]).catch((err) => {
      // NestJS Terminus throws an HttpException whose .response body has:
      //   { status, error: { <failed> }, details: { <all> } }
      // We normalise both the success and failure shapes into a common
      // { details, errors } envelope so the state classifier below is simple.
      const body = err?.response ?? {};
      return {
        status: 'error' as const,
        details: body.details ?? {},
        errors: body.error ?? {},
      };
    });

    const details = result.details ?? {};
    const errors = result.status === 'error' ? (result as any).errors ?? {} : {};

    // Determine the overall state
    let state: string;

    const dbStatus = details['database']?.status ?? errors['database']?.status;
    const schemaStatus = details['schema']?.status ?? errors['schema']?.status;
    const redisStatus = details['redis']?.status ?? errors['redis']?.status;
    const queuesStatus = details['queues']?.status ?? errors['queues']?.status;
    const emailStatus = details['email']?.status ?? errors['email']?.status;
    const syntheticStatus =
      details['synthetic']?.status ?? errors['synthetic']?.status;

    // Critical: database or schema down → 'down'
    if (dbStatus === 'down' || schemaStatus === 'down') {
      state = 'down';
    }
    // Critical: database or schema errors → 'down'
    else if (
      (errors['database'] && errors['database'].status === 'down') ||
      (errors['schema'] && errors['schema'].status === 'down')
    ) {
      state = 'down';
    }
    // Optional deps disabled → 'disabled'
    else if (
      redisStatus === 'up' &&
      queuesStatus === 'up' &&
      (details['redis']?.mode === 'disabled' || details['queues']?.mode === 'disabled')
    ) {
      state = 'disabled';
    }
    // Queue degraded but core deps OK → 'degraded'
    else if (
      queuesStatus === 'down' ||
      queuesStatus === 'degraded' ||
      redisStatus === 'down' ||
      syntheticStatus === 'down' ||
      syntheticStatus === 'degraded'
    ) {
      state = 'degraded';
    }
    // Everything healthy
    else {
      state = 'ready';
    }

    return {
      state,
      timestamp: new Date().toISOString(),
      checks: {
        database: { status: dbStatus ?? 'unknown' },
        redis: { status: redisStatus ?? 'unknown', mode: details['redis']?.mode },
        queues: { status: queuesStatus ?? 'unknown', mode: details['queues']?.mode },
        schema: { status: schemaStatus ?? 'unknown' },
        email: { status: emailStatus ?? 'unknown', mode: details['email']?.mode },
        synthetic: {
          status: syntheticStatus ?? 'unknown',
          mode: details['synthetic']?.mode,
        },
      },
    };
  }
}
