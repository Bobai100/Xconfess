import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Tip, TipVerificationStatus } from './entities/tip.entity';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { StellarService } from '../stellar/stellar.service';
import { VerifyTipDto } from './dto/verify-tip.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditActionType } from '../audit-log/audit-log.entity';
import * as crypto from 'crypto';
import { AnalyticsEventService } from '../analytics/analytics-event.service';
import { AnalyticsNetwork } from '../analytics/entities/analytics-event.entity';
import {
  MAX_TIP_AMOUNT,
  MIN_TIP_AMOUNT,
  TIP_PRECISION,
} from './tipping.constants';

export interface TipStats {
  totalAmount: number;
  totalCount: number;
  averageAmount: number;
}

/**
 * Canonical, typed outcome of a verify request (issue #1687).
 *
 * - `verified`  — this request performed first-writer settlement.
 * - `duplicate` — a prior request already settled this exact (confession, tx)
 *                 pair; this is a safe, canonical replay, not an error.
 * - `pending`   — another request is actively settling this pair right now.
 * - `stale`     — verification has exceeded the SLA threshold and is under
 *                 reconciliation review; not a terminal failure.
 * - `failed`    — verification failed terminally (invalid tx, bad amount,
 *                 not found on chain) or hit a transient/retryable error.
 * - `conflict`  — the transaction ID is already bound to a different
 *                 confession, or a reconciliation pass flagged a conflict.
 */
export type TipResponseState =
  | 'verified'
  | 'duplicate'
  | 'pending'
  | 'stale'
  | 'failed'
  | 'conflict';

export interface TipVerificationResult {
  tip: Tip;
  isNew: boolean;
  isIdempotent: boolean;
  state: TipResponseState;
  conflictDetails?: {
    reason: 'DIFFERENT_CONFESSION' | 'ALREADY_PROCESSING' | 'ALREADY_VERIFIED';
    originalConfessionId?: string;
    requestId?: string;
  };
}

interface SettlementReceiptMetadata {
  settlementId: string | null;
  proofMetadata: string | null;
  anonymousSender: boolean;
}

interface ProcessedTransactionData {
  amount: number;
  senderAddress: string | null;
  receiptMetadata: SettlementReceiptMetadata;
}

/**
 * Minimal structural contract for the account-scoped sequence coordinator
 * (issue #274). The coordinator serialises sequence allocation per source
 * account across concurrent transaction workers, hands out leases with an
 * expiry, and recovers leases abandoned by a crashed process.
 *
 * It is declared structurally here so the tipping service can depend on it
 * without a hard import cycle, and so tests can inject a fake.
 */
export interface AccountSequenceCoordinator {
  /**
   * Run `work` while holding an exclusive lease on `account`'s sequence.
   * Concurrent callers for the same account are serialised; callers for
   * different accounts proceed in parallel.
   */
  withSequenceLease<T>(
    account: string,
    work: (lease: AccountSequenceLease) => Promise<T>,
    options?: { ownerId?: string; leaseTtlMs?: number },
  ): Promise<T>;
}

export interface AccountSequenceLease {
  account: string;
  /** Monotonic sequence number reserved for this lease. */
  sequence: string;
  /** Unique lease identifier, useful for auditing and recovery. */
  leaseId: string;
  /** Extend the lease if the work is still in flight. */
  renew(ttlMs?: number): Promise<void>;
}

