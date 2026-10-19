/**
 * Analytics governance constants and schema registry (#86).
 *
 * All analytics decisions that affect privacy, retention, or event validity
 * are defined here so dashboards, validators, and runbooks all read from a
 * single authoritative source.
 */

// ─── Privacy ──────────────────────────────────────────────────────────────────

/**
 * Privacy constants for analytics aggregation.
 *
 * MIN_COHORT_SIZE defines the minimum number of records required in an
 * aggregated bucket before exposing the count. Buckets below this threshold
 * are suppressed to prevent de-anonymisation via small-cohort inference.
 *
 * Reference: k-anonymity principle (Sweeney, 2002)
 */
export const ANALYTICS_PRIVACY = {
  /**
   * Minimum number of records in any aggregated cohort.
   * Examples: daily active users, daily confession count, reaction type count.
   *
   * Set to 5 (balanced trade-off between privacy and utility):
   * - Prevents single-user or 2-3 user buckets from being exposed
   * - Allows reasonable statistical visibility for platform health metrics
   * - Supports typical retention and churn analysis requirements
   */
  MIN_COHORT_SIZE: 5,
} as const;

// ─── Ranking quality drift (#267) ─────────────────────────────────────────────

/**
 * Aggregate-only ranking quality drift detection.
 *
 * Offline evaluation cannot catch every real-world ranking regression, but
 * retaining per-user result histories to detect drift creates privacy risk.
 * Instead we keep only minimum-cohort aggregate indicators (e.g. per ranking
 * version: impressions, clicks, mean reciprocal rank, abandonment rate) and
 * compare a candidate window against a baseline window.
 *
 * No user-level identifiers are stored for drift detection; aggregates below
 * MIN_COHORT_SIZE are suppressed exactly like other analytics cohorts.
 */
export const RANKING_QUALITY_DRIFT = {
  /**
   * Minimum number of distinct users/impressions in an aggregate bucket
   * before it may be used for drift evaluation. Reuses the analytics
   * k-anonymity floor so drift detection cannot become a side channel.
   */
  MIN_COHORT_SIZE: ANALYTICS_PRIVACY.MIN_COHORT_SIZE,

  /**
   * Relative degradation (0..1) of a quality indicator versus baseline that
   * triggers a drift alert. 0.1 = a 10% relative drop.
   */
  RELATIVE_DROP_THRESHOLD: 0.1,

  /**
   * Absolute degradation of a quality indicator versus baseline that
   * triggers a drift alert, regardless of relative size. Guards against
   * noisy small-baseline comparisons.
   */
  ABSOLUTE_DROP_THRESHOLD: 0.02,

  /**
   * Minimum number of aggregate buckets (e.g. daily windows) that must
   * breach a threshold before drift is declared, to avoid single-window
   * flapping.
   */
  MIN_CONSECUTIVE_BREACHES: 2,

  /**
   * Retention window, in days, for ranking quality aggregates. Only
   * aggregates are retained; per-user histories are never persisted for
   * drift detection.
   */
  RETENTION_DAYS: 30,

  /**
   * Maximum number of ranking versions whose aggregates may be retained at
   * once. Older versions are purged so drift data cannot accumulate into a
   * long-term behavioural profile.
   */
  MAX_RETAINED_VERSIONS: 5,
} as const;

/**
 * Feature flag key that gates whether a ranking version is served.
 * When drift review disables a version, this flag is turned off for it.
 */
export const RANKING_VERSION_FEATURE_FLAG_PREFIX = 'ranking.version.enabled';

/**
 * Builds the feature flag key for a specific ranking version.
 */
export function getRankingVersionFeatureFlagKey(version: string): string {
  return `${RANKING_VERSION_FEATURE_FLAG_PREFIX}.${version}`;
}

// ─── Schema Registry (#86) ───────────────────────────────────────────────────

