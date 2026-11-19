import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import archiver from 'archiver';
import * as crypto from 'crypto';
import { Writable } from 'stream';
import { ExportRequest } from './entities/export-request.entity';
import { ExportChunk } from './entities/export-chunk.entity';
import { User } from '../user/entities/user.entity';
import { DataExportService } from './data-export.service';
import { EmailService } from '../email/email.service';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EXPORT_QUEUE_NAME } from './data-export.constants';
import { QUEUE_WORKER_CONCURRENCY } from '../config/queue-concurrency.config';

@Processor(EXPORT_QUEUE_NAME, {
  concurrency: QUEUE_WORKER_CONCURRENCY[EXPORT_QUEUE_NAME],
})
export class ExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportProcessor.name);
  private readonly CHUNK_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB per chunk

  constructor(
    @InjectRepository(ExportRequest)
    private exportRepository: Repository<ExportRequest>,
    @InjectRepository(ExportChunk)
    private chunkRepository: Repository<ExportChunk>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private dataExportService: DataExportService,
    private emailService: EmailService,
    private configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<{ userId: string; requestId: string }>) {
    if (job.name !== 'process-export') {
      throw new Error(`Unsupported export job name: ${job.name}`);
    }
    const { userId, requestId } = job.data;

    try {
      this.logger.log(`Starting chunked export for user ${userId}...`);

      // Idempotency guard: a duplicate delivery (e.g. after a Redis reconnect
      // or backlog replay) must not re-run an export that already finished.
      const existing = await this.exportRepository.findOneBy({ id: requestId });
      if (existing && existing.status === 'READY') {
        this.logger.log(
          `Export ${requestId} already completed; skipping duplicate delivery.`,
        );
        return;
      }

      const privacySnapshotVersion =
        await this.dataExportService.getExportPrivacySnapshotVersion(userId);
      if (!privacySnapshotVersion) {
        await this.dataExportService.cancelExportForPrivacyChange(requestId);
        return;
      }

      // Stamp processingAt and flip status to PROCESSING
      const ownsProcessingLease =
        await this.dataExportService.markExportProcessing(requestId);
      if (!ownsProcessingLease) return;

      // Issue #106: check for cancellation before doing expensive work
      if (await this.dataExportService.isExportCancelled(requestId)) {
        this.logger.log(`Export ${requestId} was cancelled before processing started.`);
        return;
      }

      const data = await this.dataExportService.compileUserData(userId);

      // Issue #106: second cancellation checkpoint — after compilation, before writes
      if (
        (await this.dataExportService.isExportCancelled(requestId)) ||
        (await this.dataExportService.getExportPrivacySnapshotVersion(userId)) !==
          privacySnapshotVersion
      ) {
        this.logger.log(`Export ${requestId} cancelled after data compilation.`);
        await this.dataExportService.cancelExportForPrivacyChange(requestId);
        return;
      }

      const result = await this.generateChunkedZip(requestId, data);

      if (await this.dataExportService.isExportCancelled(requestId)) {
        await this.chunkRepository.delete({ exportRequestId: requestId });
        return;
      }

      await this.chunkRepository.delete({
        exportRequestId: requestId,
        chunkIndex: MoreThanOrEqual(result.chunkCount),
      });
      const completedAt = new Date();
      const finalized = await this.exportRepository.update(
        { id: requestId, status: 'PROCESSING' },
        {
          status: 'READY',
          isChunked: true,
          chunkCount: result.chunkCount,
          totalSize: result.totalSize.toString(),
          combinedChecksum: result.combinedChecksum,
          completedAt,
        },
      );
      if (!finalized.affected) {
        await this.chunkRepository.delete({ exportRequestId: requestId });
        return;
      }

      const user = await this.userRepository.findOneBy({
        id: parseInt(userId),
      });
      if (user && user.emailEncrypted) {
        await this.emailService.sendWelcomeEmail(
          user.emailEncrypted,
          user.username,
        );
      }

      this.logger.log(
        `Chunked export ${requestId} completed with ${result.chunkCount} chunks.`,
      );
    } catch (error) {
      if (await this.dataExportService.isExportCancelled(requestId)) {
        await this.chunkRepository.delete({ exportRequestId: requestId });
        this.logger.log(`Export ${requestId} cancelled at a chunk checkpoint.`);
        return;
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Export ${requestId} failed: ${message}`);
      // Use the service helper so retryCount and lastFailureReason are persisted
      await this.dataExportService.markExportFailed(requestId, message);
      // Rethrow so BullMQ records the failure and applies its retry/backoff
      // policy; swallowing it would silently drop the job on Redis recovery.
      throw error;
    }
  }

  private async generateChunkedZip(
    requestId: string,
    data: any,
  ): Promise<{
    chunkCount: number;
    totalSize: number;
    combinedChecksum: string;
  }> {
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const combinedHash = crypto.createHash('sha256');
      let chunkCount = 0;
      let totalSize = 0;
      let currentChunkBuffer: Buffer[] = [];
      let currentChunkSize = 0;

      const saveChunk = async (buffer: Buffer, index: number) => {
        if (await this.dataExportService.isExportCancelled(requestId)) {
          throw new Error('Export cancelled');
        }
        const checksum = crypto
          .createHash('sha256')
          .update(buffer)
          .digest('hex');
        await this.chunkRepository.delete({
          exportRequestId: requestId,
          chunkIndex: index,
        });
        await this.chunkRepository.save({
          exportRequestId: requestId,
          chunkIndex: index,
          fileData: buffer,
          chunkSize: buffer.length,
          checksum,
        });
        await this.exportRepository.update(requestId, {
          chunkCount: index + 1,
          processingAt: new Date(),
        });
      };

      const chunkProcessor = new Writable({
        write: async (chunk, encoding, callback) => {
          try {
            const buf = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk, encoding);
            combinedHash.update(buf);
            totalSize += buf.length;

            currentChunkBuffer.push(buf);
            currentChunkSize += buf.length;

            if (currentChunkSize >= this.CHUNK_SIZE_LIMIT) {
              const fullBuffer = Buffer.concat(currentChunkBuffer);
              await saveChunk(fullBuffer, chunkCount++);
              currentChunkBuffer = [];
              currentChunkSize = 0;
            }
            callback();
          } catch (err) {
            callback(err as Error);
          }
        },
        final: async (callback) => {
          try {
            if (currentChunkBuffer.length > 0) {
              const fullBuffer = Buffer.concat(currentChunkBuffer);
              await saveChunk(fullBuffer, chunkCount++);
            }
            callback();
          } catch (err) {
            callback(err as Error);
          }
        },
      });

      archive.on('error', (err) => reject(err));
      chunkProcessor.on('error', (err) => reject(err));
      chunkProcessor.on('finish', () => {
        resolve({
          chunkCount,
          totalSize,
          combinedChecksum: combinedHash.digest('hex'),
        });
      });

      archive.pipe(chunkProcessor);

      archive.append(JSON.stringify(data, null, 2), {
        name: 'complete_data.json',
      });
      archive.append(
        JSON.stringify(
          this.dataExportService.buildExportManifest(),
          null,
          2,
        ),
        { name: 'export_manifest.json' },
      );
      if (data.confessions) {
        const csvContent = this.dataExportService.convertToCsv(
          data.confessions,
        );
        archive.append(csvContent, { name: 'confessions.csv' });
      }

      archive.finalize();
    });
  }
}
