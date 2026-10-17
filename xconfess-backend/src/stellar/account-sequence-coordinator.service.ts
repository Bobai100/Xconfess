import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AccountSequenceLease } from './entities/account-sequence-lease.entity';

export interface SequenceReservation {
  accountId: string;
  sequence: string;
  leaseId: string;
  expiresAt: Date;
}

export interface ReserveOptions {
  /** Number of sequences to reserve (default 1). */
  count?: number;
  /** Lease TTL in milliseconds. Falls back to config. */
  ttlMs?: number;
  /** Worker/process identifier for observability. */
  workerId?: string;
}

export class SequenceLeaseError extends Error {
  constructor(
    message: string,
    public readonly accountId: string,
    public readonly code:
      | 'LEASE_CONFLICT'
      | 'ACCOUNT_NOT_FOUND'
      | 'INVALID_SEQUENCE'
      | 'LEASE_EXPIRED' = 'LEASE_CONFLICT',
  ) {
    super(message);
    this.name = 'SequenceLeaseError';
  }
}

/**
 * Account-scoped sequence coordinator.
 *
 * Serializes account sequence allocation across transaction workers using a
 * DB-backed lease with TTL. A worker reserves the next sequence(s) for an
 * account, builds and submits its transaction, then releases the lease. If the
 * worker crashes, the lease expires after its TTL and the next worker recovers
 * the account by advancing the sequence past the abandoned reservation.
 *
 * The coordinator is the single owning boundary for sequence allocation:
 * transaction builders MUST route through `reserve` rather than reading the
 * account sequence directly.
 */
