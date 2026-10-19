import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  CrossDomainIntegrityService,
  CrossDomainIntegrityErrorCode,
} from './cross-domain-integrity.service';

describe('CrossDomainIntegrityService', () => {
  let service: CrossDomainIntegrityService;
  let mockDataSource: {
    query: jest.Mock;
    getMetadata: jest.Mock;
  };
  let mockConfigService: {
    get: jest.Mock;
  };

  beforeEach(async () => {
    mockDataSource = {
      query: jest.fn().mockResolvedValue([]),
      getMetadata: jest.fn().mockImplementation((entity) => ({
        tableName: entity.name.toLowerCase(),
      })),
    };

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'integrity.defaultTimeoutMs') return 5000;
        if (key === 'integrity.maxTimeoutMs') return 30000;
        if (key === 'integrity.defaultLimit') return 50;
        if (key === 'integrity.maxLimit') return 200;
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrossDomainIntegrityService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<CrossDomainIntegrityService>(
      CrossDomainIntegrityService,
    );
  });

  describe('runIntegrityReport - expected clean path', () => {
    it('returns a clean report with all checks PASSED when no invariant violations exist', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const report = await service.runIntegrityReport();

      expect(report.reportId).toBeDefined();
      expect(report.generatedAt).toBeDefined();
      expect(report.summary.totalChecks).toBeGreaterThan(0);
      expect(report.summary.passedChecks).toBe(report.summary.totalChecks);
      expect(report.summary.failedChecks).toBe(0);
      expect(report.summary.totalViolations).toBe(0);
      expect(report.bounded.truncated).toBe(false);
      expect(report.checks.every((c) => c.status === 'PASSED')).toBe(true);
    });
  });

  describe('runIntegrityReport - domain filtering', () => {
    it('only executes checks for specified domains', async () => {
      mockDataSource.query.mockResolvedValue([]);

      const report = await service.runIntegrityReport({
        domains: ['identity'],
      });

      expect(report.summary.totalChecks).toBe(2);
      expect(report.checks.every((c) => c.domain === 'identity')).toBe(true);
    });
  });

  describe('runIntegrityReport - violation detection & repair guidance', () => {
    it('detects identity orphan links with stable code and repair guidance', async () => {
      mockDataSource.query.mockImplementation(async (query: string) => {
        if (query.includes('l.user_id = u.id')) {
          return [{ recordId: 'link-123', refId: 999 }];
        }
        return [];
      });

      const report = await service.runIntegrityReport({
        domains: ['identity'],
      });

      const failedCheck = report.checks.find(
        (c) => c.name === 'identity_orphan_user_link',
      );
      expect(failedCheck).toBeDefined();
      expect(failedCheck?.status).toBe('FAILED');
      expect(failedCheck?.violationsCount).toBe(1);
      expect(failedCheck?.violations[0].code).toBe(
        CrossDomainIntegrityErrorCode.IDENTITY_ORPHAN_USER_LINK,
      );
      expect(failedCheck?.violations[0].repairGuidance).toContain('DELETE FROM');
      expect(failedCheck?.violations[0].recordId).toBe('link-123');
    });

    it('detects content orphan anonymous author with CRITICAL severity', async () => {
      mockDataSource.query.mockImplementation(async (query: string) => {
        if (query.includes('c.anonymous_user_id = a.id')) {
          return [{ recordId: 'conf-1', refId: 'anon-missing-uuid' }];
        }
        return [];
      });

      const report = await service.runIntegrityReport({
        domains: ['content'],
      });

      const check = report.checks.find(
        (c) => c.name === 'content_orphan_anonymous_author',
      );
      expect(check?.status).toBe('FAILED');
      expect(check?.violations[0].code).toBe(
        CrossDomainIntegrityErrorCode.CONTENT_ORPHAN_ANONYMOUS_AUTHOR,
      );
      expect(check?.violations[0].severity).toBe('CRITICAL');
      expect(check?.violations[0].repairGuidance).toContain('DELETE FROM');
    });

    it('detects export chunk count mismatch and provides repair guidance', async () => {
      mockDataSource.query.mockImplementation(async (query: string) => {
        if (query.includes('HAVING e."chunkCount" != COUNT(c.id)')) {
          return [
            {
              recordId: 'export-req-1',
              expectedCount: 5,
              actualCount: 3,
            },
          ];
        }
        return [];
      });

      const report = await service.runIntegrityReport({
        domains: ['export'],
      });

      const check = report.checks.find(
        (c) => c.name === 'export_chunk_count_mismatch',
      );
      expect(check?.status).toBe('FAILED');
      expect(check?.violations[0].code).toBe(
        CrossDomainIntegrityErrorCode.EXPORT_CHUNK_COUNT_MISMATCH,
      );
      expect(check?.violations[0].severity).toBe('CRITICAL');
      expect(check?.violations[0].details?.expectedChunks).toBe(5);
      expect(check?.violations[0].details?.actualChunks).toBe(3);
    });

    it('detects moderation orphan report target', async () => {
      mockDataSource.query.mockImplementation(async (query: string) => {
        if (query.includes('r.confession_id = c.id')) {
          return [{ recordId: 'rep-42', refId: 'conf-gone' }];
        }
        return [];
      });

      const report = await service.runIntegrityReport({
        domains: ['moderation'],
      });

      const check = report.checks.find(
        (c) => c.name === 'moderation_orphan_report_confession',
      );
      expect(check?.status).toBe('FAILED');
      expect(check?.violations[0].code).toBe(
        CrossDomainIntegrityErrorCode.MODERATION_ORPHAN_REPORT_CONFESSION,
      );
      expect(check?.violations[0].repairGuidance).toContain(
        'UPDATE "report" SET status = \'dismissed\'',
      );
    });
  });

  describe('runIntegrityReport - failure semantics & bounds', () => {
    it('captures database query errors without throwing, marking check as FAILED', async () => {
      mockDataSource.query.mockRejectedValueOnce(
        new Error('Database connection reset'),
      );

      const report = await service.runIntegrityReport({
        domains: ['identity'],
      });

      expect(report.summary.totalChecks).toBe(2);
      expect(report.checks[0].status).toBe('FAILED');
      expect(report.checks[0].errorMessage).toContain(
        'Database connection reset',
      );
    });

    it('respects row limits and clamps them within configured max bounds', async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.runIntegrityReport({
        domains: ['identity'],
        limit: 9999, // Should clamp to maxLimit (200)
      });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.any(String),
        [200],
      );
    });

    it('handles timeout when budget is exceeded and marks truncated report', async () => {
      const report = await service.runIntegrityReport({
        domains: ['identity', 'content'],
        timeoutMs: -1, // immediate timeout
      });

      expect(report.bounded.truncated).toBe(true);
      expect(report.checks.length).toBe(0);
    });
  });
});