// PostgreSQL unique-violation error code
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Tip amount bounds — must be consistent with contract and frontend.
 * - MIN_TIP_AMOUNT: 0.1 XLM (minimum viable tip)
 * - MAX_TIP_AMOUNT: 10,000 XLM (upper bound to prevent overflow and abuse)
 * - TIP_PRECISION: 7 decimal places (Stellar's native precision for assets)
 */
@Injectable()
export class TippingService {
  private static readonly MAX_RECEIPT_PROOF_METADATA_LEN = 128;
  private static readonly LOCK_TIMEOUT_MS = 30_000; // 30 seconds
  private static readonly DEFAULT_SEQUENCE_LEASE_TTL_MS = 15_000;
  private readonly logger = new Logger(TippingService.name);

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepository: Repository<AnonymousConfession>,
    private readonly stellarService: StellarService,
    private readonly eventEmitter: EventEmitter2,
    private readonly auditLogService: AuditLogService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly analyticsEventService?: AnalyticsEventService,
    @Optional()
    private readonly sequenceCoordinator?: AccountSequenceCoordinator,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get all tips for a confession
   */
  async getTipsByConfessionId(confessionId: string): Promise<Tip[]> {
    return this.tipRepository.find({
      where: { confessionId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get tipping statistics for a confession
   */
  async getTipStats(confessionId: string): Promise<TipStats> {
    const tips = await this.tipRepository.find({
      where: { confessionId },
    });

    const totalAmount = tips.reduce((sum, tip) => sum + Number(tip.amount), 0);
    const totalCount = tips.length;
    const averageAmount = totalCount > 0 ? totalAmount / totalCount : 0;

    return {
      totalAmount,
      totalCount,
      averageAmount,
    };
  }

  /**
   * Get tip by transaction ID
   */
  async getTipByTxId(txId: string): Promise<Tip | null> {
    return this.tipRepository.findOne({
      where: { txId },
      relations: ['confession'],
    });
  }

  /**
   * Verify a Stellar tip transaction and record exactly one credit.
   *
   * Double-credit prevention strategy (issue #1480):
   *
   * 1. **Idempotency key** = SHA256(confessionId:txId) is computed deterministically
   *    for every request.
   *
   * 2. **Atomic sentinel INSERT** — inside a serialisable transaction we attempt to
   *    INSERT a PENDING tip row with the idempotency_key.  The DB-level UNIQUE
   *    constraint on `tips.idempotency_key` guarantees that even if 100 concurrent
   *    requests race past any in-memory check, only ONE will succeed in creating
   *    the row.  All others catch PG error 23505 (unique_violation) and branch
   *    to the idempotent-replay path immediately — no double-credit is possible.
   *
   * 3. **Processing lock** — the winning INSERT also sets `processing_lock` so that
   *    the background reconciliation worker cannot race the in-flight HTTP handler.
   *
   * 4. **Audit log emitted once** — `TIP_SETTLEMENT_VERIFIED` is written only on
   *    the code path that created the sentinel row (isNew = true), so aggregate
   *    totals in the audit trail are always accurate regardless of how many
   *    concurrent verify calls arrive for the same transaction.
   *
   * 5. **Account sequence coordination (issue #274)** — when a sequence
   *    coordinator is configured, the on-chain settlement work runs while
   *    holding an account-scoped sequence lease. Concurrent tipping workers
   *    for the same source account are serialised so they cannot build
   *    transactions from the same sequence and invalidate each other. Leases
   *    carry a TTL and are recovered after process failure by the coordinator.
   *
   * Issues: #1480, #170, #784, #777, #274
   */
  async verifyAndRecordTip(
    confessionId: string,
    dto: VerifyTipDto,
    requestId?: string,
  ): Promise<TipVerificationResult> {
    this.logger.log({
      message: 'Tip verify started',
      requestId,
      confessionId,
      txHash: dto.txId,
    });

    // ── 1. Confession must exist ──────────────────────────────────────────
    const confession = await this.confessionRepository.findOne({
      where: { id: confessionId },
    });

    if (!confession) {
      this.logger.warn({
        message: 'Confession not found',
        requestId,
        confessionId,
        txHash: dto.txId,
      });
      throw new NotFoundException(
        `Confession with ID ${confessionId} not found`,
      );
    }

    // ── 2. Derive idempotency key ────────────────────────────────────────
    const idempotencyKey = this.generateIdempotencyKey(confessionId, dto.txId);
    const existingByIdempotencyKey =
      await this.findTipByIdempotencyKey(idempotencyKey);
    if (existingByIdempotencyKey) {
      if (
        existingByIdempotencyKey.confessionId === confessionId &&
        existingByIdempotencyKey.txId === dto.txId
      ) {
        this.logger.debug({
          message: 'Idempotent replay detected',
          requestId,
          confessionId,
          txHash: dto.txId,
          tipId: existingByIdempotencyKey.id,
          status: existingByIdempotencyKey.verificationStatus,
        });
        return this.resolveIdempotentOutcome(existingByIdempotencyKey);
      }

      this.logger.warn({
        message: 'Idempotency key lookup returned a row that does not match the request payload',
        requestId,
        confessionId,
        txHash: dto.txId,
        tipId: existingByIdempotencyKey.id,
        originalConfessionId: existingByIdempotencyKey.confessionId,
      });
    }

    // ── 3. Atomic sentinel INSERT — the single-credit gate ───────────────
    //
    // We try to INSERT a PENDING row with the idempotency_key.  The DB UNIQUE
    // constraint means only one concurrent caller can win this race.
    //
    //  • INSERT succeeds   → this caller owns the work; proceed to chain verify.
    //  • INSERT fails 23505 → another caller (or a prior completed request)
    //                         already holds this key; return canonical replay.
    const { isFirstWriter, sentinelTip } =
      await this.tryInsertSentinelTip(confessionId, dto.txId, idempotencyKey);

    if (!isFirstWriter) {
      // Another request already settled (or is settling) this (confession, tx).
      // Re-read the latest state to return the canonical response.
      const canonical = await this.findTipByIdempotencyKey(idempotencyKey);

      if (!canonical) {
        // Extremely unlikely — row was deleted between our INSERT failure and
        // this read.  Let the caller retry.
        throw new ConflictException({
          message: `Transaction ${dto.txId} is currently being processed. Please retry in a moment.`,
          state: 'pending' as TipResponseState,
          conflictReason: 'ALREADY_PROCESSING',
          canRetry: true,
        });
      }

      this.logger.debug({
        message: 'Idempotent replay detected',
        requestId,
        confessionId,
        txHash: dto.txId,
        tipId: canonical.id,
        status: canonical.verificationStatus,
      });

      return this.resolveIdempotentOutcome(canonical);
    }

    // ── 4. Guard: txId must not be bound to a different confession ────────
    //
    // With the sentinel inserted we now own the (confessionId, txId) slot.
    // Still check that the raw txId wasn't already finalised for a *different*
    // confession via an older tip row (which would have a different key).
    const tipByTxId = await this.tipRepository.findOne({
      where: { txId: dto.txId },
    });

    if (tipByTxId && tipByTxId.confessionId !== confessionId) {
      // Roll back our sentinel and surface the conflict.
      await this.tipRepository.delete({ id: sentinelTip.id });

      this.logger.warn({
        message: 'Conflict: txId already used for a different confession',
        requestId,
        confessionId,
        txHash: dto.txId,
        originalConfessionId: tipByTxId.confessionId,
      });

      throw new ConflictException({
        message: `Transaction ${dto.txId} was already used for a different confession`,
        state: 'conflict' as TipResponseState,
        conflictReason: 'DIFFERENT_CONFESSION',
        originalConfessionId: tipByTxId.confessionId,
        canRetry: false,
      });
    }

    // ── 5. On-chain verification (sequence-coordinated) ───────────────────
    try {
      return await this.runSequenceCoordinatedSettlement(
        confessionId,
        dto,
        requestId,
        idempotencyKey,
        sentinelTip,
      );
    } catch (error) {
      // Best-effort: release the processing lock so the reconciler can retry.
      // If the sentinel row itself is the problem (e.g. amount/fetch error),
      // we leave it as PENDING so the cron worker can reconcile it later.
      // We intentionally do NOT delete the sentinel here so the UNIQUE index
      // continues to block any further concurrent first-writer attempts.
      try {
        await this.releaseProcessingLock(sentinelTip.id);
      } catch {
        // ignore secondary error
      }

      this.eventEmitter.emit('tip.verification_failed', {
        confessionId,
        txId: dto.txId,
        requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.analyticsEventService
        ?.record({
          eventName: 'stellar_tx_failed',
          txHash: dto.txId,
          network: this.getAnalyticsNetwork(),
          idempotencyKey: `stellar_tx_failed:${dto.txId}`,
          metadata: {
            source: 'tipping_service',
            state: 'failed',
            requestId: requestId ?? null,
          },
        })
        .catch(() => undefined);

      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Sequence-coordinated settlement (issue #274)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the on-chain settlement for a first-writer sentinel while holding an
   * account-scoped sequence lease. When no coordinator is configured we fall
   * back to running the settlement directly (single-worker deployments).
   */
  private async runSequenceCoordinatedSettlement(
    confessionId: string,
    dto: VerifyTipDto,
    requestId: string | undefined,
    idempotencyKey: string,
    sentinelTip: Tip,
  ): Promise<TipVerificationResult> {
    const settlement = () =>
      this.settleSentinelTip(
        confessionId,
        dto,
        requestId,
        idempotencyKey,
        sentinelTip,
      );

    if (!this.sequenceCoordinator) {
      return settlement();
    }

    const account = this.resolveSequenceAccount();
    const leaseTtlMs = this.resolveSequenceLeaseTtlMs();

    this.logger.debug({
      message: 'Acquiring account sequence lease',
      requestId,
      confessionId,
      txHash: dto.txId,
      account,
      leaseTtlMs,
    });

    return this.sequenceCoordinator.withSequenceLease(
      account,
      async (lease) => {
        this.logger.debug({
          message: 'Account sequence lease acquired',
          requestId,
          confessionId,
          txHash: dto.txId,
          account: lease.account,
          sequence: lease.sequence,
          leaseId: lease.leaseId,
        });

        // Persist the reserved sequence so reconciliation can correlate the
        // settlement with the sequence slot it consumed.
        await this.recordSequenceLease(sentinelTip.id, lease);

        return settlement();
      },
      {
        ownerId: `tipping:${requestId ?? sentinelTip.id}`,
        leaseTtlMs,
      },
    );
  }

  /**
   * Resolve the source account whose sequence must be serialised. Tipping
   * settlements are submitted from the configured hot wallet; fall back to a
   * stable sentinel so single-account deployments still serialise correctly.
   */
  private resolveSequenceAccount(): string {
    const configured =
      this.configService?.get<string>('STELLAR_TIPPING_SOURCE_ACCOUNT') ??
      this.configService?.get<string>('STELLAR_HOT_WALLET_PUBLIC_KEY');
    return configured && configured.length > 0 ? configured : 'default-tipping-account';
  }

  private resolveSequenceLeaseTtlMs(): number {
    const raw = this.configService?.get<string>(
      'TIPPING_SEQUENCE_LEASE_TTL_MS',
    );
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : TippingService.DEFAULT_SEQUENCE_LEASE_TTL_MS;
  }

  /**
   * Best-effort persistence of the reserved sequence onto the sentinel row so
   * operators can correlate a settlement with the sequence slot it consumed.
   * Failures here must never abort settlement.
   */
  private async recordSequenceLease(
    tipId: string,
    lease: AccountSequenceLease,
  ): Promise<void> {
    try {
      await this.tipRepository
        .createQueryBuilder()
        .update(Tip)
        .set({
          reconciliationMetadata: () =>
            `COALESCE(reconciliation_metadata, '{}'::jsonb) || :leaseMetadata::jsonb`,
        })
        .setParameters({
          leaseMetadata: JSON.stringify({
            sequenceLease: {
              account: lease.account,
              sequence: lease.sequence,
              leaseId: lease.leaseId,
              acquiredAt: new Date().toISOString(),
            },
          }),
        })
        .where('id = :tipId', { tipId })
        .execute();
    } catch (err) {
      this.logger.warn({
        message: 'Failed to persist sequence lease metadata',
        tipId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Perform the actual on-chain verification and finalisation of a sentinel
   * tip row. Extracted from `verifyAndRecordTip` so it can be wrapped in an
   * account sequence lease without duplicating logic.
   */
  private async settleSentinelTip(
    confessionId: string,
    dto: VerifyTipDto,
    requestId: string | undefined,
    idempotencyKey: string,
    sentinelTip: Tip,
  ): Promise<TipVerificationResult> {
    let isValid = false;
    try {
      isValid = await this.stellarService.verifyTransaction(dto.txId, requestId);
    } catch (verifyError: any) {
      this.logger.warn({
        message: 'Network error verifying transaction, marking for retry',
        requestId,
        confessionId,
        txHash: dto.txId,
        error: verifyError.message,
      });
      await this.updateRetryMetadata(sentinelTip.id, 'network_error', {
        error: verifyError.message,
        attemptedAt: new Date().toISOString(),
      });
      await this.releaseProcessingLock(sentinelTip.id);
      throw new ConflictException({
        message: `Transaction ${dto.txId} verification temporarily failed due to network error. Will be retried.`,
        state: 'failed' as TipResponseState,
        conflictReason: 'NETWORK_ERROR',
        canRetry: true,
      });
    }

    if (!isValid) {
      this.logger.warn({
        message: 'Transaction not found or invalid on Stellar network',
        requestId,
        confessionId,
        txHash: dto.txId,
      });
      await this.updateRetryMetadata(sentinelTip.id, 'not_found', {
        error: 'Transaction not found on chain',
        attemptedAt: new Date().toISOString(),
      });
      await this.releaseProcessingLock(sentinelTip.id);
      throw new BadRequestException(
        'Transaction not found or invalid on Stellar network',
      );
    }

    // ── Fetch Horizon data ─────────────────────────────────────────────
    let txData: any;
    try {
      txData = await this.fetchTransactionData(dto.txId);
    } catch (fetchError: any) {
      const isRetryable =
        fetchError instanceof GatewayTimeoutException ||
        fetchError instanceof NotFoundException;
      if (isRetryable) {
        await this.updateRetryMetadata(sentinelTip.id, 'fetch_retryable', {
          error: fetchError.message,
          attemptedAt: new Date().toISOString(),
        });
        await this.releaseProcessingLock(sentinelTip.id);
        throw new ConflictException({
          message: `Transaction ${dto.txId} data fetch failed temporarily. Will be retried.`,
          state: 'failed' as TipResponseState,
          conflictReason: 'NETWORK_ERROR',
          canRetry: true,
        });
      }
      throw fetchError;
    }

    const processedData = await this.processTransactionData(txData, dto.txId);

    // ── Amount bounds validation ────────────────────────────────────────
    if (processedData.amount < MIN_TIP_AMOUNT) {
      await this.updateRetryMetadata(sentinelTip.id, 'invalid_amount', {
        amount: processedData.amount,
        minRequired: MIN_TIP_AMOUNT,
        maxAllowed: MAX_TIP_AMOUNT,
        reason: 'below_minimum',
      });
      await this.releaseProcessingLock(sentinelTip.id);
      throw new BadRequestException(
        `Tip amount ${processedData.amount} XLM is below minimum of ${MIN_TIP_AMOUNT} XLM`,
      );
    }

    if (processedData.amount > MAX_TIP_AMOUNT) {
      await this.updateRetryMetadata(sentinelTip.id, 'invalid_amount', {
        amount: processedData.amount,
        minRequired: MIN_TIP_AMOUNT,
        maxAllowed: MAX_TIP_AMOUNT,
        reason: 'above_maximum',
      });
      await this.releaseProcessingLock(sentinelTip.id);
      throw new BadRequestException(
        `Tip amount ${processedData.amount} XLM exceeds maximum of ${MAX_TIP_AMOUNT} XLM`,
      );
    }

    // Validate precision: no more than TIP_PRECISION decimal places
    const amountStr = processedData.amount.toString();
    const decimalPart = amountStr.includes('.') ? amountStr.split('.')[1] : '';
    if (decimalPart.length > TIP_PRECISION) {
      await this.updateRetryMetadata(sentinelTip.id, 'invalid_amount', {
        amount: processedData.amount,
        decimalPlaces: decimalPart.length,
        maxPrecision: TIP_PRECISION,
        reason: 'excess_precision',
      });
      await this.releaseProcessingLock(sentinelTip.id);
      throw new BadRequestException(
        `Tip amount has ${decimalPart.length} decimal places, maximum allowed is ${TIP_PRECISION}`,
      );
    }

    // ── Finalise the sentinel row as VERIFIED (single write) ────────────
    const reconciliationMetadata = {
      verifiedBy: 'user_request',
      processedData: {
        amount: processedData.amount,
        senderAddress: processedData.senderAddress,
      },
      receiptMetadata: processedData.receiptMetadata,
      idempotencyKey,
      requestId: requestId ?? null,
    };

    sentinelTip.amount = processedData.amount;
    sentinelTip.senderAddress = processedData.senderAddress;
    sentinelTip.verificationStatus = TipVerificationStatus.VERIFIED;
    sentinelTip.verifiedAt = new Date();
    sentinelTip.lastChainStatus = 'verified';
    sentinelTip.lastCheckedAt = new Date();
    sentinelTip.reconciliationMetadata = reconciliationMetadata;
    sentinelTip.processingLock = null;
    sentinelTip.lockedAt = null;
    sentinelTip.lockedBy = null;

    const savedTip = await this.tipRepository.save(sentinelTip);
    const amountAtomic = Math.round(
      processedData.amount * 10_000_000,
    ).toString();
    const network = this.getAnalyticsNetwork();

    this.analyticsEventService
      ?.record({
        eventName: 'tip_completed',
        txHash: dto.txId,
        assetCode: 'XLM',
        amountAtomic,
        network,
        idempotencyKey: `tip_completed:${dto.txId}`,
        metadata: {
          source: 'tipping_service',
          tipId: savedTip.id,
          confessionId,
          requestId: requestId ?? null,
        },
      })
      .catch((err) =>
        this.logger.warn({
          message: 'Failed to record tip analytics',
          requestId,
          confessionId,
          txHash: dto.txId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    this.analyticsEventService
      ?.record({
        eventName: 'stellar_tx_confirmed',
        txHash: dto.txId,
        assetCode: 'XLM',
        amountAtomic,
        network,
        idempotencyKey: `stellar_tx_confirmed:${dto.txId}`,
        metadata: { source: 'tipping_service', requestId: requestId ?? null },
      })
      .catch((err) =>
        this.logger.warn({
          message: 'Failed to record Stellar confirmation analytics',
          requestId,
          txHash: dto.txId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );

    // ── Post-success side-effects (emitted exactly once) ───────────────

    // Domain event for downstream listeners
    this.eventEmitter.emit('tip.verified', {
      tipId: savedTip.id,
      confessionId,
      txId: dto.txId,
      amount: processedData.amount,
      requestId,
    });

    // Audit log — one settlement event per unique (confession, tx) pair.
    // Because only the first-writer reaches this code path, concurrent
    // duplicates never emit a second event.
    await this.auditLogService.log({
      actionType: AuditActionType.TIP_SETTLEMENT_VERIFIED,
      metadata: {
        entityType: 'tip',
        entityId: savedTip.id,
        tipId: savedTip.id,
        confessionId,
        txId: dto.txId,
        amount: processedData.amount,
        idempotencyKey,
        requestId: requestId ?? null,
        settledAt: savedTip.verifiedAt?.toISOString(),
      },
      context: {
        actor: { type: 'system', id: 'tipping-service' },
        requestId,
      },
    });

    this.logger.log({
      message: 'Tip verify succeeded',
      requestId,
      confessionId,
      txHash: dto.txId,
      tipId: savedTip.id,
      amount: processedData.amount,
      isNew: true,
    });

    return { tip: savedTip, isNew: true, isIdempotent: false, state: 'verified' };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generate idempotency key: SHA256(confessionId:txHash).
   * Deterministic — same inputs always produce the same key.
   */
  private generateIdempotencyKey(confessionId: string, txHash: string): string {
    return crypto
      .createHash('sha256')
      .update(`${confessionId}:${txHash}`)
      .digest('hex');
  }

  private getAnalyticsNetwork(): AnalyticsNetwork {
    return this.configService?.get<string>('STELLAR_NETWORK') === 'mainnet'
      ? 'mainnet'
      : 'testnet';
  }

  private async findTipByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Tip | null> {
    return this.tipRepository.findOne({ where: { idempotencyKey } });
  }

  /**
   * Given an existing tip row that matches the (confession, tx) idempotency
   * key, decide the safe, typed outcome to hand back to the caller. This is
   * the single place that maps a replayed row's *real* status onto a typed
   * response — earlier code returned a blanket success for any matching row,
   * which could mask a stale, rejected, or conflicted tip as "verified".
   * Issue #1687.
   */
  private resolveIdempotentOutcome(tip: Tip): TipVerificationResult {
    switch (tip.verificationStatus) {
      case TipVerificationStatus.VERIFIED:
        return { tip, isNew: false, isIdempotent: true, state: 'duplicate' };

      case TipVerificationStatus.PENDING:
        throw new ConflictException({
          message: `Transaction ${tip.txId} is currently being processed. Please retry in a moment.`,
          state: 'pending' as TipResponseState,
          conflictReason: 'ALREADY_PROCESSING',
          canRetry: true,
        });

      case TipVerificationStatus.STALE_PENDING:
        throw new ConflictException({
          message: `Transaction ${tip.txId} verification has exceeded the expected processing time and is under review. It has not failed — check back shortly or contact support with this reference.`,
          state: 'stale' as TipResponseState,
          conflictReason: 'ALREADY_PROCESSING',
          canRetry: true,
        });

      case TipVerificationStatus.REJECTED:
        throw new BadRequestException({
          message: `Transaction ${tip.txId} could not be verified for this confession.`,
          state: 'failed' as TipResponseState,
          canRetry: false,
        });

      case TipVerificationStatus.CONFLICT:
      default:
        throw new ConflictException({
          message: `Transaction ${tip.txId} could not be processed due to a conflicting prior record.`,
          state: 'conflict' as TipResponseState,
          conflictReason: 'DIFFERENT_CONFESSION',
          canRetry: false,
        });
    }
  }

  /**
   * Atomically insert a PENDING sentinel tip row.
   *
   * The UNIQUE constraint on `idempotency_key` ensures exactly one caller
   * wins the race; all others receive PG error 23505 and are directed to
   * the idempotent-replay path.
   *
   * Returns:
   *  - `isFirstWriter: true`  → this caller created the row, proceed with work.
   *  - `isFirstWriter: false` → another caller already holds the key, replay.
   */
  private async tryInsertSentinelTip(
    confessionId: string,
    txId: string,
    idempotencyKey: string,
  ): Promise<{ isFirstWriter: boolean; sentinelTip: Tip }> {
    const lockId = crypto.randomBytes(16).toString('hex');
    const now = new Date();

    try {
      const sentinel = this.tipRepository.create({
        confessionId,
        txId,
        idempotencyKey,
        amount: 0, // placeholder; overwritten on finalise
        verificationStatus: TipVerificationStatus.PENDING,
        processingLock: lockId,
        lockedAt: now,
        lockedBy: 'verify',
        retryCount: 0,
        lastCheckedAt: now,
      });

      const saved = await this.tipRepository.save(sentinel);
      return { isFirstWriter: true, sentinelTip: saved };
    } catch (err: any) {
      // PG unique_violation — another process owns this idempotency key.
      if (
        err instanceof QueryFailedError &&
        (err as any).code === PG_UNIQUE_VIOLATION
      ) {
        // Return a dummy sentinel; the caller will re-read the real row.
        const dummy = new Tip();
        dummy.idempotencyKey = idempotencyKey;
        return { isFirstWriter: false, sentinelTip: dummy };
      }
      throw err;
    }
  }

  /**
   * Release the processing lock on a tip row identified by its PK.
   * Uses the row ID (not txId) to avoid a table scan.
   */
  private async releaseProcessingLock(tipId: string): Promise<void> {
    await this.tipRepository.update(tipId, {
      processingLock: null,
      lockedAt: null,
      lockedBy: null,
    });
  }

  /**
   * Persist retry/chain metadata for a pending tip identified by its PK.
   * Issue #777: Persist retry metadata for debugging and reconciliation.
   */
  private async updateRetryMetadata(
    tipId: string,
    chainStatus: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.tipRepository
      .createQueryBuilder()
      .update(Tip)
      .set({
        lastChainStatus: chainStatus,
        lastCheckedAt: new Date(),
        reconciliationMetadata: metadata ?? {},
      })
      .where('id = :tipId', { tipId })
      .execute();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Horizon helpers (unchanged)
  // ──────────────────────────────────────────────────────────────────────────

  private async fetchTransactionData(txId: string): Promise<any> {
    const horizonUrl = this.stellarService.getHorizonTxUrl(txId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await fetch(horizonUrl, { signal: controller.signal });
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new GatewayTimeoutException('Horizon request timed out');
      }
      throw new GatewayTimeoutException(
        `Network error fetching transaction: ${error.message}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 404) {
      throw new NotFoundException('Transaction not found on Stellar network');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn({ event: 'horizon_error', txId, status: response.status, body });
      throw new BadRequestException(
        `Horizon returned status ${response.status}`,
      );
    }

    return response.json();
  }

  private async processTransactionData(
    txData: any,
    txId: string,
  ): Promise<ProcessedTransactionData> {
    try {
      const operations = txData._embedded?.operations ?? [];
      const paymentOps = operations.filter(
        (op: any) => op.type === 'payment' && op.asset_type === 'native',
      );

      if (!paymentOps || paymentOps.length === 0) {
        throw new BadRequestException(
          'Transaction does not contain XLM payment',
        );
      }

      const paymentOp = paymentOps[0];
      const amount = parseFloat(paymentOp.amount);
      const receiptMetadata = this.extractSettlementReceiptMetadata(txData);
      const senderAddress = receiptMetadata.anonymousSender
        ? null
        : paymentOp.from ?? null;

      return { amount, senderAddress, receiptMetadata };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        `Failed to process tip transaction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }