// src/data-export/data-export.service.ts
import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  MoreThan,
  IsNull,
  In,
  LessThan,
} from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ExportRequest } from './entities/export-request.entity';
import { ExportChunk } from './entities/export-chunk.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EXPORT_QUEUE_NAME } from './data-export.constants';
import { CorrelationContext } from '../common/correlation/correlation.context';

export type ExportHistoryStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

/** Detailed lifecycle progress returned alongside every export history item. */
export interface ExportProgress {
  queuedAt: Date | null;
  processingAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  expiredAt: Date | null;
  retryCount: number;
  lastFailureReason: string | null;
}

export interface ExportHistoryItem {
  id: string;
  status: ExportHistoryStatus;
  createdAt: Date;
  expiresAt: number | null;
  canRedownload: boolean;
  canRequestNewLink: boolean;
  downloadUrl: string | null;
  /** Lifecycle timeline — additive; older clients can safely ignore this field. */
  progress: ExportProgress;
}

/** Slim status response for the GET :id/status endpoint. */
export interface ExportJobStatus {
  id: string;
  userId: string;
  status: ExportHistoryStatus;
  progress: ExportProgress;
}

@Injectable()
export class DataExportService {
  constructor(
    @InjectRepository(ExportRequest)
    private exportRepository: Repository<ExportRequest>,
    @InjectRepository(ExportChunk)
    private chunkRepository: Repository<ExportChunk>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectQueue(EXPORT_QUEUE_NAME) private exportQueue: Queue,
    private readonly configService: ConfigService,
    @Optional() private readonly auditLogService?: AuditLogService,
  ) {}

  async requestExport(userId: string) {
    try {
      await this.assertUserCanExport(userId);
    } catch (error) {
      await this.cancelExportForPrivacyChange(
        requestId,
        error instanceof NotFoundException ? 'account_deleted' : 'consent_withdrawn',
      );
      throw error;
    }

    if (this.configService.get<string>('ENABLE_BACKGROUND_JOBS') !== 'true') {
      this.auditLogService?.logExportLifecycleEvent({
        action: 'request_created',
        actorType: 'system',
        actorId: 'data-export-service',
        requestId: 'n/a',
        exportId: 'n/a',
        metadata: {
          reason: 'background_jobs_disabled',
          queue: EXPORT_QUEUE_NAME,
          userId,
        },
      }).catch(() => undefined);
      throw new ServiceUnavailableException(
        'Data export requires background job processing. Set ENABLE_BACKGROUND_JOBS=true and ensure Redis is available.',
      );
    }

    // 1a. Duplicate-submission guard: reject if a job is already PENDING or PROCESSING.
    // Read-only work is cancellable: a disconnected client must not keep the
    // connection busy (issue #182).
    const activeJob = await runWithCancellation(() =>
      this.exportRepository.findOne({
        where: [
          { userId, status: 'PENDING' },
          { userId, status: 'PROCESSING' },
        ],
      }),
    );

    if (activeJob) {
      throw new ConflictException(
        'An export is already in progress. Please wait for it to complete.',
      );
    }

    // 1b. Rate Limit Check: Find any request created in the last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentRequest = await runWithCancellation(() =>
      this.exportRepository.findOne({
        where: {
          userId,
          createdAt: MoreThan(sevenDaysAgo),
        },
      }),
    );

    if (recentRequest) {
      throw new BadRequestException('Export allowed once every 7 days.');
    }

    // Critical section: the export record and its queued job are created
    // together. Cancellation is checked *before* the section starts so the
    // write is never abandoned half-way (committed writes stay consistent).
    throwIfCancelled();

    // 2. Create record — stamp queuedAt immediately
    const now = new Date();
    const request = this.exportRepository.create({
      userId,
      status: 'PENDING',
      queuedAt: now,
    });
    await this.exportRepository.save(request);

    await this.auditLogService?.logExportLifecycleEvent({
      action: 'request_created',
      actorType: 'user',
      actorId: userId,
      requestId: request.id,
      exportId: request.id,
      metadata: {
        status: request.status,
        queuedAt: now.toISOString(),
      },
    });

    // 3. Kick off Bull queue
    await this.exportQueue.add('process-export', {
      userId,
      requestId: request.id,
      correlationId: CorrelationContext.getOrGenerateRequestId(),
    });

