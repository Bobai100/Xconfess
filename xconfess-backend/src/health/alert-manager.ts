/**
 * Alert deduplication and ownership routing.
 *
 * Solves two problems with naive alerting:
 *
 * 1. **Deduplication** — a single incident can trigger dozens of identical
 *    alerts (e.g. health-check failures every 30 s).  We assign each alert an
 *    identity key and suppress duplicates within a configurable window.
 *
 * 2. **Ownership routing** — every critical alert must have a named owner and
 *    a runbook link.  The registry below maps service areas to owners so that
 *    on-call engineers know who to page without reading code.
 *
 * This module is deliberately framework-free so it can be unit-tested and
 * reused across notification workers, health controllers, and cron jobs.
 *
 * Issue: #97 — Add alert deduplication and ownership routing
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Active states for the alert lifecycle. */
export type AlertState = 'firing' | 'resolved' | 'suppressed';

export interface AlertOwner {
  /** GitHub handle or team slug, e.g. "@yazeed11011" or "@xconfess/backend". */
  handle: string;
  /** Slack channel or email to page, e.g. "#incidents". */
  channel: string;
  /** URL to the runbook document that describes how to respond. */
  runbookUrl: string;
}

export interface AlertDefinition {
  /** Unique stable identifier for this alert type, e.g. "postgres.down". */
  alertName: string;
  severity: AlertSeverity;
  /** Service area — used to look up the owner from ALERT_OWNERSHIP_MAP. */
  service: string;
  /** Human-readable description of what triggered the alert. */
  message: string;
  /** Optional labels for grouping / filtering (e.g. { region: "us-east-1" }). */
  labels?: Record<string, string>;
}

export interface FiredAlert extends AlertDefinition {
  /** Stable identity key — duplicate alerts with the same key are suppressed. */
  identityKey: string;
  owner: AlertOwner;
  state: AlertState;
  firedAt: Date;
  /** How many times this alert has been suppressed within the dedup window. */
  suppressedCount: number;
  /** When the deduplication window expires (next alert with same key will fire). */
  dedupExpiresAt: Date;
  /** When the alert was resolved, if resolved. */
  resolvedAt?: Date;
}

/** Owns all alerts for a given service area. */
export interface OwnershipEntry {
  owner: AlertOwner;
  /** Optional escalation contacts (paged if primary owner does not acknowledge). */
  escalation?: AlertOwner[];
}

/**
 * Service → ownership mapping.
 *
 * Update this map whenever you add a new service area.
 * Every critical alert MUST have a corresponding entry.
 */
export const ALERT_OWNERSHIP_MAP: Record<string, OwnershipEntry> = {
  database: {
    owner: {
      handle: '@xconfess/backend',
      channel: '#incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/disaster-recovery-runbook.md',
    },
  },
  redis: {
    owner: {
      handle: '@xconfess/backend',
      channel: '#incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/incident-runbook.md',
    },
  },
  queues: {
    owner: {
      handle: '@xconfess/backend',
      channel: '#incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/notification-delivery-reliability.md',
    },
  },
  auth: {
    owner: {
      handle: '@xconfess/backend',
      channel: '#security',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/incident-runbook.md',
    },
    escalation: [
      {
        handle: '@xconfess/security',
        channel: '#security-escalation',
        runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/incident-runbook.md',
      },
    ],
  },
  'stellar-rpc': {
    owner: {
      handle: '@xconfess/backend',
      channel: '#stellar-incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/stellar-anchor-and-tipping-runbook.md',
    },
  },
  email: {
    owner: {
      handle: '@xconfess/backend',
      channel: '#incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/notification-delivery-reliability.md',
    },
  },
  frontend: {
    owner: {
      handle: '@xconfess/frontend',
      channel: '#incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/production-critical-path.md',
    },
  },
  'transaction-latency': {
    owner: {
      handle: '@xconfess/backend',
      channel: '#stellar-incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/transaction-latency-budgets.md',
    },
    escalation: [
      {
        handle: '@xconfess/backend-oncall',
        channel: '#incidents-escalation',
        runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/transaction-latency-budgets.md',
      },
    ],
  },
  'transaction-failure': {
    owner: {
      handle: '@xconfess/backend',
      channel: '#stellar-incidents',
      runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/transaction-latency-budgets.md',
    },
    escalation: [
      {
        handle: '@xconfess/backend-oncall',
        channel: '#incidents-escalation',
        runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/transaction-latency-budgets.md',
      },
    ],
  },
} as const;

/** Fallback owner when a service area is not registered. */
const DEFAULT_OWNER: OwnershipEntry = {
  owner: {
    handle: '@xconfess/backend',
    channel: '#incidents',
    runbookUrl: 'https://github.com/yazeed11011/Xconfess/blob/main/docs/incident-runbook.md',
  },
};

/**
 * Look up the registered owner for a service area.
 * Returns the default owner if no entry exists.
 */
export function resolveOwner(service: string): OwnershipEntry {
  return ALERT_OWNERSHIP_MAP[service] ?? DEFAULT_OWNER;
}

/**
 * Build a stable identity key for an alert.
 * Two alerts with the same name, service, and labels hash to the same key
 * and will be deduplicated within the active window.
 */