@Injectable()
export class AccountSequenceCoordinatorService implements OnModuleDestroy {
  private readonly logger = new Logger(AccountSequenceCoordinatorService.name);
  private readonly defaultTtlMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly instanceId: string;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(AccountSequenceLease)
    private readonly leaseRepo: Repository<AccountSequenceLease>,
    private readonly config: ConfigService,
  ) {
    this.defaultTtlMs = this.config.get<number>(
      'SEQUENCE_LEASE_TTL_MS',
      30_000,
    );
    this.maxRetries = this.config.get<number>('SEQUENCE_LEASE_MAX_RETRIES', 50);
    this.retryDelayMs = this.config.get<number>(
      'SEQUENCE_LEASE_RETRY_DELAY_MS',
      100,
    );
    this.instanceId = `${process.pid}-${randomUUID()}`;

    const cleanupIntervalMs = this.config.get<number>(
      'SEQUENCE_LEASE_CLEANUP_INTERVAL_MS',
      15_000,
    );
    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.expireStaleLeases().catch((err) =>
          this.logger.error(
            `Failed to expire stale sequence leases: ${err?.message ?? err}`,
          ),
        );
      }, cleanupIntervalMs);
      // Do not keep the event loop alive solely for cleanup.
      this.cleanupTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Reserve the next sequence(s) for an account.
   *
   * Acquires an exclusive lease on the account, advances the stored sequence by
   * `count`, and returns the first reserved sequence. The caller is expected to
   * build a transaction using the returned sequence and then call `release`
   * (or `commit`) once submission completes.
   *
   * Throws `SequenceLeaseError` if the lease cannot be acquired within the
   * retry budget.
   */
  async reserve(
    accountId: string,
    options: ReserveOptions = {},
  ): Promise<SequenceReservation> {
    if (!accountId) {
      throw new SequenceLeaseError(
        'accountId is required',
        accountId,
        'ACCOUNT_NOT_FOUND',
      );
    }
    const count = options.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new SequenceLeaseError(
        `Invalid reservation count: ${count}`,
        accountId,
        'INVALID_SEQUENCE',
      );
    }
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new SequenceLeaseError(
        `Invalid lease TTL: ${ttlMs}`,
        accountId,
        'INVALID_SEQUENCE',
      );
    }

    const leaseId = randomUUID();
    const workerId = options.workerId ?? this.instanceId;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const sequence = await this.tryAcquire(
          accountId,
          leaseId,
          workerId,
          count,
          now,
          expiresAt,
        );
        if (sequence !== null) {
          this.logger.debug(
            `Reserved sequence ${sequence} for account ${accountId} ` +
              `(lease ${leaseId}, worker ${workerId}, ttl ${ttlMs}ms)`,
          );
          return { accountId, sequence, leaseId, expiresAt };
        }
      } catch (err) {
        lastError = err;
        // Non-retryable errors bubble up immediately.
        if (err instanceof SequenceLeaseError) {
          throw err;
        }
        this.logger.warn(
          `Sequence reservation attempt ${attempt + 1} failed for ` +
            `${accountId}: ${(err as Error)?.message ?? err}`,
        );
      }

      await this.sleep(this.retryDelayMs * Math.min(attempt + 1, 10));
    }

    throw new SequenceLeaseError(
      `Could not acquire sequence lease for account ${accountId} after ` +
        `${this.maxRetries} attempts` +
        (lastError ? `: ${(lastError as Error)?.message ?? lastError}` : ''),
      accountId,
      'LEASE_CONFLICT',
    );
  }

  /**
   * Attempt a single atomic acquisition. Returns the reserved sequence on
   * success, or `null` if the lease is currently held by another worker.
   */
  private async tryAcquire(
    accountId: string,
    leaseId: string,
    workerId: string,
    count: number,
    now: Date,
    expiresAt: Date,
  ): Promise<string | null> {
    return this.leaseRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AccountSequenceLease);

      // Lock the account row for the duration of the transaction so concurrent
      // workers serialize on the same account.
      const existing = await repo
        .createQueryBuilder('lease')
        .setLock('pessimistic_write')
        .where('lease.accountId = :accountId', { accountId })
        .getOne();

      if (!existing) {
        throw new SequenceLeaseError(
          `No sequence record for account ${accountId}`,
          accountId,
          'ACCOUNT_NOT_FOUND',
        );
      }

      const leaseActive =
        existing.leaseId !== null &&
        existing.leaseExpiresAt !== null &&
        existing.leaseExpiresAt.getTime() > now.getTime();

      if (leaseActive) {
        // Held by another worker; caller will retry.
        return null;
      }

      const current = BigInt(existing.sequence);
      const next = current + BigInt(count);
      const reserved = current.toString();

      existing.sequence = next.toString();
      existing.leaseId = leaseId;
      existing.leaseExpiresAt = expiresAt;
      existing.leaseOwner = workerId;
      existing.leaseAcquiredAt = now;
      existing.updatedAt = now;

      await repo.save(existing);
      return reserved;
    });
  }

  /**
   * Release a lease after successful submission. The sequence has already been
   * advanced, so releasing simply frees the account for the next worker.
   */
  async release(accountId: string, leaseId: string): Promise<void> {
    await this.leaseRepo
      .createQueryBuilder()
      .update(AccountSequenceLease)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        updatedAt: new Date(),
      })
      .where('accountId = :accountId AND leaseId = :leaseId', {
        accountId,
        leaseId,
      })
      .execute();
  }

  /**
   * Commit a reservation. Alias for `release` that documents intent: the
   * sequence was consumed by a successfully submitted transaction.
   */
  async commit(accountId: string, leaseId: string): Promise<void> {
    await this.release(accountId, leaseId);
  }

  /**
   * Abandon a reservation after a failed submission. The sequence is NOT
   * rolled back (Stellar sequences are monotonic and cannot be reused once a
   * transaction may have been broadcast), but the lease is released so other
   * workers can proceed.
   */
  async abandon(accountId: string, leaseId: string): Promise<void> {
    this.logger.warn(
      `Abandoning sequence lease ${leaseId} for account ${accountId}; ` +
        `sequence remains advanced to avoid reuse`,
    );
    await this.release(accountId, leaseId);
  }

  /**
   * Expire stale leases whose TTL has elapsed. Called periodically and safe to
   * invoke concurrently from multiple processes.
   */
  async expireStaleLeases(): Promise<number> {
    const now = new Date();
    const result = await this.leaseRepo
      .createQueryBuilder()
      .update(AccountSequenceLease)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        updatedAt: now,
      })
      .where('leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= :now', { now })
      .execute();

    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(`Expired ${affected} stale sequence lease(s)`);
    }
    return affected;
  }

  /**
   * Read the current (next available) sequence for an account without
   * reserving it. Intended for diagnostics and tests only.
   */
  async peekSequence(accountId: string): Promise<string | null> {
    const record = await this.leaseRepo.findOne({ where: { accountId } });
    return record ? record.sequence : null;
  }

  /**
   * Ensure an account has a sequence record. Used during account bootstrap.
   * Idempotent: existing records are left untouched.
   */
  async ensureAccount(
    accountId: string,
    initialSequence: string,
  ): Promise<void> {
    const existing = await this.leaseRepo.findOne({ where: { accountId } });
    if (existing) {
      return;
    }
    try {
      await this.leaseRepo.insert({
        accountId,
        sequence: initialSequence,
        leaseId: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        updatedAt: new Date(),
      });
    } catch (err) {
      // Handle concurrent insert race: another worker created it first.
      const again = await this.leaseRepo.findOne({ where: { accountId } });
      if (!again) {
        throw err;
      }
    }
  }

  /**
   * Recover accounts whose leases expired while a worker was mid-flight.
   * Advances the stored sequence past any abandoned reservation so the next
   * worker does not collide with a transaction that may have been broadcast.
   */
  async recoverExpiredLeases(): Promise<number> {
    const now = new Date();
    const stale = await this.leaseRepo.find({
      where: { leaseExpiresAt: LessThan(now) },
    });
    let recovered = 0;
    for (const record of stale) {
      if (!record.leaseId) {
        continue;
      }
      this.logger.warn(
        `Recovering expired lease ${record.leaseId} for account ` +
          `${record.accountId} (owner ${record.leaseOwner ?? 'unknown'})`,
      );
      await this.release(record.accountId, record.leaseId);
      recovered++;
    }
    return recovered;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}