/**
 * Event ownership map.
 *
 * Each event name is mapped to:
 *   - owner:        Team or module responsible for this event contract
 *   - purpose:      Business or product intent (used in consent checks)
 *   - schemaVersion: Current schema version for this event; bump when the
 *                    meaning of fields changes (not for additive changes)
 *   - retentionDays: How long raw events should be kept before purge/archive.
 *                    null = governed by the global default.
 *   - consentRequired: Whether this event requires explicit user consent
 *                      before being recorded (for GDPR/CCPA purposes).
 *
 * Dashboard note: events with schemaVersion < ANALYTICS_SCHEMA_VERSION in
 * the entity indicate schema drift and should be flagged in quality reports.
 */
export interface EventRegistryEntry {
  owner: string;
  purpose: string;
  schemaVersion: number;
  retentionDays: number | null;
  consentRequired: boolean;
}

export const ANALYTICS_EVENT_REGISTRY: Record<string, EventRegistryEntry> = {
  user_registered: {
    owner: 'auth',
    purpose: 'product_funnel',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  user_login: {
    owner: 'auth',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 90,
    consentRequired: false,
  },
  confession_created: {
    owner: 'confessions',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  confession_publish_failed: {
    owner: 'confessions',
    purpose: 'reliability',
    schemaVersion: 1,
    retentionDays: 30,
    consentRequired: false,
  },
  comment_created: {
    owner: 'confessions',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  reaction_created: {
    owner: 'confessions',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  message_sent: {
    owner: 'messages',
    purpose: 'engagement',
    schemaVersion: 1,
    retentionDays: 90,
    consentRequired: false,
  },
  wallet_connected: {
    owner: 'stellar',
    purpose: 'stellar_activation',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  stellar_tx_submitted: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  stellar_tx_confirmed: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
  stellar_tx_failed: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 90,
    consentRequired: false,
  },
  tip_completed: {
    owner: 'tipping',
    purpose: 'monetisation',
    schemaVersion: 1,
    retentionDays: 730,
    consentRequired: false,
  },
  soroban_event_indexed: {
    owner: 'stellar',
    purpose: 'stellar_reliability',
    schemaVersion: 1,
    retentionDays: 365,
    consentRequired: false,
  },
} as const;

/**
 * Default event retention in days for events not listed in the registry or
 * with retentionDays = null.
 */
export const ANALYTICS_DEFAULT_RETENTION_DAYS = 90;

/**
 * Allowed event purposes. Used by validators and dashboard filters to group
 * events by intent without exposing raw event names to external systems.
 */
export const ANALYTICS_EVENT_PURPOSES = [
  'product_funnel',
  'engagement',
  'reliability',
  'stellar_activation',
  'stellar_reliability',
  'monetisation',
] as const;

export type AnalyticsEventPurpose = (typeof ANALYTICS_EVENT_PURPOSES)[number];

// ─── Validation helpers ────────────────────────────────────────────────────────

/**
 * Look up the registry entry for an event name.
 * Returns undefined for unknown events (which should be rejected at ingestion).
 */
export function getEventRegistryEntry(
  eventName: string,
): EventRegistryEntry | undefined {
  return ANALYTICS_EVENT_REGISTRY[eventName];
}

/**
 * Returns the retention window in days for a given event name.
 * Falls back to ANALYTICS_DEFAULT_RETENTION_DAYS.
 */
export function getEventRetentionDays(eventName: string): number {
  const entry = getEventRegistryEntry(eventName);
  return entry?.retentionDays ?? ANALYTICS_DEFAULT_RETENTION_DAYS;
}

/**
 * Returns true when an event with the given schema version matches what
 * the registry expects. Mismatches indicate schema drift and should be
 * flagged in data-quality dashboards.
 */
export function isSchemaVersionCurrent(
  eventName: string,
  schemaVersion: number,
): boolean {
  const entry = getEventRegistryEntry(eventName);
  if (!entry) return false;
  return entry.schemaVersion === schemaVersion;
}
