import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RankingDriftService,
  RankingDriftConfig,
  DEFAULT_RANKING_DRIFT_CONFIG,
} from './ranking-drift.service';
import {
  RankingDriftSnapshot,
  RankingDriftReview,
  RankingDriftReviewStatus,
} from './entities/ranking-drift.entity';

describe('RankingDriftService', () => {
  let service: RankingDriftService;
  let snapshotRepo: jest.Mocked<Repository<RankingDriftSnapshot>>;
  let reviewRepo: jest.Mocked<Repository<RankingDriftReview>>;

  const config: RankingDriftConfig = {
    ...DEFAULT_RANKING_DRIFT_CONFIG,
    minimumCohortSize: 50,
    retentionDays: 30,
    driftThreshold: 0.15,
    maxSnapshotsPerVersion: 100,
  };

  const buildSnapshotRepo = () =>
    ({
      create: jest.fn((dto) => dto),
      save: jest.fn(async (dto) => ({ id: 'snap-1', ...dto })),
      find: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      delete: jest.fn(async () => ({ affected: 0 })),
      createQueryBuilder: jest.fn(),
    }) as unknown as jest.Mocked<Repository<RankingDriftSnapshot>>;

  const buildReviewRepo = () =>
    ({
      create: jest.fn((dto) => dto),
      save: jest.fn(async (dto) => ({ id: 'review-1', ...dto })),
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      update: jest.fn(async () => ({ affected: 1 })),
    }) as unknown as jest.Mocked<Repository<RankingDriftReview>>;

  beforeEach(async () => {
    snapshotRepo = buildSnapshotRepo();
    reviewRepo = buildReviewRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RankingDriftService,
        { provide: getRepositoryToken(RankingDriftSnapshot), useValue: snapshotRepo },
        { provide: getRepositoryToken(RankingDriftReview), useValue: reviewRepo },
        { provide: 'RANKING_DRIFT_CONFIG', useValue: config },
      ],
    }).compile();

    service = module.get<RankingDriftService>(RankingDriftService);
  });

  describe('aggregate computation', () => {
    it('computes aggregate indicators from cohort events without retaining user-level history', async () => {
      const events = [
        { rankingVersion: 'v1', position: 1, clicked: true, dwellMs: 5000 },
        { rankingVersion: 'v1', position: 2, clicked: false, dwellMs: 0 },
        { rankingVersion: 'v1', position: 1, clicked: true, dwellMs: 3000 },
        { rankingVersion: 'v1', position: 3, clicked: true, dwellMs: 1000 },
      ];

      const aggregate = await service.computeAggregate('v1', events);

      expect(aggregate.rankingVersion).toBe('v1');
      expect(aggregate.cohortSize).toBe(4);
      expect(aggregate.clickThroughRate).toBeCloseTo(0.75, 5);
      expect(aggregate.meanReciprocalRank).toBeGreaterThan(0);
      expect(aggregate.meanDwellMs).toBeCloseTo(2250, 5);
      // Ensure no per-user identifiers are persisted in the aggregate
      expect(JSON.stringify(aggregate)).not.toMatch(/userId|user_id|sessionId/);
    });

    it('returns zeroed indicators for an empty cohort', async () => {
      const aggregate = await service.computeAggregate('v1', []);
      expect(aggregate.cohortSize).toBe(0);
      expect(aggregate.clickThroughRate).toBe(0);
      expect(aggregate.meanReciprocalRank).toBe(0);
    });
  });

  describe('insufficient cohort rejection', () => {
    it('rejects evaluation when cohort size is below the minimum', async () => {
      const events = Array.from({ length: config.minimumCohortSize - 1 }, (_, i) => ({
        rankingVersion: 'v1',
        position: 1,
        clicked: i % 2 === 0,
        dwellMs: 1000,
      }));

      await expect(service.evaluateDrift('v1', events)).rejects.toThrow(
        /insufficient cohort/i,
      );
      expect(snapshotRepo.save).not.toHaveBeenCalled();
    });

    it('accepts evaluation when cohort size meets the minimum', async () => {
      const events = Array.from({ length: config.minimumCohortSize }, (_, i) => ({
        rankingVersion: 'v1',
        position: 1,
        clicked: i % 2 === 0,
        dwellMs: 1000,
      }));

      const result = await service.evaluateDrift('v1', events);
      expect(result).toBeDefined();
      expect(snapshotRepo.save).toHaveBeenCalled();
    });
  });

  describe('threshold breach triggering review', () => {
    it('opens a review when drift exceeds the configured threshold', async () => {
      const baseline = {
        rankingVersion: 'v1',
        cohortSize: 100,
        clickThroughRate: 0.5,
        meanReciprocalRank: 0.8,
        meanDwellMs: 4000,
      };
      jest.spyOn(service, 'getBaseline').mockResolvedValue(baseline as any);

      const events = Array.from({ length: 100 }, (_, i) => ({
        rankingVersion: 'v1',
        position: 1,
        clicked: i < 10, // CTR 0.1 vs baseline 0.5 -> large drift
        dwellMs: 500,
      }));

      const result = await service.evaluateDrift('v1', events);

      expect(result.driftDetected).toBe(true);
      expect(result.driftScore).toBeGreaterThan(config.driftThreshold);
      expect(reviewRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          rankingVersion: 'v1',
          status: RankingDriftReviewStatus.OPEN,
        }),
      );
    });

    it('does not open a review when drift is within the threshold', async () => {
      const baseline = {
        rankingVersion: 'v1',
        cohortSize: 100,
        clickThroughRate: 0.5,
        meanReciprocalRank: 0.8,
        meanDwellMs: 4000,
      };
      jest.spyOn(service, 'getBaseline').mockResolvedValue(baseline as any);

      const events = Array.from({ length: 100 }, (_, i) => ({
        rankingVersion: 'v1',
        position: 1,
        clicked: i < 50,
        dwellMs: 4000,
      }));

      const result = await service.evaluateDrift('v1', events);

      expect(result.driftDetected).toBe(false);
      expect(reviewRepo.save).not.toHaveBeenCalled();
    });

    it('disables a ranking version when a review is resolved as disabled', async () => {
      reviewRepo.findOne.mockResolvedValue({
        id: 'review-1',
        rankingVersion: 'v1',
        status: RankingDriftReviewStatus.OPEN,
      } as any);

      const result = await service.resolveReview('review-1', {
        status: RankingDriftReviewStatus.DISABLED,
        reviewer: 'ops@example.com',
        reason: 'sustained drift',
      });

      expect(result.status).toBe(RankingDriftReviewStatus.DISABLED);
      expect(reviewRepo.update).toHaveBeenCalledWith(
        'review-1',
        expect.objectContaining({ status: RankingDriftReviewStatus.DISABLED }),
      );
    });

    it('rejects resolving a review that does not exist', async () => {
      reviewRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resolveReview('missing', {
          status: RankingDriftReviewStatus.DISABLED,
          reviewer: 'ops@example.com',
          reason: 'n/a',
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('retention enforcement', () => {
    it('deletes snapshots older than the retention window', async () => {
      const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
      const qb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => ({ affected: 7 })),
      };
      snapshotRepo.createQueryBuilder.mockReturnValue(qb as any);

      const removed = await service.enforceRetention();

      expect(removed).toBe(7);
      expect(qb.where).toHaveBeenCalledWith(
        'createdAt < :cutoff',
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
      const passedCutoff = (qb.where as jest.Mock).mock.calls[0][1].cutoff as Date;
      expect(passedCutoff.getTime()).toBeLessThanOrEqual(cutoff.getTime() + 1000);
    });

    it('caps the number of snapshots retained per ranking version', async () => {
      snapshotRepo.count.mockResolvedValue(config.maxSnapshotsPerVersion + 5);
      const qb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => ({ affected: 5 })),
      };
      snapshotRepo.createQueryBuilder.mockReturnValue(qb as any);

      const removed = await service.enforceRetention('v1');

      expect(removed).toBeGreaterThanOrEqual(0);
      expect(snapshotRepo.count).toHaveBeenCalledWith({
        where: { rankingVersion: 'v1' },
      });
    });
  });
});