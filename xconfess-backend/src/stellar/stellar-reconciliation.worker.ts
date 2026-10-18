import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { randomUUID } from 'crypto';
import { StellarAnchor, AnchorStatus } from './entities/stellar-anchor.entity';
import { StellarService } from './stellar.service';
import { ContractService } from './contract.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditActionType } from '../audit-log/audit-log.entity';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { decryptConfession } from '../utils/confession-encryption';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  MultiContractSaga,
  SagaStatus,
} from './entities/multi-contract-saga.entity';

interface ReconciliationConfig {
  interval: string;
  minAgeMinutes: number;
  batchSize: number;
  maxRetries: number;
  backoffBaseMinutes: number;
  sagaBatchSize: number;
  sagaMaxRetries: number;
  sagaBackoffBaseMinutes: number;
}

/**
 * Configuration for the periodic indexed-event-range verification job.
 *
 * The verifier is read-only: it compares the locally indexed Soroban event
 * ranges against ledger data and reports gaps. When gaps are found it may
 * trigger a *bounded* reprocessing window, capped by `maxReprocessRanges`.
 */
interface EventRangeVerificationConfig {
  enabled: boolean;
  interval: string;
  /** Number of most recent checkpoints to verify per run. */
  checkpointWindow: number;
  /** Maximum number of gap ranges to reprocess per run. */
  maxReprocessRanges: number;
  /** Maximum number of ledgers a single reprocess range may span. */
  maxLedgersPerRange: number;
  /** When false, gaps are only reported and never reprocessed. */
  reprocessEnabled: boolean;
}

/**
 * Minimal read-only contract the verifier depends on. Implementations live in
 * the ingestion boundary; this worker only orchestrates scheduling/reporting.
 */
export interface EventRangeVerifier {
  /** Returns the checkpoint ids to verify, newest first. */
  listCheckpoints(limit: number): Promise<string[]>;
  /** Compares a checkpoint's indexed range against ledger data. */
  verifyCheckpoint(checkpointId: string): Promise<EventRangeVerificationResult>;
  /** Safely reprocesses a bounded ledger range. Must be idempotent. */
  reprocessRange(
    checkpointId: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<void>;
}

export interface EventRangeGap {
  checkpointId: string;
  fromLedger: number;
  toLedger: number;
  reason: 'missing' | 'misclassified' | 'out_of_order';
}

export interface EventRangeVerificationResult {
  checkpointId: string;
  verified: boolean;
  gaps: EventRangeGap[];
}

@Injectable()
export class StellarReconciliationWorker {
  private readonly logger = new Logger(StellarReconciliationWorker.name);
  private readonly config: ReconciliationConfig;
  private readonly eventRangeConfig: EventRangeVerificationConfig;
  private eventRangeVerificationRunning = false;

  constructor(
    @InjectRepository(StellarAnchor)
    private readonly anchorRepository: Repository<StellarAnchor>,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepository: Repository<AnonymousConfession>,
    @InjectRepository(MultiContractSaga)
    private readonly sagaRepository: Repository<MultiContractSaga>,
    private readonly stellarService: StellarService,
    private readonly contractService: ContractService,
    private readonly auditService: AuditLogService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly eventRangeVerifier?: EventRangeVerifier,
  ) {
    const envInterval = process.env.STELLAR_RECONCILIATION_INTERVAL;
    this.config = {
      interval: (envInterval as CronExpression) || '*/15 * * * *',
      minAgeMinutes: parseInt(process.env.STELLAR_RECONCILIATION_MIN_AGE || '5', 10),
      batchSize: parseInt(process.env.STELLAR_RECONCILIATION_BATCH_SIZE || '50', 10),
      maxRetries: parseInt(process.env.STELLAR_RECONCILIATION_MAX_RETRIES || '5', 10),
      backoffBaseMinutes: parseInt(process.env.STELLAR_RECONCILIATION_BACKOFF_BASE || '2', 10),
      sagaBatchSize: parseInt(process.env.STELLAR_SAGA_RECONCILIATION_BATCH_SIZE || '50', 10),
      sagaMaxRetries: parseInt(process.env.STELLAR_SAGA_RECONCILIATION_MAX_RETRIES || '5', 10),
      sagaBackoffBaseMinutes: parseInt(
        process.env.STELLAR_SAGA_RECONCILIATION_BACKOFF_BASE || '2',
        10,
      ),
    };

    this.eventRangeConfig = {
      enabled:
        (process.env.STELLAR_EVENT_RANGE_VERIFY_ENABLED || 'true') === 'true',
      interval:
        process.env.STELLAR_EVENT_RANGE_VERIFY_INTERVAL || '*/30 * * * *',
      checkpointWindow: parseInt(
        process.env.STELLAR_EVENT_RANGE_VERIFY_WINDOW || '10',
        10,
      ),
      maxReprocessRanges: parseInt(
        process.env.STELLAR_EVENT_RANGE_MAX_REPROCESS_RANGES || '5',
        10,
      ),
      maxLedgersPerRange: parseInt(
        process.env.STELLAR_EVENT_RANGE_MAX_LEDGERS_PER_RANGE || '1000',
        10,
      ),
      reprocessEnabled:
        (process.env.STELLAR_EVENT_RANGE_REPROCESS_ENABLED || 'true') === 'true',
    };
  }

