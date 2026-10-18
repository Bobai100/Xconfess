import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { AnonymousUser } from '../../user/entities/anonymous-user.entity';
import { UserAnonymousUser } from '../../user/entities/user-anonymous-link.entity';
import { AnonymousConfession } from '../../confession/entities/confession.entity';
import { Comment } from '../../comment/entities/comment.entity';
import { ExportRequest } from '../../data-export/entities/export-request.entity';
import { ExportChunk } from '../../data-export/entities/export-chunk.entity';
import { Report } from '../entities/report.entity';
import { ModerationEvidence } from '../../moderation/entities/moderation-evidence.entity';

export enum CrossDomainIntegrityErrorCode {
  IDENTITY_ORPHAN_USER_LINK = 'ERR_INTEGRITY_IDENTITY_ORPHAN_USER_LINK',
  IDENTITY_ORPHAN_ANONYMOUS_LINK = 'ERR_INTEGRITY_IDENTITY_ORPHAN_ANONYMOUS_LINK',
  CONTENT_ORPHAN_ANONYMOUS_AUTHOR = 'ERR_INTEGRITY_CONTENT_ORPHAN_ANONYMOUS_AUTHOR',
  CONTENT_ORPHAN_COMMENT_CONFESSION = 'ERR_INTEGRITY_CONTENT_ORPHAN_COMMENT_CONFESSION',
  EXPORT_ORPHAN_USER = 'ERR_INTEGRITY_EXPORT_ORPHAN_USER',
  EXPORT_CHUNK_COUNT_MISMATCH = 'ERR_INTEGRITY_EXPORT_CHUNK_COUNT_MISMATCH',
  EXPORT_ORPHAN_CHUNK = 'ERR_INTEGRITY_EXPORT_ORPHAN_CHUNK',
  MODERATION_ORPHAN_REPORT_CONFESSION = 'ERR_INTEGRITY_MODERATION_ORPHAN_REPORT_CONFESSION',
  MODERATION_ORPHAN_REPORTER_USER = 'ERR_INTEGRITY_MODERATION_ORPHAN_REPORTER_USER',
  MODERATION_ORPHAN_REPORTER_ANONYMOUS = 'ERR_INTEGRITY_MODERATION_ORPHAN_REPORTER_ANONYMOUS',
  MODERATION_ORPHAN_EVIDENCE_TARGET = 'ERR_INTEGRITY_MODERATION_ORPHAN_EVIDENCE_TARGET',
}

export type IntegrityDomain = 'identity' | 'content' | 'export' | 'moderation';

export type CheckStatus = 'PASSED' | 'FAILED' | 'TIMEOUT';

export interface InvariantViolation {
  code: CrossDomainIntegrityErrorCode;
  domain: IntegrityDomain;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  recordId: string;
  description: string;
  repairGuidance: string;
  details?: Record<string, unknown>;
}

export interface InvariantCheckResult {
  name: string;
  domain: IntegrityDomain;
  status: CheckStatus;
  violationsCount: number;
  violations: InvariantViolation[];
  errorMessage?: string;
  durationMs: number;
}

export interface CrossDomainIntegrityReport {
  reportId: string;
  generatedAt: string;
  executionDurationMs: number;
  bounded: {
    limitPerCheck: number;
    timeoutMs: number;
    truncated: boolean;
  };
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    totalViolations: number;
  };
  checks: InvariantCheckResult[];
}

export interface IntegrityReportOptions {
  domains?: IntegrityDomain[];
  limit?: number;
  timeoutMs?: number;
}

