// ─── Trending windows ────────────────────────────────────────────────────────

/**
 * Supported trending / analytics time windows.
 * Values represent the number of calendar days in each window.
 */
export enum TrendingWindow {
  DAY = 1,
  WEEK = 7,
  MONTH = 30,
}

/**
 * Inclusive lower boundary (UTC midnight) and exclusive upper boundary
 * (start of the next UTC day after `now`) for a given window.
 *
 * Rules
 * ─────
 * • startAt  – UTC midnight of the day that is `days` calendar days before `now`.
 *              A record with `createdAt = startAt` IS included (>= comparison).
 * • endAt    – UTC midnight of tomorrow.
 *              A record with `createdAt = endAt` is NOT included (< comparison).
 *
 * Using an exclusive upper bound avoids double-counting rows written exactly
 * at midnight when consecutive windows are stitched together.
 */
export interface WindowBoundaries {
  /** Inclusive lower bound – UTC midnight `days` days before `now`. */
  startAt: Date;
  /** Exclusive upper bound – UTC midnight of tomorrow. */
  endAt: Date;
}

/**
 * Compute UTC-normalized window boundaries for a given number of days.
 *
 * Both boundaries are floored to UTC midnight so that partial-day offsets
 * introduced by `new Date()` mid-execution do not leak into bucket edges.
 *
 * @param days - Number of calendar days in the window (use `TrendingWindow.*`).
 * @param now  - Reference instant; defaults to `new Date()`. Inject in tests.
 */
export function toWindowBoundaries(
  days: number,
  now: Date = new Date(),
): WindowBoundaries {
  // Floor `now` to UTC midnight of today
  const todayUTC = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  // Inclusive start: midnight `days` calendar days ago
  const startAt = new Date(todayUTC - days * 24 * 60 * 60 * 1000);

  // Exclusive end: midnight tomorrow
  const endAt = new Date(todayUTC + 24 * 60 * 60 * 1000);

  return { startAt, endAt };
}

// ─── Ranking quality drift ───────────────────────────────────────────────────

/**
 * Minimum number of distinct users that must contribute to a cohort before
 * its aggregate indicators may be published or compared. Cohorts below this
 * threshold are suppressed to avoid re-identification from small samples.
 */
export const RANKING_QUALITY_MIN_COHORT_SIZE = 50;

/**
 * Maximum number of days a ranking-quality aggregate may be retained.
 * Aggregates older than this must be purged; no user-level histories are kept.
 */
export const RANKING_QUALITY_MAX_RETENTION_DAYS = 90;

/**
 * Aggregate-only quality indicators for a single cohort.
 *
 * All values are computed over the cohort as a whole; no per-user records are
 * stored. `cohortSize` is the number of distinct users contributing.
 */
export interface RankingQualityCohortIndicators {
  /** Stable, non-identifying cohort key (e.g. "all", "region:eu"). */
  cohortKey: string;
  /** Number of distinct users contributing to this aggregate. */
  cohortSize: number;
  /** Mean reciprocal rank of the first relevant result (0..1). */
  meanReciprocalRank: number;
  /** Fraction of impressions that received a click (0..1). */
  clickThroughRate: number;
  /** Fraction of sessions that ended without engagement (0..1). */
  abandonmentRate: number;
  /** UTC timestamp of the aggregate bucket start (inclusive). */
  bucketStart: Date;
  /** UTC timestamp of the aggregate bucket end (exclusive). */
  bucketEnd: Date;
}

/**
 * Drift thresholds expressed as absolute deltas against a baseline window.
 * A metric breaches when `|current - baseline| >= threshold`.
 */
export interface RankingQualityDriftThresholds {
  meanReciprocalRank: number;
  clickThroughRate: number;
  abandonmentRate: number;
}

/** Default drift thresholds applied when none are configured. */
export const DEFAULT_RANKING_QUALITY_DRIFT_THRESHOLDS: RankingQualityDriftThresholds =
  {
    meanReciprocalRank: 0.05,
    clickThroughRate: 0.1,
    abandonmentRate: 0.1,
  };

/** A single metric that breached its configured drift threshold. */
export interface RankingQualityDriftBreach {
  metric: keyof RankingQualityDriftThresholds;
  baseline: number;
  current: number;
  threshold: number;
  /** Signed delta (`current - baseline`). */
  delta: number;
}

/** Outcome of evaluating a cohort's current indicators against a baseline. */
export interface RankingQualityDriftEvaluation {
  cohortKey: string;
  /** False when the cohort was below the minimum size and thus suppressed. */
  evaluated: boolean;
  /** True when at least one metric breached its threshold. */
  drifted: boolean;
  breaches: RankingQualityDriftBreach[];
  /** Reason the evaluation was skipped, when `evaluated` is false. */
  suppressedReason?: 'below_min_cohort_size' | 'no_baseline';
}

/** Review decisions that may be taken when drift is detected. */
export enum RankingQualityReviewDecision {
  /** Keep the ranking version active; no action required. */
  ACCEPT = 'accept',
  /** Continue observing before acting. */
  MONITOR = 'monitor',
  /** Disable the ranking version pending investigation. */
  DISABLE = 'disable',
}

/** Recorded outcome of a drift review, including the acting reviewer. */
export interface RankingQualityReview {
  cohortKey: string;
  decision: RankingQualityReviewDecision;
  /** Ranking version under review. */
  rankingVersion: string;
  /** Identifier of the reviewer who made the decision. */
  reviewerId: string;
  /** Optional free-text rationale. */
  rationale?: string;
  /** UTC timestamp the decision was recorded. */
  decidedAt: Date;
}