export function buildIdentityKey(def: AlertDefinition): string {
  const labelsSuffix = def.labels
    ? Object.entries(def.labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  return `${def.alertName}::${def.service}::${labelsSuffix}`;
}

/** Default deduplication windows per severity level. */
const DEFAULT_DEDUP_WINDOWS_MS: Record<AlertSeverity, number> = {
  critical: 5 * 60_000,  // 5 minutes — noisy critical alerts still page once per window
  warning:  15 * 60_000, // 15 minutes
  info:     60 * 60_000, // 1 hour
};

/**
 * Transaction workflow stages measured by the latency/failure budgets.
 * Kept as a closed union so alert labels stay bounded (no unbounded cardinality).
 */
export type TransactionStage = 'submission' | 'inclusion' | 'confirmation';

/** Operation classes used to segment transaction budgets. */
export type TransactionOperationClass = 'tip' | 'anchor' | 'transfer' | 'other';

/** Network identifiers used to segment transaction budgets. */
export type TransactionNetwork = 'mainnet' | 'testnet' | 'futurenet';

/** Which budget was breached. */
export type TransactionBudgetKind = 'latency' | 'failure';

export interface TransactionBudgetBreach {
  kind: TransactionBudgetKind;
  network: TransactionNetwork;
  operationClass: TransactionOperationClass;
  stage: TransactionStage;
  /** Observed value: latency in ms, or failure ratio in [0, 1]. */
  observed: number;
  /** Configured budget threshold that was exceeded. */
  threshold: number;
}

/**
 * Map a budget breach to an AlertDefinition with bounded labels.
 *
 * Labels are restricted to the closed unions above so the identity key (and
 * therefore the dedup window) cannot explode in cardinality.
 */
export function buildTransactionBudgetAlert(
  breach: TransactionBudgetBreach,
): AlertDefinition {
  const service =
    breach.kind === 'latency' ? 'transaction-latency' : 'transaction-failure';
  const unit = breach.kind === 'latency' ? 'ms' : 'ratio';
  return {
    alertName: `transaction.${breach.kind}.budget_exceeded`,
    severity: 'critical',
    service,
    message:
      `Transaction ${breach.kind} budget exceeded for ${breach.operationClass} ` +
      `on ${breach.network} at stage ${breach.stage}: ` +
      `observed ${breach.observed}${unit} > threshold ${breach.threshold}${unit}`,
    labels: {
      network: breach.network,
      operation_class: breach.operationClass,
      stage: breach.stage,
      kind: breach.kind,
    },
  };
}

/**
 * In-process alert deduplication and ownership router.
 *
 * Stateless between process restarts — suitable for single-instance deployments.
 * For multi-instance deployments, the dedup window can be backed by Redis keys
 * (extend by injecting RedisClient and persisting `activeAlerts` in a hash).
 */
export class AlertManager {
  /** Active alert registry. Key = identityKey. */
  private readonly activeAlerts = new Map<string, FiredAlert>();

  /**
   * Optional maintenance mode — while true, all alerts are suppressed.
   * Set via `AlertManager.setMaintenanceMode(true)` before deploying.
   */
  private maintenanceMode = false;

  /**
   * Custom dedup windows (ms) per severity.
   * Override in tests to use short windows.
   */
  constructor(
    private readonly dedupWindows: Record<AlertSeverity, number> = DEFAULT_DEDUP_WINDOWS_MS,
  ) {}

  /**
   * Fire an alert.
   *
   * - If the identity key is already active and within the dedup window,
   *   increments `suppressedCount` and returns the existing alert with
   *   `state: 'suppressed'`.
   * - Otherwise, registers a new FiredAlert, routes ownership, and returns it
   *   with `state: 'firing'`.
   * - During maintenance mode, all alerts are suppressed regardless of window.
   */
  fire(def: AlertDefinition): FiredAlert {
    const key = buildIdentityKey(def);
    const ownership = resolveOwner(def.service);
    const now = new Date();

    if (this.maintenanceMode) {
      const suppressed: FiredAlert = {
        ...def,
        identityKey: key,
        owner: ownership.owner,
        state: 'suppressed',
        firedAt: now,
        suppressedCount: 0,
        dedupExpiresAt: now,
      };
      return suppressed;
    }

    const existing = this.activeAlerts.get(key);

    // Within the dedup window — suppress
    if (existing && existing.state === 'firing' && now < existing.dedupExpiresAt) {
      existing.suppressedCount += 1;
      return { ...existing, state: 'suppressed' };
    }

    // New or expired — fire
    const windowMs = this.dedupWindows[def.severity];
    const alert: FiredAlert = {
      ...def,
      identityKey: key,
      owner: ownership.owner,
      state: 'firing',
      firedAt: now,
      suppressedCount: 0,
      dedupExpiresAt: new Date(now.getTime() + windowMs),
    };

    this.activeAlerts.set(key, alert);
    return alert;
  }

  /**
   * Resolve an alert by identity key.
   * Resolved alerts are removed from the active set so the next trigger fires again.
   */
  resolve(identityKey: string): FiredAlert | null {
    const alert = this.activeAlerts.get(identityKey);
    if (!alert) return null;
    const resolved: FiredAlert = {
      ...alert,
      state: 'resolved',
      resolvedAt: new Date(),
    };
    this.activeAlerts.delete(identityKey);
    return resolved;
  }

  /** Snapshot of all currently firing alerts. */
  getActive(): FiredAlert[] {
    return Array.from(this.activeAlerts.values()).filter(
      (a) => a.state === 'firing',
    );
  }

  /** Returns true when any critical alert is currently firing. */
  hasCritical(): boolean {
    return this.getActive().some((a) => a.severity === 'critical');
  }

  /**
   * Fire a transaction latency/failure budget breach alert.
   *
   * Routes ownership via the `transaction-latency` / `transaction-failure`
   * service entries and deduplicates using the bounded label set, so a
   * sustained breach pages once per dedup window rather than per sample.
   */
  fireTransactionBudgetBreach(breach: TransactionBudgetBreach): FiredAlert {
    return this.fire(buildTransactionBudgetAlert(breach));
  }

  setMaintenanceMode(enabled: boolean): void {
    this.maintenanceMode = enabled;
  }

  isInMaintenanceMode(): boolean {
    return this.maintenanceMode;
  }
}