@Injectable()
export class CrossDomainIntegrityService {
  private readonly logger = new Logger(CrossDomainIntegrityService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Run read-only cross-domain integrity verification with bounded execution.
   */
  async runIntegrityReport(
    options: IntegrityReportOptions = {},
  ): Promise<CrossDomainIntegrityReport> {
    const startTime = Date.now();
    const reportId = `rep-integrity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const defaultTimeout =
      this.configService.get<number>('integrity.defaultTimeoutMs') ?? 5000;
    const maxTimeout =
      this.configService.get<number>('integrity.maxTimeoutMs') ?? 30000;
    const defaultLimit =
      this.configService.get<number>('integrity.defaultLimit') ?? 50;
    const maxLimit =
      this.configService.get<number>('integrity.maxLimit') ?? 200;

    const timeoutMs = Math.min(
      Math.max(Number(options.timeoutMs ?? defaultTimeout), 100),
      maxTimeout,
    );
    const limit = Math.min(
      Math.max(Number(options.limit ?? defaultLimit), 1),
      maxLimit,
    );

    const targetDomains: IntegrityDomain[] =
      options.domains && options.domains.length > 0
        ? options.domains
        : ['identity', 'content', 'export', 'moderation'];

    const checksToRun: Array<() => Promise<InvariantCheckResult>> = [];

    if (targetDomains.includes('identity')) {
      checksToRun.push(
        () => this.checkIdentityOrphanUserLinks(limit),
        () => this.checkIdentityOrphanAnonymousLinks(limit),
      );
    }

    if (targetDomains.includes('content')) {
      checksToRun.push(
        () => this.checkContentOrphanAnonymousAuthor(limit),
        () => this.checkContentOrphanCommentConfession(limit),
      );
    }

    if (targetDomains.includes('export')) {
      checksToRun.push(
        () => this.checkExportOrphanUser(limit),
        () => this.checkExportChunkCountMismatch(limit),
        () => this.checkExportOrphanChunk(limit),
      );
    }

    if (targetDomains.includes('moderation')) {
      checksToRun.push(
        () => this.checkModerationOrphanReportConfession(limit),
        () => this.checkModerationOrphanReporterUser(limit),
        () => this.checkModerationOrphanReporterAnonymous(limit),
        () => this.checkModerationOrphanEvidenceTarget(limit),
      );
    }

    let isTruncated = false;
    const results: InvariantCheckResult[] = [];

    for (const checkFn of checksToRun) {
      const elapsed = Date.now() - startTime;
      const remainingTimeout = timeoutMs - elapsed;

      if (remainingTimeout <= 0) {
        isTruncated = true;
        break;
      }

      const result = await this.executeWithTimeout(checkFn, remainingTimeout);
      results.push(result);
    }

    const totalViolations = results.reduce(
      (sum, c) => sum + c.violationsCount,
      0,
    );
    const failedChecks = results.filter((c) => c.status !== 'PASSED').length;
    const passedChecks = results.filter((c) => c.status === 'PASSED').length;

    return {
      reportId,
      generatedAt: new Date().toISOString(),
      executionDurationMs: Date.now() - startTime,
      bounded: {
        limitPerCheck: limit,
        timeoutMs,
        truncated: isTruncated,
      },
      summary: {
        totalChecks: results.length,
        passedChecks,
        failedChecks,
        totalViolations,
      },
      checks: results,
    };
  }

  private async executeWithTimeout(
    fn: () => Promise<InvariantCheckResult>,
    timeoutMs: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    let timer: NodeJS.Timeout | null = null;

    try {
      const checkPromise = fn();
      const timeoutPromise = new Promise<InvariantCheckResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            name: 'Check execution timeout',
            domain: 'identity',
            status: 'TIMEOUT',
            violationsCount: 0,
            violations: [],
            errorMessage: `Check exceeded remaining budget of ${timeoutMs}ms`,
            durationMs: Date.now() - start,
          });
        }, timeoutMs);
      });

      const result = await Promise.race([checkPromise, timeoutPromise]);
      return result;
    } catch (err: any) {
      return {
        name: 'Check execution failure',
        domain: 'identity',
        status: 'FAILED',
        violationsCount: 0,
        violations: [],
        errorMessage: err?.message || 'Unknown database query failure',
        durationMs: Date.now() - start,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------- IDENTITY CHECKS ----------------

  private async checkIdentityOrphanUserLinks(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const userTable = this.getTableName(User);
    const linkTable = this.getTableName(UserAnonymousUser);

    const query = `
      SELECT l.id as "recordId", l.user_id as "refId"
      FROM "${linkTable}" l
      LEFT JOIN "${userTable}" u ON l.user_id = u.id
      WHERE u.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.IDENTITY_ORPHAN_USER_LINK,
      domain: 'identity',
      severity: 'HIGH',
      recordId: String(r.recordId),
      description: `User-to-anonymous link ${r.recordId} references non-existent user_id ${r.refId}`,
      repairGuidance: `Remove orphan link record: DELETE FROM "${linkTable}" WHERE id = '${r.recordId}';`,
      details: { orphanUserId: r.refId },
    }));

    return {
      name: 'identity_orphan_user_link',
      domain: 'identity',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkIdentityOrphanAnonymousLinks(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const anonTable = this.getTableName(AnonymousUser);
    const linkTable = this.getTableName(UserAnonymousUser);

    const query = `
      SELECT l.id as "recordId", l.anonymous_user_id as "refId"
      FROM "${linkTable}" l
      LEFT JOIN "${anonTable}" a ON l.anonymous_user_id = a.id
      WHERE a.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.IDENTITY_ORPHAN_ANONYMOUS_LINK,
      domain: 'identity',
      severity: 'HIGH',
      recordId: String(r.recordId),
      description: `User-to-anonymous link ${r.recordId} references non-existent anonymous_user_id ${r.refId}`,
      repairGuidance: `Remove orphan link record: DELETE FROM "${linkTable}" WHERE id = '${r.recordId}';`,
      details: { orphanAnonymousUserId: r.refId },
    }));

    return {
      name: 'identity_orphan_anonymous_link',
      domain: 'identity',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  // ---------------- CONTENT CHECKS ----------------

  private async checkContentOrphanAnonymousAuthor(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const anonTable = this.getTableName(AnonymousUser);
    const confTable = this.getTableName(AnonymousConfession);

    const query = `
      SELECT c.id as "recordId", c.anonymous_user_id as "refId"
      FROM "${confTable}" c
      LEFT JOIN "${anonTable}" a ON c.anonymous_user_id = a.id
      WHERE a.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.CONTENT_ORPHAN_ANONYMOUS_AUTHOR,
      domain: 'content',
      severity: 'CRITICAL',
      recordId: String(r.recordId),
      description: `Confession ${r.recordId} references missing author anonymous_user_id ${r.refId}`,
      repairGuidance: `Create replacement tombstone anonymous user or purge: DELETE FROM "${confTable}" WHERE id = '${r.recordId}';`,
      details: { orphanAuthorId: r.refId },
    }));

    return {
      name: 'content_orphan_anonymous_author',
      domain: 'content',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkContentOrphanCommentConfession(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const confTable = this.getTableName(AnonymousConfession);
    const commentTable = this.getTableName(Comment);

    const query = `
      SELECT cm.id as "recordId", cm.confession_id as "refId"
      FROM "${commentTable}" cm
      LEFT JOIN "${confTable}" c ON cm.confession_id = c.id
      WHERE c.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.CONTENT_ORPHAN_COMMENT_CONFESSION,
      domain: 'content',
      severity: 'MEDIUM',
      recordId: String(r.recordId),
      description: `Comment ${r.recordId} references non-existent confession ${r.refId}`,
      repairGuidance: `Purge orphan comment: DELETE FROM "${commentTable}" WHERE id = '${r.recordId}';`,
      details: { orphanConfessionId: r.refId },
    }));

    return {
      name: 'content_orphan_comment_confession',
      domain: 'content',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  // ---------------- EXPORT CHECKS ----------------

  private async checkExportOrphanUser(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const userTable = this.getTableName(User);
    const exportReqTable = this.getTableName(ExportRequest);

    const query = `
      SELECT e.id as "recordId", e.user_id as "refId"
      FROM "${exportReqTable}" e
      LEFT JOIN "${userTable}" u ON CAST(e.user_id AS TEXT) = CAST(u.id AS TEXT)
      WHERE u.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.EXPORT_ORPHAN_USER,
      domain: 'export',
      severity: 'HIGH',
      recordId: String(r.recordId),
      description: `Export request ${r.recordId} targets non-existent user ${r.refId}`,
      repairGuidance: `Purge privacy export request: DELETE FROM "${exportReqTable}" WHERE id = '${r.recordId}';`,
      details: { orphanUserId: r.refId },
    }));

    return {
      name: 'export_orphan_user',
      domain: 'export',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkExportChunkCountMismatch(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const exportReqTable = this.getTableName(ExportRequest);
    const chunkTable = this.getTableName(ExportChunk);

    const query = `
      SELECT e.id as "recordId", e."chunkCount" as "expectedCount", COUNT(c.id) as "actualCount"
      FROM "${exportReqTable}" e
      LEFT JOIN "${chunkTable}" c ON c."exportRequestId" = e.id
      WHERE e."isChunked" = true AND e.status IN ('READY', 'COMPLETED')
      GROUP BY e.id, e."chunkCount"
      HAVING e."chunkCount" != COUNT(c.id)
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.EXPORT_CHUNK_COUNT_MISMATCH,
      domain: 'export',
      severity: 'CRITICAL',
      recordId: String(r.recordId),
      description: `Chunked export request ${r.recordId} expected ${r.expectedCount} chunks but found ${r.actualCount}`,
      repairGuidance: `Mark corrupted export request as failed: UPDATE "${exportReqTable}" SET status = 'FAILED', "lastFailureReason" = 'Corrupted chunk count' WHERE id = '${r.recordId}';`,
      details: {
        expectedChunks: Number(r.expectedCount),
        actualChunks: Number(r.actualCount),
      },
    }));

    return {
      name: 'export_chunk_count_mismatch',
      domain: 'export',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkExportOrphanChunk(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const exportReqTable = this.getTableName(ExportRequest);
    const chunkTable = this.getTableName(ExportChunk);

    const query = `
      SELECT c.id as "recordId", c."exportRequestId" as "refId"
      FROM "${chunkTable}" c
      LEFT JOIN "${exportReqTable}" e ON c."exportRequestId" = e.id
      WHERE e.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.EXPORT_ORPHAN_CHUNK,
      domain: 'export',
      severity: 'HIGH',
      recordId: String(r.recordId),
      description: `Export chunk ${r.recordId} references missing parent export request ${r.refId}`,
      repairGuidance: `Purge orphan export chunk: DELETE FROM "${chunkTable}" WHERE id = '${r.recordId}';`,
      details: { orphanExportRequestId: r.refId },
    }));

    return {
      name: 'export_orphan_chunk',
      domain: 'export',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  // ---------------- MODERATION CHECKS ----------------

  private async checkModerationOrphanReportConfession(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const confTable = this.getTableName(AnonymousConfession);
    const reportTable = this.getTableName(Report);

    const query = `
      SELECT r.id as "recordId", r.confession_id as "refId"
      FROM "${reportTable}" r
      LEFT JOIN "${confTable}" c ON r.confession_id = c.id
      WHERE c.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.MODERATION_ORPHAN_REPORT_CONFESSION,
      domain: 'moderation',
      severity: 'MEDIUM',
      recordId: String(r.recordId),
      description: `Report ${r.recordId} targets non-existent confession ${r.refId}`,
      repairGuidance: `Auto-dismiss or purge orphan report: UPDATE "${reportTable}" SET status = 'dismissed', resolution_reason = 'Target confession no longer exists' WHERE id = '${r.recordId}';`,
      details: { orphanConfessionId: r.refId },
    }));

    return {
      name: 'moderation_orphan_report_confession',
      domain: 'moderation',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkModerationOrphanReporterUser(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const userTable = this.getTableName(User);
    const reportTable = this.getTableName(Report);

    const query = `
      SELECT r.id as "recordId", r.reporter_id as "refId"
      FROM "${reportTable}" r
      LEFT JOIN "${userTable}" u ON r.reporter_id = u.id
      WHERE r.reporter_id IS NOT NULL AND u.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.MODERATION_ORPHAN_REPORTER_USER,
      domain: 'moderation',
      severity: 'LOW',
      recordId: String(r.recordId),
      description: `Report ${r.recordId} reporter_id ${r.refId} does not match any user`,
      repairGuidance: `Nullify invalid reporter reference: UPDATE "${reportTable}" SET reporter_id = NULL WHERE id = '${r.recordId}';`,
      details: { orphanReporterId: r.refId },
    }));

    return {
      name: 'moderation_orphan_reporter_user',
      domain: 'moderation',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkModerationOrphanReporterAnonymous(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const anonTable = this.getTableName(AnonymousUser);
    const reportTable = this.getTableName(Report);

    const query = `
      SELECT r.id as "recordId", r.anonymous_reporter_id as "refId"
      FROM "${reportTable}" r
      LEFT JOIN "${anonTable}" a ON r.anonymous_reporter_id = a.id
      WHERE r.anonymous_reporter_id IS NOT NULL AND a.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.MODERATION_ORPHAN_REPORTER_ANONYMOUS,
      domain: 'moderation',
      severity: 'LOW',
      recordId: String(r.recordId),
      description: `Report ${r.recordId} anonymous_reporter_id ${r.refId} does not match any anonymous user`,
      repairGuidance: `Nullify invalid anonymous reporter reference: UPDATE "${reportTable}" SET anonymous_reporter_id = NULL WHERE id = '${r.recordId}';`,
      details: { orphanAnonymousReporterId: r.refId },
    }));

    return {
      name: 'moderation_orphan_reporter_anonymous',
      domain: 'moderation',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private async checkModerationOrphanEvidenceTarget(
    limit: number,
  ): Promise<InvariantCheckResult> {
    const start = Date.now();
    const confTable = this.getTableName(AnonymousConfession);
    const evidenceTable = this.getTableName(ModerationEvidence);

    const query = `
      SELECT m.id as "recordId", m.target_id as "refId"
      FROM "${evidenceTable}" m
      LEFT JOIN "${confTable}" c ON m.target_id = CAST(c.id AS VARCHAR)
      WHERE m.target_type = 'confession' AND m.is_legal_hold = false AND c.id IS NULL
      LIMIT $1
    `;

    const rows = await this.dataSource.query(query, [limit]);
    const violations: InvariantViolation[] = rows.map((r: any) => ({
      code: CrossDomainIntegrityErrorCode.MODERATION_ORPHAN_EVIDENCE_TARGET,
      domain: 'moderation',
      severity: 'MEDIUM',
      recordId: String(r.recordId),
      description: `Moderation evidence ${r.recordId} targets deleted confession ${r.refId} without active legal hold`,
      repairGuidance: `Archive or purge stale evidence without legal hold: DELETE FROM "${evidenceTable}" WHERE id = '${r.recordId}';`,
      details: { orphanTargetId: r.refId },
    }));

    return {
      name: 'moderation_orphan_evidence_target',
      domain: 'moderation',
      status: violations.length === 0 ? 'PASSED' : 'FAILED',
      violationsCount: violations.length,
      violations,
      durationMs: Date.now() - start,
    };
  }

  private getTableName(entity: Function): string {
    try {
      return this.dataSource.getMetadata(entity).tableName;
    } catch {
      // Fallback if entity metadata is not yet registered
      return entity.name.toLowerCase();
    }
  }
}
