// src/analytics/analytics.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Reaction } from '../reaction/entities/reaction.entity';
import { User } from '../user/entities/user.entity';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { CacheService } from '../cache/cache.service';
import {
  AnalyticsCacheKeys,
  InvalidationPrefixes,
} from '../cache/cache-namespace';
import { toWindowBoundaries } from '../types/analytics.types';
import {
  ANALYTICS_PRIVACY,
  RANKING_QUALITY_DRIFT,
} from './analytics.constants';

type TrendDirection = 'increasing' | 'decreasing' | 'stable';

interface AnalyticsWindowRange {
  startAt: Date;
  endAt: Date;
}

/** Exported for controller / declaration emit (TS4053). */
export interface ComparisonWindowMetadata {
  requestedDays: number;
  bucketUnit: 'day';
  bucketCount: number;
  current: {
    startAt: string;
    endAt: string;
  };
  previous: {
    startAt: string;
    endAt: string;
  };
}

export interface DailyGrowthPoint {
  date: string;
  count: number;
}

export interface GrowthMetrics {
  period: string;
  totalConfessions: number;
  averagePerDay: number;
  dailyGrowth: DailyGrowthPoint[];
  trend: TrendDirection;
}

interface BucketCountRow extends Record<string, string | number> {
  date: string;
  count: string | number;
}

export interface DailyActivityPoint {
  date: string;
  activeUsers: number;
}

export interface UserActivityMetrics {
  period: string;
  dailyActivity: DailyActivityPoint[];
  averageDAU: number;
}

export interface ReactionDistributionMetrics {
  total: number;
  distribution: Array<{
    type: string;
    count: number;
    percentage: string;
  }>;
  period: string;
}

interface TrendingConfessionWithReactionCount extends AnonymousConfession {
  reactionCount?: number;
}

interface CategoryStatsRow {
  category: string | null;
  count: string;
}

interface ReactionDistributionRow {
  type: string;
  count: string;
}

/**
 * Aggregate-only ranking quality indicators (#267).
 *
 * These are computed from cohort-level counters only — no per-user history is
 * retained or persisted. Each indicator is a ratio of aggregate counters.
 */
export interface RankingQualityIndicators {
  /** Click-through rate: clicks / impressions (0..1). */
  ctr: number;
  /** Mean dwell time in milliseconds across the cohort. */
  dwellMs: number;
  /** Satisfaction: positive feedback / total feedback (0..1). */
  satisfaction: number;
}

export interface RankingQualityCohort {
  rankingVersion: string;
  cohortSize: number;
  indicators: RankingQualityIndicators;
}

export type DriftStatus = 'ok' | 'insufficient-cohort' | 'drift-detected';

export interface RankingQualityDriftResult {
  status: DriftStatus;
  rankingVersion: string;
  cohortSize: number;
  baseline: RankingQualityIndicators | null;
  current: RankingQualityIndicators | null;
  breaches: Array<{
    metric: keyof RankingQualityIndicators;
    baseline: number;
    current: number;
    relativeChange: number;
    threshold: number;
  }>;
  /** True when the ranking version should be disabled pending review. */
  requiresReview: boolean;
  evaluatedAt: string;
}

export interface RankingVersionReview {
  rankingVersion: string;
  disabled: boolean;
  reason: string;
  reviewedAt: string;
}

/**
 * Raw aggregate counters supplied by the ranking pipeline. These are the only
 * inputs to drift detection; user-level rows are never accepted or stored.
 */
export interface RankingQualityAggregateCounters {
  rankingVersion: string;
  cohortSize: number;
  impressions: number;
  clicks: number;
  dwellTotalMs: number;
  dwellSamples: number;
  positiveFeedback: number;
  totalFeedback: number;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly CACHE_TTL = 900; // 15 minutes in seconds

  /**
   * In-memory, aggregate-only store of ranking quality counters keyed by
   * ranking version. Bounded by RANKING_QUALITY_DRIFT.RETENTION_LIMIT entries
   * and pruned by age — no user-level histories are ever retained here.
   */
  private readonly rankingQualityAggregates = new Map<
    string,
    { counters: RankingQualityAggregateCounters; recordedAt: Date }
  >();