  @Cron(process.env.STELLAR_RECONCILIATION_INTERVAL || '*/15 * * * *')
  async reconcilePendingAnchors() {
    const minAgeMs = this.config.minAgeMinutes * 60 * 1000;

    // Process both PENDING (initial anchoring) and OBSERVED (finality re-check)
    const anchors = await this.anchorRepository.find({
      where: [
        {
          status: AnchorStatus.PENDING,
          createdAt: LessThan(new Date(Date.now() - minAgeMs)),
        },
        {
          // Re-verify OBSERVED anchors: they have a tx hash but haven't reached
          // confirmed finality yet. They skip the retry-backoff check because
          // we want to re-verify them every reconciliation run until confirmed.
          status: AnchorStatus.OBSERVED,
        },
      ],
      take: this.config.batchSize,
      order: { createdAt: 'ASC' },
    });

    if (anchors.length === 0) return;

    this.logger.log(
      `Reconciling ${anchors.length} anchors ` +
        `(${anchors.filter((a) => a.status === AnchorStatus.PENDING).length} pending, ` +
        `${anchors.filter((a) => a.status === AnchorStatus.OBSERVED).length} observed) ` +
        `(batch size: ${this.config.batchSize})`,
    );

    let reconciled = 0;
    let failed = 0;
    let expired = 0;

    for (const anchor of anchors) {
      const result = await this.retryAnchor(anchor);
      if (result === 'anchored') reconciled++;
      else if (result === 'failed') failed++;
      else if (result === 'expired') expired++;
    }

    this.logger.log(
      `Reconciliation complete: ${reconciled} anchored, ${failed} failed, ${expired} expired`,
    );

    if (failed > 0 || expired > 0) {
      this.eventEmitter.emit('stellar.reconciliation.discrepancies', {
        reconciled,
        failed,
        expired,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Periodic read-only verification of indexed Soroban event ranges.
   *
   * Compares indexed checkpoints against ledger data, reports gaps by
   * checkpoint, and (when enabled) triggers bounded, idempotent reprocessing
   * of the reported gap ranges. Never mutates anchor state directly.
   */
  @Cron(process.env.STELLAR_EVENT_RANGE_VERIFY_INTERVAL || '*/30 * * * *')
  async verifyIndexedEventRanges(): Promise<void> {
    if (!this.eventRangeConfig.enabled) {
      return;
    }
    if (!this.eventRangeVerifier || this.eventRangeVerificationRunning) return;

    this.eventRangeVerificationRunning = true;
    try {
      const checkpointIds = await this.eventRangeVerifier.listCheckpoints(
        this.eventRangeConfig.checkpointWindow,
      );
      const gapsByCheckpoint: Record<string, EventRangeGap[]> = {};
      for (const checkpointId of checkpointIds) {
        try {
          const result = await this.eventRangeVerifier.verifyCheckpoint(checkpointId);
          if (!result.verified && result.gaps.length > 0) {
            gapsByCheckpoint[checkpointId] = result.gaps;
          }
        } catch (error) {
          this.logger.warn({
            event: 'stellar_event_range_verify_error',
            checkpointId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (this.eventRangeConfig.reprocessEnabled) {
        await this.reprocessGapRanges(randomUUID(), gapsByCheckpoint);
      }
    } finally {
      this.eventRangeVerificationRunning = false;
    }
  }

  /**
   * Reprocesses gap ranges within configured bounds. Each range is clamped to
   * `maxReprocessRanges`. Reprocessing is idempotent and failures are isolated
   * per range so one bad range cannot block the rest.
   */
  private async reprocessGapRanges(
    requestId: string,
    gapsByCheckpoint: Record<string, EventRangeGap[]>,
  ): Promise<void> {
    if (!this.eventRangeVerifier) return;

    let processed = 0;
    let skipped = 0;

    for (const [checkpointId, gaps] of Object.entries(gapsByCheckpoint)) {
      for (const gap of gaps) {
        if (processed >= this.eventRangeConfig.maxReprocessRanges) {
          skipped++;
          continue;
        }

        const fromLedger = Math.min(gap.fromLedger, gap.toLedger);
        const toLedger = Math.min(
          Math.max(gap.fromLedger, gap.toLedger),
          fromLedger + this.eventRangeConfig.maxLedgersPerRange - 1,
        );

        if (toLedger < fromLedger) {
          skipped++;
          continue;
        }

        try {
          await this.eventRangeVerifier.reprocessRange(
            checkpointId,
            fromLedger,
            toLedger,
          );
          processed++;

          this.logger.log({
            event: 'stellar_event_range_reprocessed',
            requestId,
            checkpointId,
            fromLedger,
            toLedger,
            reason: gap.reason,
          });
        } catch (error: any) {
          skipped++;
          this.logger.warn({
            event: 'stellar_event_range_reprocess_error',
            requestId,
            checkpointId,
            fromLedger,
            toLedger,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    this.logger.log({
      event: 'stellar_event_range_reprocess_complete',
      requestId,
      processed,
      skipped,
      maxReprocessRanges: this.eventRangeConfig.maxReprocessRanges,
    });
  }

  /**
   * Bounded recovery for partial multi-contract operations.
   *
   * A saga that is not in a terminal state (COMPLETED / COMPENSATED / FAILED)
   * may have partially applied external calls. Each run re-drives the saga
   * with exponential backoff; once the retry budget is exhausted the saga is
   * marked UNKNOWN so it is surfaced for manual reconciliation instead of
   * being retried forever.
   */
  @Cron(process.env.STELLAR_SAGA_RECONCILIATION_INTERVAL || '*/15 * * * *')
  async reconcilePartialSagas() {
    const sagas = await this.sagaRepository.find({
      where: [
        { status: SagaStatus.PENDING },
        { status: SagaStatus.IN_PROGRESS },
        { status: SagaStatus.COMPENSATING },
      ],
      take: this.config.sagaBatchSize,
      order: { createdAt: 'ASC' },
    });

    if (sagas.length === 0) return;

    this.logger.log(
      `Reconciling ${sagas.length} partial multi-contract sagas ` +
        `(batch size: ${this.config.sagaBatchSize})`,
    );

    let recovered = 0;
    let compensated = 0;
    let unknown = 0;

    for (const saga of sagas) {
      const result = await this.recoverSaga(saga);
      if (result === 'recovered') recovered++;
      else if (result === 'compensated') compensated++;
      else if (result === 'unknown') unknown++;
    }

    this.logger.log(
      `Saga reconciliation complete: ${recovered} recovered, ${compensated} compensated, ${unknown} unknown`,
    );

    if (compensated > 0 || unknown > 0) {
      this.eventEmitter.emit('stellar.saga.reconciliation.discrepancies', {
        recovered,
        compensated,
        unknown,
        timestamp: new Date(),
      });
    }
  }

  private async recoverSaga(
    saga: MultiContractSaga,
  ): Promise<'recovered' | 'compensated' | 'unknown' | 'skipped'> {
    // Exponential backoff between attempts, bounded by the retry budget.
    const delay =
      Math.pow(2, saga.retryCount) *
      this.config.sagaBackoffBaseMinutes *
      60 *
      1000;
    const timeSinceLastRetry =
      Date.now() -
      (saga.lastRetryAt?.getTime() || saga.createdAt.getTime());

    if (timeSinceLastRetry < delay) {
      return 'skipped';
    }

    const requestId = randomUUID();
    saga.retryCount += 1;
    saga.lastRetryAt = new Date();

    try {
      this.logger.debug({
        event: 'stellar_saga_recovery_attempt',
        requestId,
        sagaId: saga.id,
        sagaType: saga.sagaType,
        status: saga.status,
        attemptNumber: saga.retryCount,
      });

      // Re-drive the saga from its last recorded step. The saga service is
      // idempotent per step, so re-invoking a step that already succeeded is
      // safe and lets us resume after an interruption at any external call.
      const outcome = await this.contractService.resumeSaga(saga);

      if (outcome.status === SagaStatus.COMPLETED) {
        saga.status = SagaStatus.COMPLETED;
        saga.lastError = null;
        saga.retryCount = 0;
        await this.sagaRepository.save(saga);

        await this.auditService.log({
          actionType: AuditActionType.STELLAR_SAGA_RECOVERED,
          metadata: {
            requestId,
            entityId: saga.id,
            sagaType: saga.sagaType,
            result: 'completed',
            attempt_number: saga.retryCount,
          },
        });
        return 'recovered';
      }

      if (outcome.status === SagaStatus.COMPENSATED) {
        saga.status = SagaStatus.COMPENSATED;
        saga.lastError = null;
        await this.sagaRepository.save(saga);

        await this.auditService.log({
          actionType: AuditActionType.STELLAR_SAGA_COMPENSATED,
          metadata: {
            requestId,
            entityId: saga.id,
            sagaType: saga.sagaType,
            result: 'compensated',
            attempt_number: saga.retryCount,
          },
        });
        return 'compensated';
      }

      // Still partial: keep the saga in its non-terminal state for the next
      // bounded attempt.
      saga.status = outcome.status;
      saga.lastError = outcome.error ?? null;
      await this.sagaRepository.save(saga);
      return 'skipped';
    } catch (error: any) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      saga.lastError = errorMessage;

      this.logger.warn({
        event: 'stellar_saga_recovery_error',
        requestId,
        sagaId: saga.id,
        sagaType: saga.sagaType,
        attemptNumber: saga.retryCount,
        error: errorMessage,
      });

      await this.auditService.log({
        actionType: AuditActionType.STELLAR_SAGA_RECOVERY_FAILED,
        metadata: {
          requestId,
          entityId: saga.id,
          sagaType: saga.sagaType,
          error_message: errorMessage,
          attempt_number: saga.retryCount,
        },
      });

      if (saga.retryCount >= this.config.sagaMaxRetries) {
        // Bounded recovery exhausted: attempt compensation, then mark UNKNOWN
        // so the partial state is surfaced rather than silently retried.
        try {
          await this.contractService.compensateSaga(saga);
          saga.status = SagaStatus.COMPENSATED;
          saga.lastError = errorMessage;
          await this.sagaRepository.save(saga);

          await this.auditService.log({
            actionType: AuditActionType.STELLAR_SAGA_COMPENSATED,
            metadata: {
              requestId,
              entityId: saga.id,
              sagaType: saga.sagaType,
              result: 'compensated_after_max_retries',
              attempts: saga.retryCount,
              last_error: errorMessage,
            },
          });
          return 'compensated';
        } catch (compensationError: any) {
          const compensationMessage =
            compensationError instanceof Error
              ? compensationError.message
              : String(compensationError);

          saga.status = SagaStatus.UNKNOWN;
          saga.lastError = compensationMessage;
          await this.sagaRepository.save(saga);

          this.logger.error({
            event: 'stellar_saga_unknown',
            requestId,
            sagaId: saga.id,
            sagaType: saga.sagaType,
            attempts: saga.retryCount,
            error: errorMessage,
            compensationError: compensationMessage,
          });

          await this.auditService.log({
            actionType: AuditActionType.STELLAR_SAGA_UNKNOWN,
            metadata: {
              requestId,
              entityId: saga.id,
              sagaType: saga.sagaType,
              attempts: saga.retryCount,
              last_error: errorMessage,
              compensation_error: compensationMessage,
            },
          });
          return 'unknown';
        }
      }

      await this.sagaRepository.save(saga);
      return 'skipped';
    }
  }

  private async retryAnchor(
    anchor: StellarAnchor,
  ): Promise<'anchored' | 'failed' | 'expired' | 'skipped'> {
    // For OBSERVED anchors, we re-verify finality immediately without backoff.
    if (anchor.status === AnchorStatus.PENDING) {
      const delay =
        Math.pow(2, anchor.retryCount) *
        this.config.backoffBaseMinutes *
        60 *
        1000;
      const timeSinceLastRetry =
        Date.now() -
        (anchor.lastRetryAt?.getTime() || anchor.createdAt.getTime());

      if (timeSinceLastRetry < delay) {
        return 'skipped';
      }
    }

    anchor.retryCount += 1;
    anchor.lastRetryAt = new Date();

    const requestId = randomUUID();

    try {
      this.logger.debug({
        event: 'stellar_anchor_retry',
        requestId,
        anchorId: anchor.id,
        confessionId: anchor.confessionId,
        txHash: anchor.stellarTxHash || undefined,
        status: anchor.status,
        attemptNumber: anchor.retryCount,
      });

      const confession = await this.confessionRepository.findOne({
        where: { id: anchor.confessionId },
      });
      if (!confession) {
        await this.auditService.log({
          actionType: AuditActionType.STELLAR_ANCHOR_RETRY,
          metadata: {
            requestId,
            entityId: anchor.id,
            confessionId: anchor.confessionId,
            error: 'Confession not found',
            attempt_number: anchor.retryCount,
          },
        });
        anchor.status = AnchorStatus.FAILED;
        anchor.lastError = 'Confession not found';
        await this.anchorRepository.save(anchor);
        return 'failed';
      }

      // Check Stellar Horizon for existing transaction status
      if (anchor.stellarTxHash) {
        const txValid = await this.stellarService.verifyTransaction(
          anchor.stellarTxHash,
        );
        if (txValid) {
          if (anchor.status === AnchorStatus.OBSERVED) {
            // A successful transaction alone does not prove *this* confession
            // was anchored — the recorded tx hash could belong to an
            // unrelated or stale submission. Confirm the contract's on-chain
            // state actually holds the locally-computed hash before
            // graduating to the final ANCHORED status.
            const payloadMatches =
              !!confession.stellarHash &&
              (await this.contractService.verifyConfession(
                confession.stellarHash,
              )) !== null;

            if (!payloadMatches) {
              anchor.lastError =
                'Anchor hash mismatch: on-chain transaction does not anchor the expected confession hash';
              await this.anchorRepository.save(anchor);

              this.logger.warn({
                event: 'stellar_anchor_hash_mismatch',
                requestId,
                confessionId: anchor.confessionId,
                txHash: anchor.stellarTxHash,
                message: `Transaction ${anchor.stellarTxHash} succeeded on-chain but does not anchor the expected confession hash for confession ${anchor.confessionId}`,
              });
              return 'failed';
            }

            // Second verification confirmed: graduate from OBSERVED (provisional) -> ANCHORED (final)
            anchor.status = AnchorStatus.ANCHORED;
            anchor.observedAt = null;
            anchor.retryCount = 0;
            anchor.lastError = null;
            await this.anchorRepository.save(anchor);

            confession.isAnchored = true;
            confession.anchoredAt = new Date();
            await this.confessionRepository.save(confession);

            this.logger.log({
              event: 'stellar_anchor_confirmed',
              requestId,
              confessionId: anchor.confessionId,
              txHash: anchor.stellarTxHash,
              message: `Anchor finality confirmed via Horizon check for confession ${anchor.confessionId}`,
            });
            return 'anchored';
          } else {
            // First time observed on-chain: mark as OBSERVED (provisional status)
            anchor.status = AnchorStatus.OBSERVED;
            anchor.observedAt = new Date();
            await this.anchorRepository.save(anchor);

            this.logger.log({
              event: 'stellar_anchor_observed',
              requestId,
              confessionId: anchor.confessionId,
              txHash: anchor.stellarTxHash,
              message: `Anchor observed on-chain (provisional) for confession ${anchor.confessionId}`,
            });
            return 'anchored';
          }
        } else {
          // Transaction missing or disappeared (e.g. chain reorg)
          if (anchor.status === AnchorStatus.OBSERVED) {
            this.logger.warn({
              event: 'stellar_anchor_reorg_detected',
              requestId,
              confessionId: anchor.confessionId,
              txHash: anchor.stellarTxHash,
              message: `Observed transaction disappeared (reorg detected) for confession ${anchor.confessionId}`,
            });
            // Revert back to PENDING so it can be re-anchored
            anchor.status = AnchorStatus.PENDING;
            anchor.stellarTxHash = undefined as any;
            anchor.observedAt = null;
            await this.anchorRepository.save(anchor);
          }
        }
      }

      const aesKey = this.configService.get<string>(
        'app.confessionAesKey',
        '',
      );
      const decryptedMessage = decryptConfession(confession.message, aesKey);

      const timestamp = Date.now();
      const hash = this.stellarService.hashConfession(
        decryptedMessage,
        timestamp,
      );

      const serverSecret = this.configService.get<string>(
        'STELLAR_SERVER_SECRET',
      );
      if (!serverSecret) {
        throw new Error('Server secret key not configured');
      }

      const txResult = await this.contractService.anchorConfession(
        hash,
        timestamp,
        serverSecret,
      );

      // Transition to OBSERVED (provisional) state first
      anchor.status = AnchorStatus.OBSERVED;
      anchor.stellarTxHash = txResult.hash;
      anchor.observedAt = new Date();
      anchor.retryCount = 0;
      anchor.lastError = null;
      await this.anchorRepository.save(anchor);

      confession.stellarTxHash = txResult.hash;
      confession.stellarHash = hash;
      await this.confessionRepository.save(confession);

      this.logger.log({
        event: 'stellar_anchor_submitted',
        requestId,
        confessionId: anchor.confessionId,
        txHash: txResult.hash,
        message: `Successfully submitted anchor (provisional) for confession ${anchor.confessionId}`,
      });

      await this.auditService.log({
        actionType: AuditActionType.STELLAR_ANCHOR_RETRY,
        metadata: {
          requestId,
          entityId: anchor.id,
          confessionId: anchor.confessionId,
          result: 'observed',
          txHash: txResult.hash,
          attempt_number: anchor.retryCount,
        },
      });

      return 'anchored';
    } catch (error: any) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      anchor.lastError = errorMessage;

      this.logger.warn({
        event: 'stellar_anchor_retry_error',
        requestId,
        confessionId: anchor.confessionId,
        txHash: anchor.stellarTxHash || undefined,
        anchorId: anchor.id,
        attemptNumber: anchor.retryCount,
        error: errorMessage,
      });

      await this.auditService.log({
        actionType: AuditActionType.STELLAR_ANCHOR_RETRY,
        metadata: {
          requestId,
          entityId: anchor.id,
          confessionId: anchor.confessionId,
          error_message: errorMessage,
          attempt_number: anchor.retryCount,
        },
      });

      if (anchor.retryCount >= this.config.maxRetries) {
        anchor.status = AnchorStatus.FAILED;

        this.logger.error({
          event: 'stellar_anchor_failed',
          requestId,
          confessionId: anchor.confessionId,
          txHash: anchor.stellarTxHash || undefined,
          anchorId: anchor.id,
          attempts: anchor.retryCount,
        });

        await this.auditService.log({
          actionType: AuditActionType.STELLAR_ANCHOR_FAILED,
          metadata: {
            requestId,
            entityId: anchor.id,
            confessionId: anchor.confessionId,
            attempts: anchor.retryCount,
            last_error: errorMessage,
          },
        });

        await this.anchorRepository.save(anchor);
        return 'failed';
      }

      // Mark as expired if anchor is older than 24 hours and still pending
      const ageHours =
        (Date.now() - anchor.createdAt.getTime()) / (1000 * 60 * 60);
      if (ageHours > 24) {
        anchor.status = AnchorStatus.EXPIRED;
        await this.anchorRepository.save(anchor);

        await this.auditService.log({
          actionType: AuditActionType.STELLAR_ANCHOR_FAILED,
          metadata: {
            requestId,
            entityId: anchor.id,
            confessionId: anchor.confessionId,
            reason: 'expired',
            ageHours,
          },
        });

        this.logger.warn(
          `Anchor ${anchor.id} (confession: ${anchor.confessionId}) expired after ${ageHours.toFixed(1)} hours`,
        );
        return 'expired';
      }

      await this.anchorRepository.save(anchor);
      return 'failed';
    }
  }
}
