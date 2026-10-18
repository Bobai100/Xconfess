import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Tip, TipVerificationStatus } from './entities/tip.entity';
import {
  PendingSubmission,
  PendingSubmissionStatus,
} from './entities/pending-submission.entity';
import {
  StellarService,
  TransactionFinality,
  TransactionFinalityState,
} from '../stellar/stellar.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditActionType } from '../audit-log/audit-log.entity';
import { AnalyticsEventService } from '../analytics/analytics-event.service';
import { AnalyticsNetwork } from '../analytics/entities/analytics-event.entity';
import {
  MAX_TIP_AMOUNT,
  MIN_TIP_AMOUNT,
  TIP_PRECISION,
} from './tipping.constants';

interface ReconciliationMetrics {
  totalPending: number;
  reconciled: number;
  confirmed: number;
  failed: number;
  stuck: number;
  lastRun: Date;
  duration: number;
  errors: string[];
  pendingSubmissions?: PendingSubmissionReconciliationMetrics;
}

interface PendingSubmissionReconciliationMetrics {
  total: number;
  confirmed: number;
  failed: number;
  expired: number;
  stillPending: number;
  errors: string[];
}

/**
 * Authorization context for reconciliation actions.
 * Issue #279: Reconciliation actions must be explicitly authorized.
 */
export interface ReconciliationActor {
  type: 'system' | 'operator';
  id: string;
}

/**
 * Result of reconciling a single pending submission by operation intent.
 * Issue #279: Durable pending state + reconciliation lookup keyed by intent.
 */
export interface PendingSubmissionReconciliationResult {
  operationIntent: string;
  status: PendingSubmissionStatus;
  txId?: string;
  error?: string;
}

/**
 * Issue #270: user-visible finality states derived from authoritative chain evidence.
 * Only FINALIZED evidence may promote a tip to VERIFIED.
 */
export enum LedgerFinalityState {
  /** Submitted to the network but not yet observed in a ledger. */
  ACCEPTED = 'accepted',
  /** Observed in a ledger but not yet final (e.g. insufficient confirmations). */
  INCLUDED = 'included',
  /** Observed in a finalized ledger; safe to promote. */
  FINALIZED = 'finalized',
  /** Observed on-chain as failed. */
  FAILED = 'failed',
  /** RPC could not provide authoritative evidence (timeout, not found, conflict). */
  UNKNOWN = 'unknown',
}

/**
 * Issue #271: lineage of a logical transaction that may have been fee-bumped.
 */
export interface FeeBumpLineage {
  logicalTxId: string;
  originalTxHash: string;
  replacementTxHash?: string;
  replacementCount: number;
}

interface DeadLetterRecord {
  tipId: string;
  txId: string;
  confessionId: string;
  lastError: string;
  attemptCount: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
}

/**
 * Chain Reconciliation Service
 * Issue #173: Continuously resolves pending anchor/tip records against authoritative chain state.
 *
 * This service:
 * - Runs on a schedule to check pending tips
 * - Updates tip status based on chain confirmation
 * - Implements exponential backoff for retries
 * - Tracks dead-letter (permanently stuck) records
 * - Emits structured logs and metrics
 */