  /** Ranking versions disabled pending review (feature-flag style). */
  private readonly disabledRankingVersions = new Map<
    string,
    RankingVersionReview
  >();

  constructor(
    @InjectRepository(AnonymousConfession)
    private confessionRepository: Repository<AnonymousConfession>,
    @InjectRepository(Reaction)
    private reactionRepository: Repository<Reaction>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly cacheService: CacheService,
  ) {}

  async getTrendingConfessions(days: number = 7) {
    // Use namespace-compliant cache key
    const cacheKey = AnalyticsCacheKeys.trending(days);

    // Try to get from cache
    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Use UTC-normalized window boundaries so edge timestamps are never
    // ambiguously shifted between buckets regardless of server timezone.
    const { startAt, endAt } = toWindowBoundaries(days);

    // ── Privacy-aware trending (#85) ──────────────────────────────────────────
    // Ranking is based on aggregated reaction counts within the window, not
    // per-user activity, so individual behaviour cannot be inferred from output.
    //
    // Exclusions applied before ranking:
    //   1. Soft-deleted confessions (isDeleted = true) are always excluded.
    //   2. Private confessions (isPrivate = true) are excluded — they must not
    //      appear in any public aggregation surface.
    //
    // Brigading suppression: confessions whose reaction count for the window
    // falls below MIN_COHORT_SIZE are not surfaced (k-anonymity principle).
    // This prevents a single-user post from trending via coordinated reactions.
    //
    // Content preview: only the first 200 characters are exposed (no full body).
    const trending = await this.confessionRepository
      .createQueryBuilder('confession')
      .leftJoinAndSelect('confession.reactions', 'reaction')
      .where('confession.created_at >= :startAt', { startAt })
      .andWhere('confession.created_at < :endAt', { endAt })
      .andWhere('confession.isDeleted = false')
      // Exclude private confessions from trending surfaces.
      .andWhere(
        "(confession.is_private IS NULL OR confession.is_private = false)",
      )
      .loadRelationCountAndMap(
        'confession.reactionCount',
        'confession.reactions',
      )
      .orderBy('confession.reactionCount', 'DESC')
      .take(20)
      .getMany();

    const result = trending
      .map((confession) => {
        const confessionWithCounts =
          confession as TrendingConfessionWithReactionCount;
        return {
          id: confession.id,
          content: confession.content.substring(0, 200), // Preview only — never full body
          reactionCount: confessionWithCounts.reactionCount || 0,
          createdAt: confession.created_at,
          category: confession.comments,
        };
      })
      // Brigading / small-cohort suppression: only surface confessions that
      // reached at least MIN_COHORT_SIZE reactions in the window.
      .filter((item) => item.reactionCount >= ANALYTICS_PRIVACY.MIN_COHORT_SIZE);

    // Cache the result
    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
  }

  async getReactionDistribution(days: number = 7) {
    // Use namespace-compliant cache key
    const cacheKey = AnalyticsCacheKeys.reactions(days);

    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.getReactionDistributionForWindow(
      this.getCurrentWindow(days),
      days,
    );

    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
  }

  async getDailyActiveUsers(days: number = 7) {
    // Use namespace-compliant cache key
    const cacheKey = AnalyticsCacheKeys.users(days);

    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.getUserActivityForWindow(
      this.getCurrentWindow(days),
      days,
    );

    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
  }