    return { requestId: request.id, status: 'PENDING', queuedAt: now };
  }

  /**
   * Called by the processor as soon as it picks up the job.
   * Transitions status to PROCESSING and stamps processingAt.
   */
  async markExportProcessing(requestId: string): Promise<boolean> {
    const now = new Date();
    const staleProcessingBefore = new Date(now.getTime() - 30 * 60 * 1000);
    const result = await this.exportRepository.update(
      [
        { id: requestId, status: In(['PENDING', 'FAILED']) },
        {
          id: requestId,
          status: 'PROCESSING',
          processingAt: LessThan(staleProcessingBefore),
        },
      ],
      { status: 'PROCESSING', processingAt: now },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Called by the processor on failure. Increments retryCount and stores the
   * reason so operators can investigate without digging through log files.
   */
  async markExportFailed(requestId: string, reason: string): Promise<void> {
    const now = new Date();

    // Fetch current retryCount so we can increment it safely.
    const current = await this.exportRepository.findOne({
      where: { id: requestId },
      select: ['retryCount'],
    });
    const retryCount = (current?.retryCount ?? 0) + 1;

    await this.exportRepository.update(
      { id: requestId, status: 'PROCESSING' },
      {
        status: 'FAILED',
        failedAt: now,
        retryCount,
        lastFailureReason: reason,
      },
    );
  }

  async generateSignedDownloadUrl(
    requestId: string,
    userId: string,
    chunkIndex?: number,
  ): Promise<string> {
    await this.assertCanDeliverExport(requestId, userId);

    const ttlMs = this.configService.get<number>(
      'app.exportDownloadTtlMs',
      24 * 60 * 60 * 1000,
    );
    const expires = Date.now() + ttlMs;
    const secret = this.configService.get<string>('app.appSecret', '');

    // For single-file downloads generate and persist a one-time nonce so the
    // link cannot be replayed after the first successful download.
    let token: string | undefined;
    if (chunkIndex === undefined) {
      token = crypto.randomBytes(32).toString('base64url');
      await this.exportRepository.update(requestId, {
        downloadTokenHash: this.hashDownloadToken(token),
        downloadedAt: null,
      });
    }

    const dataToSign =
      chunkIndex !== undefined
        ? `${requestId}:${userId}:${chunkIndex}:${expires}`
        : `${requestId}:${userId}:${expires}:${token}`;

    const signature = crypto
      .createHmac('sha256', secret || 'APP_SECRET_NOT_SET')
      .update(dataToSign)
      .digest('hex');

    const baseUrl = this.configService.get<string>('app.backendUrl', '');

    void this.auditLogService
      ?.logExportLifecycleEvent({
        action: 'link_refreshed',
        actorType: 'user',
        actorId: userId,
        requestId,
        exportId: requestId,
        metadata: {
          expiresAt: new Date(expires).toISOString(),
        },
      })
      .catch(() => undefined);

    const chunkParam = chunkIndex !== undefined ? `&chunk=${chunkIndex}` : '';
    const tokenParam = token !== undefined ? `&token=${token}` : '';
    return `${baseUrl}/api/data-export/download/${requestId}?userId=${userId}&expires=${expires}&signature=${signature}${chunkParam}${tokenParam}`;
  }

  /**
   * Invalidates the current download token after a successful download.
   * Subsequent requests with the same token will be rejected.
   */
  async invalidateDownloadToken(requestId: string): Promise<void> {
    await this.exportRepository.update(requestId, {
      downloadTokenHash: null,
      downloadedAt: new Date(),
    });
  }

  /**
   * Validates that the supplied token matches the stored one-time nonce and,
   * if so, atomically consumes it to prevent replay.
   *
   * Issue #789 — token expiry rules:
   *   1. Token must match the stored nonce (null = already consumed or never issued).
   *   2. Token must not have been used before (`downloadedAt` must be null).
   *   3. The export must still be within its retention window (24 h after `createdAt`).
   *
   * Returns false when any condition fails; callers should treat false as 403/410.
   */
  async validateAndConsumeToken(
    requestId: string,
    userId: string,
    token: string,
  ): Promise<boolean> {
    const tokenHash = this.hashDownloadToken(token);
    const record = await this.exportRepository.findOne({
      where: { id: requestId, userId },
      select: ['downloadTokenHash', 'downloadedAt', 'createdAt', 'status'] as any,
    });

    if (!record) {
      await this.recordFailedDownloadAttempt(requestId, 'not_found');
      return false;
    }

    if (
      record.downloadedAt !== null ||
      !record.downloadTokenHash ||
      !this.secureCompare(record.downloadTokenHash, tokenHash)
    ) {
      await this.recordFailedDownloadAttempt(requestId, 'invalid_or_used');
      return false;
    }

    // Retention-window guard: export has exceeded its TTL.
    if (!this.isFileAvailable(record as Pick<ExportRequest, 'status' | 'createdAt'>)) {
      // Mark the token as expired and emit an audit event.
      await this.exportRepository.update(requestId, {
        downloadTokenHash: null,
        expiredAt: new Date(),
      });

      void this.auditLogService
        ?.logExportLifecycleEvent({
          action: 'token_expired',
          actorType: 'user',
          actorId: userId,
          requestId,
          exportId: requestId,
          metadata: {
            userId,
            expiredAt: new Date().toISOString(),
            reason: 'retention_window_elapsed',
          },
        })
        .catch(() => undefined);

      return false;
    }

    const consumeResult = await this.exportRepository.update(
      {
        id: requestId,
        userId,
        downloadTokenHash: tokenHash,
        downloadedAt: IsNull(),
      },
      {
        downloadTokenHash: null,
        downloadedAt: new Date(),
      },
    );

    if ((consumeResult.affected ?? 0) !== 1) {
      await this.recordFailedDownloadAttempt(requestId, 'replay_race');
      return false;
    }

    void this.auditLogService
      ?.logExportLifecycleEvent({
        action: 'downloaded',
        actorType: 'user',
        actorId: userId,
        requestId,
        exportId: requestId,
        metadata: {
          userId,
          downloadedAt: new Date().toISOString(),
        },
      })
      .catch(() => undefined);

    return true;
  }

  /**
   * Expire all download tokens whose retention window has elapsed without being
   * consumed.  Called by the cleanup scheduler (data-export-cleanup.ts).
   *
   * Issue #789 — ensures tokens cannot be reused after the configured TTL even
   * if the owner never triggered a download.
   */
  async expireStaleDownloadTokens(): Promise<number> {
    const ttlMs = this.configService.get<number>(
      'DATA_EXPORT_TTL_MS',
      24 * 60 * 60 * 1000,
    );
    const cutoff = new Date(Date.now() - ttlMs);

    const result = await this.exportRepository
      .createQueryBuilder()
      .update(ExportRequest)
      .set({ downloadTokenHash: null, expiredAt: () => 'NOW()' })
      .where('downloadTokenHash IS NOT NULL')
      .andWhere('downloadedAt IS NULL')
      .andWhere('createdAt < :cutoff', { cutoff })
      .execute();

    const affected = result.affected ?? 0;

    if (affected > 0) {
      void this.auditLogService
        ?.logExportLifecycleEvent({
          action: 'export_expired',
          actorType: 'system',
          actorId: 'cleanup-scheduler',
          requestId: 'batch',
          exportId: 'batch',
          metadata: {
            affectedCount: affected,
            cutoff: cutoff.toISOString(),
            reason: 'scheduled_cleanup',
          },
        })
        .catch(() => undefined);
    }

    return affected;
  }

  async getExportFile(requestId: string, userId: string) {
    await this.assertCanDeliverExport(requestId, userId);
    const exportRecord = await this.exportRepository.findOne({
      where: { id: requestId, userId },
      select: [
        'fileData',
        'status',
        'isChunked',
        'chunkCount',
        'totalSize',
        'combinedChecksum',
      ],
    });

    if (exportRecord?.fileData) {
      await this.auditLogService?.logExportLifecycleEvent({
        action: 'downloaded',
        actorType: 'user',
        actorId: userId,
        requestId,
        exportId: requestId,
        metadata: {
          status: exportRecord.status,
        },
      });
    }

    return exportRecord;
  }

  async getExportChunk(requestId: string, userId: string, chunkIndex: number) {
    await this.assertCanDeliverExport(requestId, userId);
    // First verify ownership of the request
    const request = await this.exportRepository.findOne({
      where: { id: requestId, userId },
    });

    if (!request || request.status !== 'READY' || !request.isChunked) {
      throw new NotFoundException('Export request not found or unauthorized');
    }

    return this.chunkRepository.findOne({
      where: { exportRequestId: requestId, chunkIndex },
    });
  }

  /**
   * Cancel a PENDING or PROCESSING export.
   *
   * Issue #106: Clients can cancel in-flight exports so resources are freed
   * and partial artifacts never become accessible. The processor checks for
   * CANCELLED status before each write phase, skipping further work.
   *
   * - PENDING jobs are cancelled immediately (no work has started).
   * - PROCESSING jobs are flagged CANCELLED; the processor detects this on its
   *   next checkpoint and aborts, then deletes any partial chunks.
   */
  async cancelExport(requestId: string, userId: string): Promise<void> {
    const exportReq = await this.exportRepository.findOne({
      where: { id: requestId, userId },
    });

    if (!exportReq) {
      throw new NotFoundException('Export request not found.');
    }

    if (!['PENDING', 'PROCESSING'].includes(exportReq.status)) {
      throw new BadRequestException(
        `Cannot cancel an export with status ${exportReq.status}.`,
      );
    }

    const cancellation = await this.exportRepository.update(
      { id: requestId, userId, status: In(['PENDING', 'PROCESSING']) },
      {
        status: 'CANCELLED' as any,
        lastFailureReason: 'cancelled_by_user',
      },
    );
    if (!cancellation.affected) {
      throw new BadRequestException(
        'The export is no longer cancellable.',
      );
    }

    // Delete any partial chunks so partial artifacts are never accessible.
    await this.chunkRepository.delete({ exportRequestId: requestId });

    await this.auditLogService
      ?.logExportLifecycleEvent({
        action: 'request_created',
        actorType: 'user',
        actorId: userId,
        requestId,
        exportId: requestId,
        metadata: { action: 'cancelled', previousStatus: exportReq.status },
      })
      .catch(() => undefined);
  }

  async cancelExportForPrivacyChange(
    requestId: string,
    reason = 'privacy_state_changed',
  ): Promise<void> {
    await this.exportRepository.update(
      { id: requestId, status: In(['PENDING', 'PROCESSING', 'FAILED', 'READY']) },
      {
        status: 'CANCELLED',
        fileData: null,
        isChunked: false,
        chunkCount: 0,
        totalSize: '0',
        combinedChecksum: null,
        downloadTokenHash: null,
        lastFailureReason: reason,
      },
    );
    await this.chunkRepository.delete({ exportRequestId: requestId });
  }

  async cancelExportsForUser(
    userId: string,
    reason = 'privacy_state_changed',
  ): Promise<void> {
    const requests = await this.findActiveExportsOnPrimary(userId);
    if (requests.length === 0) return;

    const requestIds = requests.map(({ id }) => id);
    await this.exportRepository.update(
      {
        userId,
        status: In(['PENDING', 'PROCESSING', 'FAILED', 'READY']),
      },
      {
        status: 'CANCELLED',
        fileData: null,
        isChunked: false,
        chunkCount: 0,
        totalSize: '0',
        combinedChecksum: null,
        downloadTokenHash: null,
        lastFailureReason: reason,
      },
    );
    await this.chunkRepository.delete({ exportRequestId: In(requestIds) });
  }

  async getExportPrivacySnapshotVersion(userId: string): Promise<string | null> {
    const user = await this.findUserOnPrimary(userId, [
      'id',
      'updatedAt',
      'is_active',
      'privacySettings',
      'personalizationEnabled',
    ]);

    if (!user || user.privacySettings?.dataProcessingConsent === false) {
      return null;
    }

    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          updatedAt: user.updatedAt?.getTime() ?? null,
          isActive: user.is_active,
          privacySettings: user.privacySettings ?? null,
          personalizationEnabled: user.personalizationEnabled,
        }),
      )
      .digest('hex');
  }

  async assertCanDeliverExport(requestId: string, userId: string): Promise<void> {
    const queryRunner = this.exportRepository.manager.connection.createQueryRunner('master');
    await queryRunner.connect();
    let request: ExportRequest | null;
    try {
      request = await queryRunner.manager.getRepository(ExportRequest).findOne({
        where: { id: requestId, userId },
        select: ['id', 'status', 'privacySnapshotVersion'],
      });
    } finally {
      await queryRunner.release();
    }

    if (!request) {
      throw new NotFoundException('Export request not found or unauthorized');
    }
    if (request.status !== 'READY') {
      throw new NotFoundException('Export file is not available');
    }

    await this.assertUserCanExport(userId);
    const currentVersion = await this.getExportPrivacySnapshotVersion(userId);
    if (!currentVersion || currentVersion !== request.privacySnapshotVersion) {
      await this.cancelExportForPrivacyChange(requestId);
      throw new GoneException('Export snapshot is no longer current.');
    }
  }

  private async assertUserCanExport(userId: string): Promise<void> {
    const user = await this.findUserOnPrimary(userId, ['id', 'privacySettings']);
    if (!user) throw new NotFoundException('User not found');
    if (user.privacySettings?.dataProcessingConsent === false) {
      throw new ForbiddenException('Data export consent has been withdrawn.');
    }
  }

  private async findUserOnPrimary(
    userId: string,
    select: (keyof User)[],
  ): Promise<User | null> {
    const queryRunner = this.userRepository.manager.connection.createQueryRunner('master');
    await queryRunner.connect();
    try {
      return await queryRunner.manager.getRepository(User).findOne({
        where: { id: Number(userId) },
        select,
      });
    } finally {
      await queryRunner.release();
    }
  }

  private async findActiveExportsOnPrimary(userId: string): Promise<Pick<ExportRequest, 'id'>[]> {
    const queryRunner = this.exportRepository.manager.connection.createQueryRunner('master');
    await queryRunner.connect();
    try {
      return await queryRunner.manager.getRepository(ExportRequest).find({
        where: {
          userId,
          status: In(['PENDING', 'PROCESSING', 'FAILED', 'READY']),
        },
        select: ['id'],
      });
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Returns true if the export has been cancelled by the user.
   * Called by ExportProcessor at each checkpoint to abort early.
   */
  async isExportCancelled(requestId: string): Promise<boolean> {
    const req = await this.exportRepository.findOne({
      where: { id: requestId },
      select: ['status'] as any,
    });
    return req?.status === ('CANCELLED' as any);
  }

  async markExportGenerated(
    requestId: string,
    userId: string,
    fileData: Buffer,
    metadata?: Record<string, any>,
  ): Promise<void> {
    const now = new Date();
    await this.exportRepository.update(requestId, {
      fileData,
      status: 'READY',
      completedAt: now,
    });

    await this.auditLogService?.logExportLifecycleEvent({
      action: 'generation_completed',
      actorType: 'system',
      actorId: EXPORT_QUEUE_NAME,
      requestId,
      exportId: requestId,
      metadata: {
        userId,
        status: 'READY',
        completedAt: now.toISOString(),
        ...(metadata || {}),
      },
    });
  }

  private getExpiryTimestamp(createdAt: Date): number {
    const ttlMs = this.configService.get<number>(
      'app.exportDownloadTtlMs',
      24 * 60 * 60 * 1000,
    );
    return new Date(createdAt).getTime() + ttlMs;
  }

  private hashDownloadToken(token: string): string {
    const secret = this.configService.get<string>('app.appSecret', '');
    return crypto
      .createHmac('sha256', secret || 'APP_SECRET_NOT_SET')
      .update(token)
      .digest('hex');
  }

  private secureCompare(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');

    return (
      expectedBuffer.length === actualBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  async recordFailedDownloadAttempt(
    requestId: string,
    reason:
      | 'missing_token'
      | 'invalid_signature'
      | 'not_found'
      | 'invalid_or_used'
      | 'replay_race',
  ): Promise<void> {
    await this.auditLogService
      ?.logExportLifecycleEvent({
        action: 'download_failed',
        actorType: 'system',
        actorId: 'download-token-validator',
        requestId,
        exportId: requestId,
        metadata: {
          reason,
        },
      })
      .catch(() => undefined);
  }

  /** True when the underlying export file is still within its TTL window. */
  private isFileAvailable(
    request: Pick<ExportRequest, 'status' | 'createdAt'>,
  ): boolean {
    if (request.status !== 'READY') return false;
    return Date.now() <= this.getExpiryTimestamp(request.createdAt);
  }

  /** True when a valid one-time token exists and the file is still available. */
  private hasActiveToken(
    request: Pick<ExportRequest, 'status' | 'createdAt' | 'downloadTokenHash'>,
  ): boolean {
    return this.isFileAvailable(request) && request.downloadTokenHash != null;
  }

  private buildProgress(request: Partial<ExportRequest>): ExportProgress {
    return {
      queuedAt: request.queuedAt ?? null,
      processingAt: request.processingAt ?? null,
      completedAt: request.completedAt ?? null,
      failedAt: request.failedAt ?? null,
      expiredAt: request.expiredAt ?? null,
      retryCount: request.retryCount ?? 0,
      lastFailureReason: request.lastFailureReason ?? null,
    };
  }

  private async toHistoryItem(
    request: Pick<
      ExportRequest,
      | 'id'
      | 'status'
      | 'createdAt'
      | 'userId'
      | 'queuedAt'
      | 'processingAt'
      | 'completedAt'
      | 'failedAt'
      | 'expiredAt'
      | 'retryCount'
      | 'lastFailureReason'
      | 'downloadTokenHash'
    >,
  ): Promise<ExportHistoryItem> {
    const expiresAt =
      request.status === 'READY'
        ? this.getExpiryTimestamp(request.createdAt)
        : null;
    const fileAvailable = this.isFileAvailable(request);
    const canRedownload = this.hasActiveToken(request);
    const normalizedStatus: ExportHistoryStatus =
      request.status === 'READY' && !fileAvailable
        ? 'EXPIRED'
        : (request.status as ExportHistoryStatus);

    return {
      id: request.id,
      status: normalizedStatus,
      createdAt: request.createdAt,
      expiresAt,
      canRedownload,
      // Allow regeneration when the file is still available but the token was consumed.
      canRequestNewLink: fileAvailable && !canRedownload,
      downloadUrl: canRedownload
        ? await this.generateSignedDownloadUrl(request.id, request.userId)
        : null,
      progress: this.buildProgress(request),
    };
  }

  /** The full list of fields we need fetched from the DB for history/status calls. */
  private readonly lifecycleSelect = [
    'id',
    'status',
    'createdAt',
    'userId',
    'queuedAt',
    'processingAt',
    'completedAt',
    'failedAt',
    'expiredAt',
    'retryCount',
    'lastFailureReason',
    'downloadTokenHash',
  ] as const;

  async getExportHistory(
    userId: string,
    limit = 20,
  ): Promise<ExportHistoryItem[]> {
    const requests = await this.exportRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
      select: this.lifecycleSelect as any,
    });

    return Promise.all(requests.map((request) => this.toHistoryItem(request)));
  }

  async getLatestExport(userId: string): Promise<ExportHistoryItem | null> {
    const latestRequest = await this.exportRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
      select: this.lifecycleSelect as any,
    });

    return latestRequest ? this.toHistoryItem(latestRequest) : null;
  }

  async getRedownloadLink(
    requestId: string,
    userId: string,
  ): Promise<{ downloadUrl: string }> {
    const request = await this.exportRepository.findOne({
      where: { id: requestId, userId },
      select: this.lifecycleSelect as any,
    });

    if (!request || !this.isFileAvailable(request)) {
      throw new BadRequestException(
        'Secure download link is no longer available. Request a new export.',
      );
    }

    return {
      downloadUrl: await this.generateSignedDownloadUrl(
        request.id,
        request.userId,
      ),
    };
  }

  /**
   * Returns the full lifecycle status for a single export job.
   * Used by the GET /data-export/:id/status endpoint.
   */
  async getJobStatus(
    requestId: string,
    userId: string,
  ): Promise<ExportJobStatus> {
    const request = await this.exportRepository.findOne({
      where: { id: requestId, userId },
      select: this.lifecycleSelect as any,
    });

    if (!request) {
      throw new NotFoundException('Export request not found or unauthorized');
    }

    const canRedownload = this.isFileAvailable(request);
    const normalizedStatus: ExportHistoryStatus =
      request.status === 'READY' && !canRedownload
        ? 'EXPIRED'
        : (request.status as ExportHistoryStatus);

    return {
      id: request.id,
      userId: request.userId,
      status: normalizedStatus,
      progress: this.buildProgress(request),
    };
  }

  async compileUserData(userId: string): Promise<any> {
    const queryRunner = this.exportRepository.manager.connection.createQueryRunner('master');
    await queryRunner.connect();
    await queryRunner.startTransaction('REPEATABLE READ');
    try {
      const data = await this.compileUserDataFromManager(userId, queryRunner.manager);
      await queryRunner.commitTransaction();
      return data;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async compileUserDataFromManager(
    userId: string,
    manager: EntityManager,
  ): Promise<any> {
    // Issue #428: Implement export redaction for deleted/deactivated users
    const userRepo = manager.getRepository(User);
    const confessionRepo = manager.getRepository('AnonymousConfession');
    const commentRepo = manager.getRepository('Comment');
    const messageRepo = manager.getRepository('Message');

    // Get user to check if active
    const user = await userRepo.findOne({ where: { id: Number(userId) } });
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Fetch confessions with soft-delete awareness
    const confessions = await confessionRepo
      .createQueryBuilder('confession')
      .leftJoinAndSelect('confession.anonymousUser', 'anonymousUser')
      .leftJoinAndSelect('anonymousUser.userLinks', 'userLinks')
      .where('userLinks.userId = :userId', { userId })
      .getMany();

    // Fetch comments with soft-delete awareness
    const comments = await commentRepo
      .createQueryBuilder('comment')
      .leftJoinAndSelect('comment.anonymousUser', 'anonymousUser')
      .leftJoinAndSelect('anonymousUser.userLinks', 'userLinks')
      .where('userLinks.userId = :userId', { userId })
      .getMany();

    // Fetch messages
    const messages = await messageRepo
      .createQueryBuilder('message')
      .leftJoinAndSelect('message.sender', 'sender')
      .leftJoinAndSelect('sender.userLinks', 'userLinks')
      .where('userLinks.userId = :userId', { userId })
      .getMany();

    const tipRepo = manager.getRepository('Tip');
    const reportRepo = manager.getRepository('Report');
    const moderationLogRepo = manager.getRepository('ModerationLog');

    const tips = await tipRepo
      .createQueryBuilder('tip')
      .leftJoinAndSelect('tip.confession', 'confession')
      .leftJoinAndSelect('confession.anonymousUser', 'anonymousUser')
      .leftJoinAndSelect('anonymousUser.userLinks', 'userLinks')
      .where('userLinks.userId = :userId', { userId })
      .getMany();

    const reports = await reportRepo
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.reporter', 'reporter')
      .leftJoinAndSelect('report.anonymousReporter', 'anonymousReporter')
      .leftJoinAndSelect('anonymousReporter.userLinks', 'userLinks')
      .where('report.reporterId = :userId OR userLinks.userId = :userId', { userId })
      .getMany();

    const moderationLogs = await moderationLogRepo
      .createQueryBuilder('log')
      .where('log.userId = :userId', { userId })
      .getMany();

    // Apply redaction policy
    const redactedConfessions = confessions.map((confession) =>
      this.redactConfessionForExport(confession, user),
    );

    const redactedComments = comments.map((comment) =>
      this.redactCommentForExport(comment, user),
    );

    const redactedMessages = messages.map((message) =>
      this.redactMessageForExport(message, user),
    );

    const redactedTips = tips.map((tip) => this.redactTipForExport(tip, user));
    const redactedReports = reports.map((report) => this.redactReportForExport(report, user));
    const redactedModerationLogs = moderationLogs.map((log) => this.redactModerationLogForExport(log, user));

    return {
      userId,
      exportedAt: new Date().toISOString(),
      userStatus: user.is_active ? 'active' : 'deactivated',
      exportManifest: this.buildExportManifest(),
      confessions: redactedConfessions,
      comments: redactedComments,
      messages: redactedMessages,
      tips: redactedTips,
      reports: redactedReports,
      moderationLogs: redactedModerationLogs,
      reactions: [],
      _redactionPolicy: {
        description: 'Content redacted according to deletion and moderation policies',
        deletedContentMasked: true,
        moderatedContentMasked: true,
        deactivatedUserContentMasked: !user.is_active,
      },
    };
  }

  /**
   * Issue #428: Redact confession content based on deletion and moderation status
   */
  private redactConfessionForExport(confession: any, user: any): any {
    const isDeleted = confession.isDeleted || confession.deletedAt;
    const isModerated = confession.isHidden || confession.moderationStatus === 'rejected';
    const isUserDeactivated = !user.is_active;

    if (isDeleted) {
      return {
        id: confession.id,
        message: '[REDACTED: Content was deleted]',
        _redacted: true,
        _reason: 'deleted',
        deletedAt: confession.deletedAt,
        created_at: confession.created_at,
        metadata: {
          wasAnchored: confession.isAnchored,
          hadReactions: true,
        },
      };
    }

    if (isModerated) {
      return {
        id: confession.id,
        message: '[REDACTED: Content was removed by moderation]',
        _redacted: true,
        _reason: 'moderated',
        moderationStatus: confession.moderationStatus,
        created_at: confession.created_at,
        metadata: {
          moderationScore: confession.moderationScore,
          moderationFlags: confession.moderationFlags,
        },
      };
    }

    if (isUserDeactivated) {
      return {
        id: confession.id,
        message: '[REDACTED: User account deactivated]',
        _redacted: true,
        _reason: 'user_deactivated',
        created_at: confession.created_at,
        metadata: {
          originalLength: confession.message?.length || 0,
        },
      };
    }

    // Return full content for active, non-deleted, non-moderated confessions
    return {
      id: confession.id,
      message: confession.message,
      gender: confession.gender,
      created_at: confession.created_at,
      view_count: confession.view_count,
      isAnchored: confession.isAnchored,
      stellarTxHash: confession.stellarTxHash,
      _redacted: false,
    };
  }

  /**
   * Issue #428: Redact comment content based on deletion status
   */
  private redactCommentForExport(comment: any, user: any): any {
    const isDeleted = comment.isDeleted;
    const isUserDeactivated = !user.is_active;

    if (isDeleted) {
      return {
        id: comment.id,
        content: '[REDACTED: Comment was deleted]',
        _redacted: true,
        _reason: 'deleted',
        createdAt: comment.createdAt,
        confessionId: comment.confession?.id,
      };
    }

    if (isUserDeactivated) {
      return {
        id: comment.id,
        content: '[REDACTED: User account deactivated]',
        _redacted: true,
        _reason: 'user_deactivated',
        createdAt: comment.createdAt,
        confessionId: comment.confession?.id,
      };
    }

    return {
      id: comment.id,
      content: comment.content,
      createdAt: comment.createdAt,
      confessionId: comment.confession?.id,
      parentId: comment.parentId,
      _redacted: false,
    };
  }

  /**
   * Issue #428: Redact message content for deactivated users
   */
  private redactMessageForExport(message: any, user: any): any {
    const isUserDeactivated = !user.is_active;

    if (isUserDeactivated) {
      return {
        id: message.id,
        content: '[REDACTED: User account deactivated]',
        replyContent: message.replyContent
          ? '[REDACTED: User account deactivated]'
          : null,
        _redacted: true,
        _reason: 'user_deactivated',
        createdAt: message.createdAt,
        confessionId: message.confession?.id,
      };
    }

    return {
      id: message.id,
      content: message.content,
      replyContent: message.replyContent,
      createdAt: message.createdAt,
      repliedAt: message.repliedAt,
      confessionId: message.confession?.id,
      _redacted: false,
    };
  }

  private redactTipForExport(tip: any, user: any): any {
    return {
      id: tip.id,
      amount: tip.amount,
      verificationStatus: tip.verificationStatus,
      confessionId: tip.confessionId,
      createdAt: tip.createdAt,
      senderAddress: '[REDACTED]',
      _redacted: true,
      _reason: 'counterpart_privacy',
    };
  }

  private redactReportForExport(report: any, user: any): any {
    return {
      id: report.id,
      confessionId: report.confessionId,
      type: report.type,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
      resolutionNotes: report.resolutionNotes,
      resolver: '[REDACTED]',
      resolvedBy: null,
      _redacted: true,
      _reason: 'counterpart_privacy',
    };
  }

  private redactModerationLogForExport(log: any, user: any): any {
    return {
      id: log.id,
      confessionId: log.confessionId,
      moderationScore: log.moderationScore,
      moderationFlags: log.moderationFlags,
      moderationStatus: log.moderationStatus,
      createdAt: log.createdAt,
      reviewedAt: log.reviewedAt,
      reviewNotes: log.reviewNotes,
      reviewedBy: '[REDACTED]',
      _redacted: true,
      _reason: 'counterpart_privacy',
    };
  }

  buildExportManifest(): {
    schemaVersion: '1.0';
    files: Array<{
      name: string;
      source: string;
      fields: Array<{ name: string; type: string; nullable: boolean; description: string }>;
    }>;
  } {
    return {
      schemaVersion: '1.0',
      files: [
        {
          name: 'complete_data.json',
          source: 'user-owned application records',
          fields: [
            { name: 'userId', type: 'string', nullable: false, description: 'The account identifier for this export.' },
            { name: 'exportedAt', type: 'string', nullable: false, description: 'UTC timestamp at which the snapshot was compiled.' },
            { name: 'userStatus', type: 'string', nullable: false, description: 'Current account status at export time.' },
            { name: 'confessions', type: 'array', nullable: false, description: 'Confessions linked to the authenticated account.' },
            { name: 'comments', type: 'array', nullable: false, description: 'Comments linked to the authenticated account.' },
            { name: 'messages', type: 'array', nullable: false, description: 'Messages linked to the authenticated account.' },
            { name: 'tips', type: 'array', nullable: false, description: 'Tips linked to the authenticated account.' },
            { name: 'reports', type: 'array', nullable: false, description: 'Reports submitted or linked to the account.' },
            { name: 'moderationLogs', type: 'array', nullable: false, description: 'Moderation records where the account is the subject.' },
            { name: 'reactions', type: 'array', nullable: false, description: 'User reactions included in the export.' },
          ],
        },
        {
          name: 'confessions.csv',
          source: 'user-owned confession records',
          fields: [
            { name: 'id', type: 'string', nullable: false, description: 'Confession identifier.' },
            { name: 'title', type: 'string', nullable: true, description: 'Confession title when available.' },
            { name: 'body', type: 'string', nullable: true, description: 'Redacted or original confession body permitted by export policy.' },
            { name: 'category', type: 'string', nullable: true, description: 'User-selected confession category.' },
            { name: 'createdAt', type: 'string', nullable: false, description: 'Confession creation timestamp.' },
          ],
        },
      ],
    };
  }

  convertToCsv(data: any[]): string {
    if (!data || data.length === 0) return '';
    const headers = Object.keys(data[0]).join(',');
    const rows = data.map((obj) => Object.values(obj).join(',')).join('\n');
    return `${headers}\n${rows}`;
  }
}