@Injectable()
export class ChainReconciliationService {
  private readonly logger = new Logger(ChainReconciliationService.name);
  private readonly MAX_RETRY_ATTEMPTS = 10;
  private readonly INITIAL_BACKOFF_MS = 5000; // 5 seconds
  private readonly MAX_BACKOFF_MS = 3600000; // 1 hour
  private readonly STALE_THRESHOLD_MS = 86400000; // 24 hours
  private readonly DEFAULT_PENDING_SUBMISSION_TTL_MS = 3600000; // 1 hour
  private lastMetrics: ReconciliationMetrics | null = null;
  /**
   * Issue #270: minimum number of ledger confirmations before a transaction is
   * treated as FINALIZED. Configurable via STELLAR_FINALITY_CONFIRMATIONS.
   */
  private readonly REQUIRED_CONFIRMATIONS: number;

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    private readonly stellarService: StellarService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly analyticsEventService?: AnalyticsEventService,
    @Optional()
    @InjectRepository(PendingSubmission)
    private readonly pendingSubmissionRepository?: Repository<PendingSubmission>,
  ) {
    const configured = Number(
      this.configService.get<string>('STELLAR_FINALITY_CONFIRMATIONS') ?? '1',
    );
    this.REQUIRED_CONFIRMATIONS =
      Number.isFinite(configured) && configured >= 1 ? configured : 1;
  }

  /**
   * Get last reconciliation metrics
   */
  getLastMetrics(): ReconciliationMetrics | null {
    return this.lastMetrics;
  }

  /**
   * Calculate exponential backoff with jitter
   * Issue #173: Bounded retries with backoff
   */
  private calculateBackoffMs(attemptNumber: number): number {
    const exponentialBackoff = Math.min(
      this.INITIAL_BACKOFF_MS * Math.pow(2, attemptNumber - 1),
      this.MAX_BACKOFF_MS,
    );

    // Add jitter: ±20% of backoff time
    const jitter = exponentialBackoff * 0.2 * (Math.random() * 2 - 1);
    return Math.min(
      Math.max(exponentialBackoff + jitter, this.INITIAL_BACKOFF_MS),
      this.MAX_BACKOFF_MS,
    );
  }

  /**
   * Check if a pending tip should be retried
   */
  private shouldRetry(tip: Tip): boolean {
    if (!tip.lastCheckedAt) {
      return true; // Never checked, should retry
    }

    if (tip.retryCount >= this.MAX_RETRY_ATTEMPTS) {
      return false; // Max retries exceeded
    }

    const nextRetryTime = new Date(
      tip.lastCheckedAt.getTime() +
        this.calculateBackoffMs(tip.retryCount + 1),
    );

    return new Date() >= nextRetryTime;
  }

  /**
   * Create dead-letter record for permanently stuck tips
   * Issue #173: Dead-letter visibility for unresolved cases
   */
  private createDeadLetterRecord(
    tip: Tip,
    lastError: string,
  ): DeadLetterRecord {
    return {
      tipId: tip.id,
      txId: tip.txId,
      confessionId: tip.confessionId,
      lastError,
      attemptCount: tip.retryCount,
      firstFailedAt: tip.verificationStatus === TipVerificationStatus.PENDING
        ? tip.createdAt
        : tip.lastCheckedAt || tip.createdAt,
      lastFailedAt: new Date(),
    };
  }

  private validatePersistedTipAmount(tip: Tip): string | null {
    const amount = Number(tip.amount);

    if (!Number.isFinite(amount)) {
      return 'Tip amount is not a finite number';
    }

    if (amount < MIN_TIP_AMOUNT) {
      return `Tip amount ${amount} XLM is below minimum of ${MIN_TIP_AMOUNT} XLM`;
    }

    if (amount > MAX_TIP_AMOUNT) {
      return `Tip amount ${amount} XLM exceeds maximum of ${MAX_TIP_AMOUNT} XLM`;
    }

    const [, decimalPart = ''] = String(tip.amount).split('.');
    if (decimalPart.length > TIP_PRECISION) {
      return `Tip amount has ${decimalPart.length} decimal places, maximum allowed is ${TIP_PRECISION}`;
    }

    return null;
  }

  /**
   * Issue #270: map a StellarService finality observation onto a user-visible
   * ledger finality state. Unknown/absent evidence is never treated as success.
   */
  private toLedgerFinalityState(
    finality: TransactionFinality | null | undefined,
  ): LedgerFinalityState {
    if (!finality) {
      return LedgerFinalityState.UNKNOWN;
    }

    switch (finality.state) {
      case TransactionFinalityState.FINALIZED:
        return LedgerFinalityState.FINALIZED;
      case TransactionFinalityState.INCLUDED:
        return LedgerFinalityState.INCLUDED;
      case TransactionFinalityState.FAILED:
        return LedgerFinalityState.FAILED;
      case TransactionFinalityState.ACCEPTED:
        return LedgerFinalityState.ACCEPTED;
      case TransactionFinalityState.UNKNOWN:
      default:
        return LedgerFinalityState.UNKNOWN;
    }
  }

  /**
   * Issue #270: a finality observation is only promotable when it is FINALIZED
   * and carries at least the configured number of confirmations.
   */
  private isVerifiedFinalized(
    finality: TransactionFinality | null | undefined,
  ): boolean {
    if (!finality) {
      return false;
    }
    if (finality.state !== TransactionFinalityState.FINALIZED) {
      return false;
    }
    const confirmations = finality.confirmations ?? 0;
    return confirmations >= this.REQUIRED_CONFIRMATIONS;
  }

  /**
   * Issue #271: resolve the logical transaction id for a tip, following any
   * persisted fee-bump replacement lineage. Falls back to the tip's own hash.
   */
  private resolveLogicalTxId(tip: Tip): string {
    const metadata = (tip.reconciliationMetadata ?? {}) as Record<
      string,
      unknown
    >;
    const logicalTxId = metadata.logicalTxId;
    if (typeof logicalTxId === 'string' && logicalTxId.length > 0) {
      return logicalTxId;
    }
    return tip.txId;
  }

  /**
   * Issue #271: detect whether the observed hash is a fee-bump replacement of
   * the tip's original hash and, if so, return the lineage to persist.
   */
  private detectFeeBumpLineage(
    tip: Tip,
    finality: TransactionFinality | null | undefined,
  ): FeeBumpLineage | null {
    if (!finality) {
      return null;
    }

    const observedHash = finality.txHash;
    const originalHash = tip.txId;
    const isReplacement =
      Boolean(finality.replacesTxHash) ||
      (typeof observedHash === 'string' &&
        observedHash.length > 0 &&
        observedHash !== originalHash);

    if (!isReplacement || !observedHash) {
      return null;
    }

    const metadata = (tip.reconciliationMetadata ?? {}) as Record<
      string,
      unknown
    >;
    const previousCount =
      typeof metadata.replacementCount === 'number'
        ? metadata.replacementCount
        : 0;

    return {
      logicalTxId: this.resolveLogicalTxId(tip),
      originalTxHash: originalHash,
      replacementTxHash: observedHash,
      replacementCount: previousCount + 1,
    };
  }

  private getAnalyticsNetwork(): AnalyticsNetwork {
    return this.configService.get<string>('STELLAR_NETWORK') === 'mainnet'
      ? 'mainnet'
      : 'testnet';
  }

  /**
   * Issue #279: Resolve the TTL after which an unresolved pending submission
   * is considered expired (ambiguous outcome that never resolved on-chain).
   */
  private getPendingSubmissionTtlMs(): number {
    const configured = Number(
      this.configService.get<string>('PENDING_SUBMISSION_TTL_MS'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : this.DEFAULT_PENDING_SUBMISSION_TTL_MS;
  }

  /**
   * Issue #279: Enforce explicit authorization for reconciliation actions.
   * Only the system scheduler or an authenticated operator may reconcile.
   */
  private assertReconciliationAuthorized(actor?: ReconciliationActor): void {
    if (!actor) {
      throw new Error('Reconciliation requires an explicit actor context');
    }
    if (actor.type !== 'system' && actor.type !== 'operator') {
      throw new Error(
        `Reconciliation actor type '${actor.type}' is not authorized`,
      );
    }
    if (!actor.id || actor.id.trim().length === 0) {
      throw new Error('Reconciliation actor id must be provided');
    }
  }

  /**
   * Issue #279: Look up a durable pending submission by operation intent.
   * Returns null when no submission was ever recorded for the intent.
   */
  async findByOperationIntent(
    operationIntent: string,
  ): Promise<PendingSubmission | null> {
    if (!this.pendingSubmissionRepository) {
      return null;
    }
    if (!operationIntent || operationIntent.trim().length === 0) {
      throw new Error('operationIntent is required for reconciliation lookup');
    }
    return this.pendingSubmissionRepository.findOne({
      where: { operationIntent },
    });
  }

  /**
   * Issue #279: Reconcile a single pending submission against chain state.
   * Transitions the durable record to CONFIRMED, FAILED or EXPIRED exactly once,
   * so retries converge without duplicating the underlying operation.
   */
  async reconcilePendingSubmission(
    operationIntent: string,
    actor: ReconciliationActor = { type: 'system', id: 'chain-reconciliation' },
  ): Promise<PendingSubmissionReconciliationResult> {
    this.assertReconciliationAuthorized(actor);

    if (!this.pendingSubmissionRepository) {
      throw new Error(
        'Pending submission repository is not configured for reconciliation',
      );
    }

    const submission = await this.findByOperationIntent(operationIntent);
    if (!submission) {
      throw new Error(
        `No pending submission found for operation intent '${operationIntent}'`,
      );
    }

    // Terminal states are idempotent: retries converge on the same outcome.
    if (submission.status !== PendingSubmissionStatus.PENDING) {
      return {
        operationIntent,
        status: submission.status,
        txId: submission.txId,
      };
    }

    const now = new Date();
    const ttlMs = this.getPendingSubmissionTtlMs();
    const isExpired =
      now.getTime() - new Date(submission.createdAt).getTime() > ttlMs;

    let nextStatus: PendingSubmissionStatus = PendingSubmissionStatus.PENDING;
    let error: string | undefined;

    if (submission.txId) {
      try {
        const txData = await this.stellarService.verifyTransactionFull(
          submission.txId,
        );
        if (txData && txData.success) {
          nextStatus = PendingSubmissionStatus.CONFIRMED;
        } else if (txData && txData.success === false) {
          nextStatus = PendingSubmissionStatus.FAILED;
          error = 'Transaction failed on-chain';
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Pending submission ${operationIntent} lookup failed: ${error}`,
        );
      }
    }

    // If the chain outcome is still ambiguous and the record is past its TTL,
    // mark it expired so callers stop retrying and can surface a clear outcome.
    if (nextStatus === PendingSubmissionStatus.PENDING && isExpired) {
      nextStatus = PendingSubmissionStatus.EXPIRED;
      error = error ?? 'Pending submission expired without chain confirmation';
    }

    if (nextStatus === PendingSubmissionStatus.PENDING) {
      await this.pendingSubmissionRepository.update(submission.id, {
        lastCheckedAt: now,
        attemptCount: submission.attemptCount + 1,
        lastError: error ?? null,
      });
      return { operationIntent, status: nextStatus, txId: submission.txId };
    }

    await this.pendingSubmissionRepository.update(submission.id, {
      status: nextStatus,
      lastCheckedAt: now,
      resolvedAt: now,
      attemptCount: submission.attemptCount + 1,
      lastError: error ?? null,
    });

    await this.auditLogService
      .log({
        actionType: AuditActionType.TIP_RECONCILIATION_DEAD_LETTER,
        context: {
          userId: null,
          actor: { type: actor.type, id: actor.id },
        },
        metadata: {
          entityType: 'PENDING_SUBMISSION',
          entityId: submission.id,
          operationIntent,
          txId: submission.txId,
          finalStatus: nextStatus,
          error: error ?? null,
          description: `Pending submission ${operationIntent} resolved to ${nextStatus}`,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to audit pending submission ${operationIntent}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    return { operationIntent, status: nextStatus, txId: submission.txId };
  }

  /**
   * Issue #279: Reconcile all durable pending submissions.
   * Used by the scheduled loop and by operators via manual trigger.
   */
  async reconcilePendingSubmissions(
    actor: ReconciliationActor = { type: 'system', id: 'chain-reconciliation' },
  ): Promise<PendingSubmissionReconciliationMetrics> {
    this.assertReconciliationAuthorized(actor);

    const metrics: PendingSubmissionReconciliationMetrics = {
      total: 0,
      confirmed: 0,
      failed: 0,
      expired: 0,
      stillPending: 0,
      errors: [],
    };

    if (!this.pendingSubmissionRepository) {
      return metrics;
    }

    const pending = await this.pendingSubmissionRepository.find({
      where: { status: PendingSubmissionStatus.PENDING },
      order: { createdAt: 'ASC' },
    });

    metrics.total = pending.length;

    for (const submission of pending) {
      try {
        const result = await this.reconcilePendingSubmission(
          submission.operationIntent,
          actor,
        );
        switch (result.status) {
          case PendingSubmissionStatus.CONFIRMED:
            metrics.confirmed++;
            break;
          case PendingSubmissionStatus.FAILED:
            metrics.failed++;
            break;
          case PendingSubmissionStatus.EXPIRED:
            metrics.expired++;
            break;
          default:
            metrics.stillPending++;
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        metrics.errors.push(
          `Error reconciling pending submission ${submission.operationIntent}: ${message}`,
        );
        this.logger.error(
          `Failed to reconcile pending submission ${submission.operationIntent}: ${message}`,
        );
      }
    }

    return metrics;
  }

  private async recordReconciliationAnalytics(
    tip: Tip,
    status: TipVerificationStatus,
  ): Promise<void> {
    if (!this.analyticsEventService) {
      return;
    }

    const network = this.getAnalyticsNetwork();
    if (status === TipVerificationStatus.VERIFIED) {
      const amountAtomic = Math.round(Number(tip.amount) * 10_000_000).toString();
      await Promise.all([
        this.analyticsEventService.record({
          eventName: 'tip_completed',
          txHash: tip.txId,
          assetCode: 'XLM',
          amountAtomic,
          network,
          idempotencyKey: `tip_completed:${tip.txId}`,
          metadata: {
            source: 'chain_reconciliation',
            tipId: tip.id,
            confessionId: tip.confessionId,
          },
        }),
        this.analyticsEventService.record({
          eventName: 'stellar_tx_confirmed',
          txHash: tip.txId,
          assetCode: 'XLM',
          amountAtomic,
          network,
          idempotencyKey: `stellar_tx_confirmed:${tip.txId}`,
          metadata: { source: 'chain_reconciliation' },
        }),
      ]);
      return;
    }

    if (status === TipVerificationStatus.REJECTED) {
      await this.analyticsEventService.record({
        eventName: 'stellar_tx_failed',
        txHash: tip.txId,
        network,
        idempotencyKey: `stellar_tx_failed:${tip.txId}`,
        metadata: {
          source: 'chain_reconciliation',
          state: 'failed',
          tipId: tip.id,
          confessionId: tip.confessionId,
        },
      });
    }
  }

  /**
   * Reconcile a single pending tip
   * Issue #173: Re-check chain status and progress records
   */
  private async reconcileSingleTip(tip: Tip): Promise<{
    success: boolean;
    newStatus?: TipVerificationStatus;
    error?: string;
    finalityState?: LedgerFinalityState;
    lineage?: FeeBumpLineage | null;
  }> {
    try {
      // Issue #270: query authoritative finality evidence for the logical tx.
      const logicalTxId = this.resolveLogicalTxId(tip);
      const finality = await this.stellarService.getFinality(logicalTxId);
      const finalityState = this.toLedgerFinalityState(finality);
      const lineage = this.detectFeeBumpLineage(tip, finality);

      // Issue #270: only FINALIZED evidence may promote a tip to VERIFIED.
      if (this.isVerifiedFinalized(finality)) {
        const amountError = this.validatePersistedTipAmount(tip);
        if (amountError) {
          return {
            success: false,
            error: `Cannot mark reconciled tip as verified: ${amountError}`,
            finalityState,
            lineage,
          };
        }

        return {
          success: true,
          newStatus: TipVerificationStatus.VERIFIED,
          finalityState,
          lineage,
        };
      }

      if (finalityState === LedgerFinalityState.FAILED) {
        // Observed on-chain as failed: terminal rejection.
        return {
          success: true,
          newStatus: TipVerificationStatus.REJECTED,
          finalityState,
          lineage,
        };
      }

      // ACCEPTED / INCLUDED / UNKNOWN: not yet final. Do not promote or reject;
      // surface as a retryable observation so the record stays pending.
      return {
        success: false,
        error: `Transaction ${logicalTxId} not finalized (state=${finalityState})`,
        finalityState,
        lineage,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if this is a transient or permanent error
      const isTransient =
        errorMessage.includes('timeout') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('rate limit');

      if (!isTransient && tip.retryCount >= this.MAX_RETRY_ATTEMPTS) {
        // Permanent failure after max retries
        return {
          success: false,
          error: `Reconciliation failed after ${tip.retryCount} attempts: ${errorMessage}`,
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Main reconciliation loop
   * Issue #173: Background reconciliation for pending anchor and tip verification records
   * Runs periodically to check stale pending records
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingTips(): Promise<void> {
    const startTime = Date.now();
    const metrics: ReconciliationMetrics = {
      totalPending: 0,
      reconciled: 0,
      confirmed: 0,
      failed: 0,
      stuck: 0,
      lastRun: new Date(),
      duration: 0,
      errors: [],
    };

    try {
      this.logger.log('Starting chain reconciliation for pending tips...');

      // Find all pending tips
      const pendingTips = await this.tipRepository.find({
        where: {
          verificationStatus: In([
            TipVerificationStatus.PENDING,
            TipVerificationStatus.STALE_PENDING,
          ]),
        },
        order: { lastCheckedAt: 'ASC' },
      });

      metrics.totalPending = pendingTips.length;

      if (pendingTips.length === 0) {
        this.logger.debug('No pending tips to reconcile');
        this.lastMetrics = {
          ...metrics,
          duration: Math.max(1, Date.now() - startTime),
        };
        return;
      }

      const deadLetters: DeadLetterRecord[] = [];

      for (const tip of pendingTips) {
        try {
          // Check if we should retry this tip
          if (!this.shouldRetry(tip)) {
            // Mark as stale if not yet marked
            if (
              tip.verificationStatus === TipVerificationStatus.PENDING &&
              tip.lastCheckedAt &&
              new Date().getTime() - tip.lastCheckedAt.getTime() >
                this.STALE_THRESHOLD_MS
            ) {
              await this.tipRepository.update(tip.id, {
                verificationStatus: TipVerificationStatus.STALE_PENDING,
              });
            }
            continue;
          }

          // Attempt reconciliation
          const reconcileResult = await this.reconcileSingleTip(tip);

          if (!reconcileResult.success && reconcileResult.error) {
            // Reconciliation failed, increment retry count
            await this.tipRepository.update(tip.id, {
              retryCount: tip.retryCount + 1,
              lastCheckedAt: new Date(),
              reconciliationMetadata: {
                ...tip.reconciliationMetadata,
                lastReconciliationAttempt: new Date().toISOString(),
                lastReconciliationError: reconcileResult.error,
                attemptCount: tip.retryCount + 1,
                finalityState:
                  reconcileResult.finalityState ?? LedgerFinalityState.UNKNOWN,
                ...(reconcileResult.lineage
                  ? {
                      logicalTxId: reconcileResult.lineage.logicalTxId,
                      replacementTxHash:
                        reconcileResult.lineage.replacementTxHash,
                      replacementCount:
                        reconcileResult.lineage.replacementCount,
                    }
                  : {}),
              } as Tip['reconciliationMetadata'],
            });

            // Check if this is now a dead-letter
            if (tip.retryCount + 1 >= this.MAX_RETRY_ATTEMPTS) {
              deadLetters.push(
                this.createDeadLetterRecord(tip, reconcileResult.error),
              );
              metrics.stuck++;

              this.logger.warn(
                `Tip ${tip.txId} marked as stuck after ${tip.retryCount + 1} failed reconciliation attempts`,
              );
            }

            metrics.failed++;
          } else if (reconcileResult.newStatus) {
            // Reconciliation succeeded, update status
            const newStatus = reconcileResult.newStatus;
            const wasStale =
              tip.verificationStatus === TipVerificationStatus.STALE_PENDING;

            await this.tipRepository.update(tip.id, {
              verificationStatus: newStatus,
              lastCheckedAt: new Date(),
              verifiedAt:
                newStatus === TipVerificationStatus.VERIFIED
                  ? new Date()
                  : null,
              lastChainStatus:
                newStatus === TipVerificationStatus.VERIFIED
                  ? 'verified'
                  : 'rejected',
              processingLock: null,
              lockedAt: null,
              lockedBy: null,
              reconciliationMetadata: {
                ...tip.reconciliationMetadata,
                lastReconciliationAttempt: new Date().toISOString(),
                finalizedStatus: newStatus,
                wasStale,
                reconciliationAttempts: tip.retryCount + 1,
                finalityState:
                  reconcileResult.finalityState ?? LedgerFinalityState.UNKNOWN,
                // Issue #271: collapse fee-bump replacements into one logical record.
                logicalTxId:
                  reconcileResult.lineage?.logicalTxId ??
                  this.resolveLogicalTxId(tip),
                ...(reconcileResult.lineage?.replacementTxHash
                  ? {
                      replacementTxHash:
                        reconcileResult.lineage.replacementTxHash,
                      replacementCount:
                        reconcileResult.lineage.replacementCount,
                    }
                  : {}),
              } as Tip['reconciliationMetadata'],
            });

            if (newStatus === TipVerificationStatus.VERIFIED) {
              metrics.confirmed++;
              await this.auditLogService.log({
                actionType: AuditActionType.TIP_SETTLEMENT_VERIFIED,
                context: {
                  userId: null,
                  actor: {
                    type: 'system',
                    id: 'chain-reconciliation',
                  },
                },
                metadata: {
                  entityType: 'tip',
                  entityId: tip.id,
                  tipId: tip.id,
                  confessionId: tip.confessionId,
                  txId: tip.txId,
                  amount: Number(tip.amount),
                  settledBy: 'chain_reconciliation',
                  settledAt: new Date().toISOString(),
                },
              });
            }

            await this.recordReconciliationAnalytics(tip, newStatus).catch(
              (err) =>
                this.logger.warn(
                  `Failed to record reconciliation analytics for tip ${tip.txId}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
            );

            metrics.reconciled++;

            this.logger.debug(
              `Tip ${tip.txId} reconciled: ${tip.verificationStatus} → ${newStatus}`,
            );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          metrics.errors.push(
            `Error reconciling tip ${tip.txId}: ${errorMessage}`,
          );
          this.logger.error(
            `Failed to reconcile tip ${tip.txId}: ${errorMessage}`,
          );
        }
      }

      // Log dead-letter records to audit trail
      if (deadLetters.length > 0) {
        this.logger.warn(
          `Found ${deadLetters.length} stuck tips requiring operator intervention`,
        );

        for (const deadLetter of deadLetters) {
          await this.auditLogService.log({
            actionType: AuditActionType.TIP_RECONCILIATION_DEAD_LETTER,
            context: {
              userId: null,
              actor: {
                type: 'system',
                id: 'chain-reconciliation',
              },
            },
            metadata: {
              entityType: 'TIP',
              entityId: deadLetter.tipId,
              ...deadLetter,
              description: `Tip ${deadLetter.txId} stuck after ${deadLetter.attemptCount} reconciliation attempts: ${deadLetter.lastError}`,
            },
          });
        }
      }

      // Issue #279: Reconcile durable pending submissions keyed by intent.
      try {
        metrics.pendingSubmissions = await this.reconcilePendingSubmissions({
          type: 'system',
          id: 'chain-reconciliation',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        metrics.errors.push(`Pending submission reconciliation error: ${message}`);
        this.logger.error(
          `Pending submission reconciliation failed: ${message}`,
        );
      }

      metrics.duration = Math.max(1, Date.now() - startTime);

      // Log reconciliation summary
      this.logger.log(
        `Chain reconciliation completed: ${metrics.reconciled}/${metrics.totalPending} reconciled ` +
          `(${metrics.confirmed} confirmed, ${metrics.failed} failed, ${metrics.stuck} stuck) ` +
          `in ${metrics.duration}ms`,
      );

      this.lastMetrics = metrics;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Chain reconciliation loop failed: ${errorMessage}`,
      );

      metrics.duration = Date.now() - startTime;
      metrics.errors.push(`Reconciliation loop error: ${errorMessage}`);
      this.lastMetrics = metrics;
    }
  }

  /**
   * Manual reconciliation trigger for operators
   * Can be called via HTTP endpoint or admin interface
   */
  async manualReconciliation(
    tipIds?: string[],
    actor: ReconciliationActor = { type: 'operator', id: 'manual' },
  ): Promise<ReconciliationMetrics> {
    this.assertReconciliationAuthorized(actor);
    const startTime = Date.now();

    try {
      const tips = tipIds
        ? await this.tipRepository.findByIds(tipIds)
        : await this.tipRepository.find({
            where: {
              verificationStatus: In([
                TipVerificationStatus.PENDING,
                TipVerificationStatus.STALE_PENDING,
              ]),
            },
          });

      const metrics: ReconciliationMetrics = {
        totalPending: tips.length,
        reconciled: 0,
        confirmed: 0,
        failed: 0,
        stuck: 0,
        lastRun: new Date(),
        duration: 0,
        errors: [],
      };

      for (const tip of tips) {
        const reconcileResult = await this.reconcileSingleTip(tip);

        if (reconcileResult.newStatus) {
          await this.tipRepository.update(tip.id, {
            verificationStatus: reconcileResult.newStatus,
            lastCheckedAt: new Date(),
            verifiedAt:
              reconcileResult.newStatus === TipVerificationStatus.VERIFIED
                ? new Date()
                : null,
            lastChainStatus:
              reconcileResult.newStatus === TipVerificationStatus.VERIFIED
                ? 'verified'
                : 'rejected',
            processingLock: null,
            lockedAt: null,
            lockedBy: null,
            reconciliationMetadata: {
              ...tip.reconciliationMetadata,
              lastReconciliationAttempt: new Date().toISOString(),
              finalizedStatus: reconcileResult.newStatus,
              finalityState:
                reconcileResult.finalityState ?? LedgerFinalityState.UNKNOWN,
              // Issue #271: collapse fee-bump replacements into one logical record.
              logicalTxId:
                reconcileResult.lineage?.logicalTxId ??
                this.resolveLogicalTxId(tip),
              ...(reconcileResult.lineage?.replacementTxHash
                ? {
                    replacementTxHash:
                      reconcileResult.lineage.replacementTxHash,
                    replacementCount:
                      reconcileResult.lineage.replacementCount,
                  }
                : {}),
            } as Tip['reconciliationMetadata'],
          });

          metrics.reconciled++;

          if (reconcileResult.newStatus === TipVerificationStatus.VERIFIED) {
            metrics.confirmed++;
            await this.auditLogService.log({
              actionType: AuditActionType.TIP_SETTLEMENT_VERIFIED,
              context: {
                userId: null,
                actor: {
                  type: 'system',
                  id: 'chain-reconciliation',
                },
              },
              metadata: {
                entityType: 'tip',
                entityId: tip.id,
                tipId: tip.id,
                confessionId: tip.confessionId,
                txId: tip.txId,
                amount: Number(tip.amount),
                settledBy: 'chain_reconciliation',
                settledAt: new Date().toISOString(),
              },
            });
          }

          await this.recordReconciliationAnalytics(
            tip,
            reconcileResult.newStatus,
          ).catch((err) =>
            this.logger.warn(
              `Failed to record reconciliation analytics for tip ${tip.txId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        } else if (!reconcileResult.success) {
          metrics.failed++;
          await this.tipRepository.update(tip.id, {
            lastCheckedAt: new Date(),
            reconciliationMetadata: {
              ...tip.reconciliationMetadata,
              lastReconciliationAttempt: new Date().toISOString(),
              lastReconciliationError: reconcileResult.error,
              finalityState:
                reconcileResult.finalityState ?? LedgerFinalityState.UNKNOWN,
              ...(reconcileResult.lineage
                ? {
                    logicalTxId: reconcileResult.lineage.logicalTxId,
                    replacementTxHash:
                      reconcileResult.lineage.replacementTxHash,
                    replacementCount:
                      reconcileResult.lineage.replacementCount,
                  }
                : {}),
            } as Tip['reconciliationMetadata'],
          });
        }
      }

      // Issue #279: Also reconcile durable pending submissions by intent.
      try {
        metrics.pendingSubmissions = await this.reconcilePendingSubmissions(
          actor,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        metrics.errors.push(`Pending submission reconciliation error: ${message}`);
      }

      metrics.duration = Date.now() - startTime;
      return metrics;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        totalPending: 0,
        reconciled: 0,
        confirmed: 0,
        failed: 0,
        stuck: 0,
        lastRun: new Date(),
        duration: Date.now() - startTime,
        errors: [errorMessage],
      };
    }
  }
}