  async getPlatformStats() {
    // Use namespace-compliant cache key
    const cacheKey = AnalyticsCacheKeys.stats();

    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    // totalConfessions intentionally includes soft-deleted rows to track total
    // platform volume (mirrors the admin analytics overview); publishedConfessions
    // and totalReactions are the live-content figures and exclude deleted confessions.
    const [totalUsers, totalConfessions, totalReactions, publishedConfessions] =
      await Promise.all([
        this.userRepository.count(),
        this.confessionRepository.count(),
        this.reactionRepository
          .createQueryBuilder('reaction')
          .innerJoin('reaction.confession', 'confession')
          .where('confession.isDeleted = false')
          .getCount(),
        this.confessionRepository.count({ where: { isDeleted: false } }),
      ]);

    // Get most popular category (excluding soft-deleted confessions)
    const categoryStats = (await this.confessionRepository
      .createQueryBuilder('confession')
      .select('confession.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('confession.isDeleted = false')
      .groupBy('confession.category')
      .orderBy('count', 'DESC')
      .limit(1)
      .getRawOne()) as CategoryStatsRow | null;

    const result = {
      totalUsers,
      totalConfessions,
      totalReactions,
      publishedConfessions,
      pendingConfessions: totalConfessions - publishedConfessions,
      averageReactionsPerConfession:
        publishedConfessions > 0
          ? (totalReactions / publishedConfessions).toFixed(2)
          : 0,
      mostPopularCategory: categoryStats?.category || 'N/A',
      lastUpdated: new Date(),
    };

    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
  }

  async getConfessionGrowth(days: number = 7) {
    // Use namespace-compliant cache key
    const cacheKey = AnalyticsCacheKeys.growth(days);

    const cached = await this.cacheService.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.getGrowthMetricsForWindow(
      this.getCurrentWindow(days),
      days,
    );

    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
  }

  async getConfessionGrowthComparison(days: number = 7) {
    const comparison = this.getComparisonWindows(days);
    const [current, previous] = await Promise.all([
      this.getGrowthMetricsForWindow(comparison.currentRange, days),
      this.getGrowthMetricsForWindow(comparison.previousRange, days),
    ]);

    return {
      window: comparison.metadata,
      current,
      previous,
      delta: {
        totalConfessions: this.buildNumericDelta(
          current.totalConfessions,
          previous.totalConfessions,
        ),
        averagePerDay: this.buildNumericDelta(
          current.averagePerDay,
          previous.averagePerDay,
        ),
      },
    };
  }

  async getUserActivityComparison(days: number = 7) {
    const comparison = this.getComparisonWindows(days);
    const [current, previous] = await Promise.all([
      this.getUserActivityForWindow(comparison.currentRange, days),
      this.getUserActivityForWindow(comparison.previousRange, days),
    ]);

    return {
      window: comparison.metadata,
      current,
      previous,
      delta: {
        averageDAU: this.buildNumericDelta(
          current.averageDAU,
          previous.averageDAU,
        ),
      },
    };
  }

  async getReactionDistributionComparison(days: number = 7) {
    const comparison = this.getComparisonWindows(days);
    const [current, previous] = await Promise.all([
      this.getReactionDistributionForWindow(comparison.currentRange, days),
      this.getReactionDistributionForWindow(comparison.previousRange, days),
    ]);

    const reactionTypes = new Set([
      ...current.distribution.map((item) => item.type),
      ...previous.distribution.map((item) => item.type),
    ]);

    return {
      window: comparison.metadata,
      current,
      previous,
      delta: {
        total: this.buildNumericDelta(current.total, previous.total),
        byType: Array.from(reactionTypes)
          .sort()
          .map((type) => {
            const currentEntry = current.distribution.find(
              (item) => item.type === type,
            );
            const previousEntry = previous.distribution.find(
              (item) => item.type === type,
            );
            const currentCount = currentEntry?.count || 0;
            const previousCount = previousEntry?.count || 0;

            return {
              type,
              currentCount,
              previousCount,
              ...this.buildNumericDelta(currentCount, previousCount),
            };
          }),
      },
    };
  }

  // ─── Ranking quality drift (#267) ──────────────────────────────────────────
  //
  // Drift detection operates exclusively on aggregate counters. User-level
  // histories are never persisted: callers submit cohort totals, and only the
  // derived ratios plus the cohort size are retained (bounded by retention
  // limits). This keeps the privacy surface minimal while still surfacing
  // real-world ranking quality regressions.

  /**
   * Record aggregate counters for a ranking version. Rejects cohorts smaller
   * than the configured minimum so individual behaviour cannot be inferred.
   */
  recordRankingQualityAggregates(
    counters: RankingQualityAggregateCounters,
  ): { accepted: boolean; reason?: string } {
    if (counters.cohortSize < RANKING_QUALITY_DRIFT.MIN_COHORT_SIZE) {
      return {
        accepted: false,
        reason: `cohort size ${counters.cohortSize} below minimum ${RANKING_QUALITY_DRIFT.MIN_COHORT_SIZE}`,
      };
    }

    this.rankingQualityAggregates.set(counters.rankingVersion, {
      counters,
      recordedAt: new Date(),
    });
    this.enforceRankingQualityRetention();

    return { accepted: true };
  }

  /**
   * Evaluate drift for a ranking version against a baseline version using
   * aggregate indicators only. Returns `insufficient-cohort` when either
   * cohort is below the minimum size.
   */
  evaluateRankingQualityDrift(
    rankingVersion: string,
    baselineVersion: string,
  ): RankingQualityDriftResult {
    const evaluatedAt = new Date().toISOString();
    const currentEntry = this.rankingQualityAggregates.get(rankingVersion);
    const baselineEntry = this.rankingQualityAggregates.get(baselineVersion);

    if (!currentEntry || !baselineEntry) {
      return {
        status: 'insufficient-cohort',
        rankingVersion,
        cohortSize: currentEntry?.counters.cohortSize ?? 0,
        baseline: baselineEntry
          ? this.toRankingQualityIndicators(baselineEntry.counters)
          : null,
        current: currentEntry
          ? this.toRankingQualityIndicators(currentEntry.counters)
          : null,
        breaches: [],
        requiresReview: false,
        evaluatedAt,
      };
    }

    if (
      currentEntry.counters.cohortSize <
        RANKING_QUALITY_DRIFT.MIN_COHORT_SIZE ||
      baselineEntry.counters.cohortSize <
        RANKING_QUALITY_DRIFT.MIN_COHORT_SIZE
    ) {
      return {
        status: 'insufficient-cohort',
        rankingVersion,
        cohortSize: currentEntry.counters.cohortSize,
        baseline: this.toRankingQualityIndicators(baselineEntry.counters),
        current: this.toRankingQualityIndicators(currentEntry.counters),
        breaches: [],
        requiresReview: false,
        evaluatedAt,
      };
    }

    const baseline = this.toRankingQualityIndicators(baselineEntry.counters);
    const current = this.toRankingQualityIndicators(currentEntry.counters);

    const breaches: RankingQualityDriftResult['breaches'] = [];
    (
      Object.keys(RANKING_QUALITY_DRIFT.THRESHOLDS) as Array<
        keyof RankingQualityIndicators
      >
    ).forEach((metric) => {
      const threshold = RANKING_QUALITY_DRIFT.THRESHOLDS[metric];
      const baselineValue = baseline[metric];
      const currentValue = current[metric];
      if (baselineValue === 0) {
        return;
      }
      const relativeChange = (currentValue - baselineValue) / baselineValue;
      // A drop larger than the threshold (in magnitude) is a breach.
      if (relativeChange < -threshold) {
        breaches.push({
          metric,
          baseline: baselineValue,
          current: currentValue,
          relativeChange: parseFloat(relativeChange.toFixed(4)),
          threshold,
        });
      }
    });

    const status: DriftStatus =
      breaches.length > 0 ? 'drift-detected' : 'ok';

    return {
      status,
      rankingVersion,
      cohortSize: currentEntry.counters.cohortSize,
      baseline,
      current,
      breaches,
      requiresReview: status === 'drift-detected',
      evaluatedAt,
    };
  }

  /**
   * Admin review path: disable (or re-enable) a ranking version. Disabling is
   * the mechanism by which a drifting ranking version is rolled back.
   */
  reviewRankingVersion(
    rankingVersion: string,
    disable: boolean,
    reason: string,
  ): RankingVersionReview {
    const review: RankingVersionReview = {
      rankingVersion,
      disabled: disable,
      reason,
      reviewedAt: new Date().toISOString(),
    };

    if (disable) {
      this.disabledRankingVersions.set(rankingVersion, review);
      this.logger.warn(
        `Ranking version ${rankingVersion} disabled pending review: ${reason}`,
      );
    } else {
      this.disabledRankingVersions.delete(rankingVersion);
      this.logger.log(`Ranking version ${rankingVersion} re-enabled: ${reason}`);
    }

    return review;
  }

  /** Whether a ranking version is currently disabled by review. */
  isRankingVersionDisabled(rankingVersion: string): boolean {
    return this.disabledRankingVersions.get(rankingVersion)?.disabled === true;
  }

  /**
   * Enforce retention limits: drop aggregate entries older than the retention
   * window and cap the number of retained versions.
   */
  private enforceRankingQualityRetention(): void {
    const cutoff =
      Date.now() - RANKING_QUALITY_DRIFT.RETENTION_MS;

    for (const [version, entry] of this.rankingQualityAggregates) {
      if (entry.recordedAt.getTime() < cutoff) {
        this.rankingQualityAggregates.delete(version);
      }
    }

    while (
      this.rankingQualityAggregates.size >
      RANKING_QUALITY_DRIFT.RETENTION_LIMIT
    ) {
      const oldestKey = this.rankingQualityAggregates.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.rankingQualityAggregates.delete(oldestKey);
    }
  }

  /** Number of aggregate entries currently retained (for tests/ops). */
  getRetainedRankingQualityCount(): number {
    return this.rankingQualityAggregates.size;
  }

  private toRankingQualityIndicators(
    counters: RankingQualityAggregateCounters,
  ): RankingQualityIndicators {
    return {
      ctr:
        counters.impressions > 0
          ? counters.clicks / counters.impressions
          : 0,
      dwellMs:
        counters.dwellSamples > 0
          ? counters.dwellTotalMs / counters.dwellSamples
          : 0,
      satisfaction:
        counters.totalFeedback > 0
          ? counters.positiveFeedback / counters.totalFeedback
          : 0,
    };
  }

  // Helper method to calculate trend
  private calculateTrend(data: Array<{ count: number }>): TrendDirection {
    if (data.length < 2) return 'stable';

    const firstHalf = data.slice(0, Math.floor(data.length / 2));
    const secondHalf = data.slice(Math.floor(data.length / 2));

    const firstAvg =
      firstHalf.reduce((sum, item) => sum + Number(item.count), 0) /
      firstHalf.length;
    const secondAvg =
      secondHalf.reduce((sum, item) => sum + Number(item.count), 0) /
      secondHalf.length;

    const change = ((secondAvg - firstAvg) / firstAvg) * 100;

    if (change > 10) return 'increasing';
    if (change < -10) return 'decreasing';
    return 'stable';
  }

  private getCurrentWindow(days: number): AnalyticsWindowRange {
    const { startAt, endAt } = toWindowBoundaries(days);
    return { startAt, endAt };
  }

  private getComparisonWindows(days: number): {
    currentRange: AnalyticsWindowRange;
    previousRange: AnalyticsWindowRange;
    metadata: ComparisonWindowMetadata;
  } {
    const currentRange = this.getCurrentWindow(days);
    const rangeSpan =
      currentRange.endAt.getTime() - currentRange.startAt.getTime();
    const previousRange = {
      startAt: new Date(currentRange.startAt.getTime() - rangeSpan),
      endAt: new Date(currentRange.startAt.getTime()),
    };

    return {
      currentRange,
      previousRange,
      metadata: {
        requestedDays: days,
        bucketUnit: 'day',
        bucketCount: this.getDateBuckets(currentRange).length,
        current: {
          startAt: currentRange.startAt.toISOString(),
          endAt: currentRange.endAt.toISOString(),
        },
        previous: {
          startAt: previousRange.startAt.toISOString(),
          endAt: previousRange.endAt.toISOString(),
        },
      },
    };
  }

  private async getGrowthMetricsForWindow(
    range: AnalyticsWindowRange,
    days: number,
  ): Promise<GrowthMetrics> {
    const rawGrowth = await this.confessionRepository
      .createQueryBuilder('confession')
      .select("DATE(confession.created_at AT TIME ZONE 'UTC')", 'date')
      .addSelect('COUNT(*)', 'count')
      .where('confession.created_at >= :startAt', { startAt: range.startAt })
      .andWhere('confession.created_at < :endAt', { endAt: range.endAt })
      .andWhere('confession.isDeleted = false')
      .groupBy("DATE(confession.created_at AT TIME ZONE 'UTC')")
      .orderBy('date', 'ASC')
      .getRawMany<BucketCountRow>();

    const dailyGrowth = this.getDateBuckets(range).map((date) => {
      const count = this.findBucketCount(rawGrowth, date);
      const suppressed = count < ANALYTICS_PRIVACY.MIN_COHORT_SIZE && count > 0;
      return {
        date,
        count,
        ...(suppressed && { suppressed }),
      };
    });
    const totalConfessions = dailyGrowth.reduce(
      (sum, item) => sum + item.count,
      0,
    );

    return {
      period: `${days} days`,
      totalConfessions,
      averagePerDay: parseFloat((totalConfessions / days).toFixed(2)),
      dailyGrowth,
      trend: this.calculateTrend(dailyGrowth),
    };
  }

  private async getUserActivityForWindow(
    range: AnalyticsWindowRange,
    days: number,
  ): Promise<UserActivityMetrics> {
    const rawActivityRows: unknown =
      await this.confessionRepository.manager.query(
        `
        SELECT activity.date::text AS date,
               COUNT(DISTINCT activity.anonymous_user_id)::int AS "activeUsers"
        FROM (
          SELECT DATE(confession.created_at AT TIME ZONE 'UTC') AS date,
                 confession.anonymous_user_id
          FROM anonymous_confessions confession
          WHERE confession.created_at >= $1 AND confession.created_at < $2
          UNION ALL
          SELECT DATE(reaction.created_at AT TIME ZONE 'UTC') AS date,
                 reaction.anonymous_user_id
          FROM reaction reaction
          WHERE reaction.created_at >= $1 AND reaction.created_at < $2
        ) activity
        GROUP BY activity.date
        ORDER BY activity.date ASC
      `,
        [range.startAt, range.endAt],
      );
    const activityRows = this.toBucketRows(rawActivityRows, 'activeUsers');

    const dailyActivity = this.getDateBuckets(range).map((date) => {
      const activeUsers = this.findBucketCount(activityRows, date, 'activeUsers');
      const suppressed = activeUsers < ANALYTICS_PRIVACY.MIN_COHORT_SIZE && activeUsers > 0;
      return {
        date,
        activeUsers,
        ...(suppressed && { suppressed }),
      };
    });
    const totalActiveUsers = dailyActivity.reduce(
      (sum, item) => sum + item.activeUsers,
      0,
    );

    return {
      period: `${days} days`,
      dailyActivity,
      averageDAU: parseFloat(
        (totalActiveUsers / dailyActivity.length || 0).toFixed(2),
      ),
    };
  }

  private async getReactionDistributionForWindow(
    range: AnalyticsWindowRange,
    days: number,
  ): Promise<ReactionDistributionMetrics> {
    const distribution = await this.reactionRepository
      .createQueryBuilder('reaction')
      .innerJoin('reaction.confession', 'confession')
      .select('reaction.emoji', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('reaction.createdAt >= :startAt', { startAt: range.startAt })
      .andWhere('reaction.createdAt < :endAt', { endAt: range.endAt })
      .andWhere('confession.isDeleted = false')
      .groupBy('reaction.emoji')
      .orderBy('type', 'ASC')
      .getRawMany<ReactionDistributionRow>();

    const total = distribution.reduce(
      (sum, item) => sum + parseInt(item.count, 10),
      0,
    );

    return {
      total,
      distribution: distribution.map((item) => {
        const count = parseInt(item.count, 10);
        const suppressed = count < ANALYTICS_PRIVACY.MIN_COHORT_SIZE && count > 0;
        return {
          type: item.type,
          count,
          percentage: total > 0 ? ((count / total) * 100).toFixed(2) : '0.00',
          ...(suppressed && { suppressed }),
        };
      }),
      period: `${days} days`,
    };
  }

  private buildNumericDelta(current: number, previous: number) {
    const absoluteChange = parseFloat((current - previous).toFixed(2));
    const percentageChange =
      previous === 0
        ? null
        : parseFloat((((current - previous) / previous) * 100).toFixed(2));

    return {
      absoluteChange,
      percentageChange,
    };
  }

  private findBucketCount(
    rows: Array<Record<string, string | number>>,
    date: string,
    valueKey = 'count',
  ): number {
    const match = rows.find((row) => String(row.date) === date);
    if (!match) {
      return 0;
    }

    return parseInt(String(match[valueKey] || 0), 10);
  }

  private toBucketRows(
    rows: unknown,
    valueKey: string,
  ): Array<Record<string, string | number>> {
    if (!Array.isArray(rows)) {
      return [];
    }

    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') {
        return [];
      }

      const record = row as Record<string, unknown>;
      const dateValue = record.date;
      const bucketValue = record[valueKey];

      if (
        typeof dateValue !== 'string' ||
        (typeof bucketValue !== 'string' && typeof bucketValue !== 'number')
      ) {
        return [];
      }

      return [{ date: dateValue, [valueKey]: bucketValue }];
    });
  }

  private getDateBuckets(range: AnalyticsWindowRange): string[] {
    const dates: string[] = [];
    const cursor = new Date(range.startAt.getTime());

    while (cursor.getTime() < range.endAt.getTime()) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return dates;
  }

  // ─── Targeted cache invalidation ───────────────────────────────────────────
  //
  // Each method invalidates only the segment that is affected by a given type
  // of mutation. Callers should prefer these over the full-flush invalidateCache().
  // All methods are fire-and-forget safe (errors are absorbed and logged by
  // CacheService.invalidateSegment).

  async invalidateTrendingCache(reason = 'mutation'): Promise<void> {
    this.logger.log(
      `Invalidating trending analytics cache (reason: ${reason})`,
    );
    await this.cacheService.invalidateSegment(
      InvalidationPrefixes.analyticsTrending,
      reason,
    );
  }

  async invalidateReactionDistributionCache(
    reason = 'mutation',
  ): Promise<void> {
    this.logger.log(
      `Invalidating reaction distribution cache (reason: ${reason})`,
    );
    await this.cacheService.invalidateSegment(
      InvalidationPrefixes.analyticsReactions,
      reason,
    );
  }

  async invalidateGrowthCache(reason = 'mutation'): Promise<void> {
    this.logger.log(`Invalidating growth metrics cache (reason: ${reason})`);
    await this.cacheService.invalidateSegment(
      InvalidationPrefixes.analyticsGrowth,
      reason,
    );
  }

  async invalidateUserActivityCache(reason = 'mutation'): Promise<void> {
    this.logger.log(`Invalidating user activity cache (reason: ${reason})`);
    await this.cacheService.invalidateSegment(
      InvalidationPrefixes.analyticsUsers,
      reason,
    );
  }

  async invalidateStatsCache(reason = 'mutation'): Promise<void> {
    this.logger.log(`Invalidating platform stats cache (reason: ${reason})`);
    // Use the namespace-compliant cache key for single key deletion
    await this.cacheService.del(AnalyticsCacheKeys.stats());
  }

  /**
   * Full-flush fallback retained for backward compatibility and admin use.
   * Prefer the targeted methods above for routine mutation-driven invalidation.
   */
  async invalidateCache(): Promise<void> {
    this.logger.warn('Full analytics cache flush requested');
    await Promise.all([
      this.invalidateTrendingCache('full-flush'),
      this.invalidateReactionDistributionCache('full-flush'),
      this.invalidateGrowthCache('full-flush'),
      this.invalidateUserActivityCache('full-flush'),
      this.invalidateStatsCache('full-flush'),
    ]);
  }
}
