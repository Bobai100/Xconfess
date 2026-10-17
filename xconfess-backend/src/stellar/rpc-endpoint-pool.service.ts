import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Horizon,
  SorobanRpc,
  Transaction,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';

/**
 * Health status of a single RPC endpoint.
 */
export type EndpointHealth = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Internal record tracking the state of a single RPC endpoint.
 */
export interface EndpointState {
  /** The endpoint URL. */
  url: string;
  /** Current health classification. */
  health: EndpointHealth;
  /** Consecutive failure count since last success. */
  consecutiveFailures: number;
  /** Timestamp (ms) until which the endpoint is in cooldown. */
  cooldownUntil: number;
  /** Timestamp (ms) of the last successful call. */
  lastSuccessAt: number;
  /** Timestamp (ms) of the last failure. */
  lastFailureAt: number;
  /** Total successful calls. */
  successCount: number;
  /** Total failed calls. */
  failureCount: number;
}

/**
 * Options controlling retry and failover behavior.
 */
export interface FailoverOptions {
  /**
   * Maximum number of attempts across all endpoints.
   * Defaults to the number of configured endpoints (bounded).
   */
  maxAttempts?: number;
  /**
   * Base delay (ms) for exponential backoff between attempts.
   * Defaults to 100ms.
   */
  baseDelayMs?: number;
  /**
   * Maximum delay (ms) for exponential backoff.
   * Defaults to 2000ms.
   */
  maxDelayMs?: number;
  /**
   * Whether this operation is a read (safe to retry freely) or a submit
   * (must guard against duplicate submission).
   */
  kind: 'read' | 'submit';
  /**
   * Idempotency key for submit operations. Required for submits so that
   * retries can be deduplicated.
   */
  idempotencyKey?: string;
}

/**
 * Result of a submit operation, used to decide whether a retry is safe.
 */
export interface SubmitOutcome {
  /** Whether the transaction was accepted by the network. */
  accepted: boolean;
  /** The transaction hash, if known. */
  hash?: string;
  /** The raw response from the RPC endpoint. */
  response?: SorobanRpc.Api.SendTransactionResponse;
}

/**
 * Error thrown when all endpoints are exhausted or unavailable.
 */
export class RpcEndpointPoolExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError?: unknown,
  ) {
    super(message);
    this.name = 'RpcEndpointPoolExhaustedError';
  }
}

/**
 * Error thrown when a submit is rejected because a duplicate submission
 * was detected for the same idempotency key.
 */
export class DuplicateSubmissionError extends Error {
  constructor(
    message: string,
    public readonly idempotencyKey: string,
    public readonly existingHash?: string,
  ) {
    super(message);
    this.name = 'DuplicateSubmissionError';
  }
}

/**
 * Health-aware Stellar RPC endpoint pool.
 *
 * Responsibilities:
 *  - Track per-endpoint health and apply cooldowns after failures.
 *  - Perform bounded retries with exponential backoff across endpoints.
 *  - Distinguish read vs submit safety: reads may be retried freely, while
 *    submits must be guarded against duplicate submission using idempotency
 *    keys and status checks.
 *
 * Configuration (via ConfigService):
 *  - `STELLAR_RPC_URLS` (comma-separated list of endpoint URLs)
 *  - `STELLAR_RPC_FAILURE_THRESHOLD` (default 3)
 *  - `STELLAR_RPC_COOLDOWN_MS` (default 30000)
 *  - `STELLAR_RPC_MAX_ATTEMPTS` (default = number of endpoints)
 *  - `STELLAR_RPC_BASE_DELAY_MS` (default 100)
 *  - `STELLAR_RPC_MAX_DELAY_MS` (default 2000)
 */
@Injectable()
export class RpcEndpointPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(RpcEndpointPoolService.name);
  private readonly endpoints: EndpointState[] = [];
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  /**
   * In-memory record of submitted transactions by idempotency key.
   * Prevents duplicate submission when the pool fails over between endpoints.
   */
  private readonly submittedByKey = new Map<
    string,
    { hash?: string; accepted: boolean; at: number }
  >();

  /** Round-robin cursor for load distribution across healthy endpoints. */
  private cursor = 0;

  /** Timers used for cooldown expiry cleanup (optional). */
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly config: ConfigService) {
    const rawUrls =
      this.config.get<string>('STELLAR_RPC_URLS') ??
      this.config.get<string>('STELLAR_RPC_URL') ??
      '';
    const urls = rawUrls
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urls.length === 0) {
      this.logger.warn(
        'No Stellar RPC endpoints configured (STELLAR_RPC_URLS). Pool will be empty.',
      );
    }

    this.failureThreshold = this.readInt('STELLAR_RPC_FAILURE_THRESHOLD', 3);
    this.cooldownMs = this.readInt('STELLAR_RPC_COOLDOWN_MS', 30_000);
    this.defaultMaxAttempts = this.readInt(
      'STELLAR_RPC_MAX_ATTEMPTS',
      Math.max(urls.length, 1),
    );
    this.baseDelayMs = this.readInt('STELLAR_RPC_BASE_DELAY_MS', 100);
    this.maxDelayMs = this.readInt('STELLAR_RPC_MAX_DELAY_MS', 2000);

    for (const url of urls) {
      this.endpoints.push({
        url,
        health: 'healthy',
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
        successCount: 0,
        failureCount: 0,
      });
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  /**
   * Returns a snapshot of the current endpoint health states.
   */
  getHealthSnapshot(): ReadonlyArray<Readonly<EndpointState>> {
    return this.endpoints.map((e) => ({ ...e }));
  }

  /**
   * Creates a Soroban RPC server for a given endpoint URL.
   * Exposed for testability.
   */
  protected createServer(url: string): SorobanRpc.Server {
    return new SorobanRpc.Server(url, { allowHttp: url.startsWith('http://') });
  }

  /**
   * Creates a Horizon server for a given endpoint URL.
   * Exposed for testability.
   */
  protected createHorizon(url: string): Horizon.Server {
    return new Horizon.Server(url, {
      allowHttp: url.startsWith('http://'),
    });
  }

  /**
   * Executes a read operation against the pool with failover.
   *
   * Reads are safe to retry freely across endpoints.
   */
  async read<T>(
    operation: (server: SorobanRpc.Server, url: string) => Promise<T>,
    options?: Partial<Omit<FailoverOptions, 'kind' | 'idempotencyKey'>>,
  ): Promise<T> {
    return this.executeWithFailover(operation, {
      kind: 'read',
      ...options,
    });
  }

  /**
   * Executes a submit operation against the pool with failover and
   * duplicate-submission protection.
   *
   * Before retrying a submit on a different endpoint, the pool:
   *  1. Checks the idempotency key cache for a prior accepted submission.
   *  2. Queries the endpoint for the transaction status by hash (if known)
   *     to determine whether the transaction was already accepted.
   *
   * If a duplicate is detected, a {@link DuplicateSubmissionError} is thrown
   * (or the prior outcome is returned) rather than resubmitting.
   */
  async submit(
    transaction: Transaction | FeeBumpTransaction,
    options: Omit<FailoverOptions, 'kind'> & { idempotencyKey: string },
  ): Promise<SubmitOutcome> {
    if (!options.idempotencyKey) {
      throw new Error(
        'idempotencyKey is required for submit operations to prevent duplicate submission',
      );
    }

    const key = options.idempotencyKey;
    const cached = this.submittedByKey.get(key);
    if (cached && cached.accepted) {
      this.logger.debug(
        `Submit for idempotency key ${key} already accepted (hash=${cached.hash}); skipping.`,
      );
      return { accepted: true, hash: cached.hash };
    }

    const hash = this.safeHash(transaction);

    return this.executeWithFailover<SubmitOutcome>(
      async (server, url) => {
        // Before submitting on a new endpoint, check whether the transaction
        // was already accepted (e.g., a previous attempt succeeded but the
        // response was lost).
        if (hash) {
          const alreadyAccepted = await this.checkTransactionStatus(
            server,
            hash,
          );
          if (alreadyAccepted) {
            this.logger.debug(
              `Transaction ${hash} already accepted on ${url}; not resubmitting.`,
            );
            return { accepted: true, hash };
          }
        }

        const response = await server.sendTransaction(transaction);
        const accepted =
          response.status === 'PENDING' ||
          response.status === 'DUPLICATE' ||
          response.status === 'TRY_AGAIN_LATER' === false
            ? response.status !== 'ERROR'
            : false;

        // Treat DUPLICATE as accepted (already submitted).
        const isAccepted =
          response.status === 'PENDING' || response.status === 'DUPLICATE';

        if (isAccepted) {
          this.submittedByKey.set(key, {
            hash: response.hash ?? hash,
            accepted: true,
            at: Date.now(),
          });
        }

        return {
          accepted: isAccepted,
          hash: response.hash ?? hash,
          response,
        };
      },
      {
        kind: 'submit',
        idempotencyKey: key,
        maxAttempts: options.maxAttempts,
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
      },
    );
  }

  /**
   * Core failover loop. Selects healthy endpoints, applies cooldowns,
   * performs bounded retries with exponential backoff, and records
   * success/failure per endpoint.
   */
  private async executeWithFailover<T>(
    operation: (server: SorobanRpc.Server, url: string) => Promise<T>,
    options: FailoverOptions,
  ): Promise<T> {
    if (this.endpoints.length === 0) {
      throw new RpcEndpointPoolExhaustedError(
        'No Stellar RPC endpoints configured',
        0,
      );
    }

    const maxAttempts = Math.min(
      options.maxAttempts ?? this.defaultMaxAttempts,
      this.endpoints.length * 2, // bounded: never more than 2x endpoints
    );
    const baseDelay = options.baseDelayMs ?? this.baseDelayMs;
    const maxDelay = options.maxDelayMs ?? this.maxDelayMs;

    let lastError: unknown;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const endpoint = this.selectEndpoint();
      if (!endpoint) {
        // All endpoints in cooldown. Wait for the soonest cooldown to expire
        // (bounded) or fail fast if we've exhausted attempts.
        const waitMs = this.soonestCooldownRemaining();
        if (waitMs > 0 && attempts < maxAttempts - 1) {
          this.logger.warn(
            `All RPC endpoints in cooldown; waiting ${waitMs}ms before retry.`,
          );
          await this.sleep(Math.min(waitMs, maxDelay));
          attempts++;
          continue;
        }
        throw new RpcEndpointPoolExhaustedError(
          'All Stellar RPC endpoints are in cooldown',
          attempts,
          lastError,
        );
      }

      attempts++;
      const server = this.createServer(endpoint.url);

      try {
        const result = await operation(server, endpoint.url);
        this.recordSuccess(endpoint);
        return result;
      } catch (err) {
        lastError = err;
        this.recordFailure(endpoint, err);

        // For submits, if the error indicates the transaction may have been
        // accepted (e.g., timeout after send), check status before retrying.
        if (options.kind === 'submit' && options.idempotencyKey) {
          const cached = this.submittedByKey.get(options.idempotencyKey);
          if (cached?.accepted) {
            return { accepted: true, hash: cached.hash } as unknown as T;
          }
        }

        if (attempts >= maxAttempts) {
          break;
        }

        const delay = Math.min(baseDelay * 2 ** (attempts - 1), maxDelay);
        this.logger.warn(
          `RPC call to ${endpoint.url} failed (attempt ${attempts}/${maxAttempts}): ${
            err instanceof Error ? err.message : String(err)
          }. Retrying in ${delay}ms.`,
        );
        await this.sleep(delay);
      }
    }

    throw new RpcEndpointPoolExhaustedError(
      `All Stellar RPC endpoints failed after ${attempts} attempt(s)`,
      attempts,
      lastError,
    );
  }

  /**
   * Selects the next healthy endpoint using round-robin, skipping endpoints
   * in cooldown. Returns `undefined` if none are available.
   */
  private selectEndpoint(): EndpointState | undefined {
    const now = Date.now();
    const count = this.endpoints.length;

    for (let i = 0; i < count; i++) {
      const idx = (this.cursor + i) % count;
      const endpoint = this.endpoints[idx];
      if (endpoint.cooldownUntil <= now) {
        this.cursor = (idx + 1) % count;
        return endpoint;
      }
    }
    return undefined;
  }

  /**
   * Returns the remaining cooldown (ms) of the endpoint that will recover
   * soonest. Returns 0 if any endpoint is available.
   */
  private soonestCooldownRemaining(): number {
    const now = Date.now();
    let soonest = Infinity;
    for (const endpoint of this.endpoints) {
      const remaining = endpoint.cooldownUntil - now;
      if (remaining <= 0) {
        return 0;
      }
      if (remaining < soonest) {
        soonest = remaining;
      }
    }
    return soonest === Infinity ? 0 : soonest;
  }

  /**
   * Records a successful call and resets failure state.
   */
  private recordSuccess(endpoint: EndpointState): void {
    endpoint.consecutiveFailures = 0;
    endpoint.health = 'healthy';
    endpoint.cooldownUntil = 0;
    endpoint.lastSuccessAt = Date.now();
    endpoint.successCount++;
  }

  /**
   * Records a failed call and applies cooldown once the failure threshold
   * is reached.
   */
  private recordFailure(endpoint: EndpointState, err: unknown): void {
    endpoint.consecutiveFailures++;
    endpoint.failureCount++;
    endpoint.lastFailureAt = Date.now();

    if (endpoint.consecutiveFailures >= this.failureThreshold) {
      endpoint.health = 'unhealthy';
      endpoint.cooldownUntil = Date.now() + this.cooldownMs;
      this.logger.warn(
        `RPC endpoint ${endpoint.url} marked unhealthy after ${endpoint.consecutiveFailures} consecutive failures; cooling down for ${this.cooldownMs}ms.`,
      );
    } else {
      endpoint.health = 'degraded';
    }

    this.logger.debug(
      `RPC endpoint ${endpoint.url} failure: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  /**
   * Checks whether a transaction has already been accepted by the network.
   * Returns true if the transaction is found and successful.
   */
  private async checkTransactionStatus(
    server: SorobanRpc.Server,
    hash: string,
  ): Promise<boolean> {
    try {
      const response = await server.getTransaction(hash);
      if (response.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return true;
      }
      // NOT_FOUND means the transaction was never accepted; safe to retry.
      // FAILED means it was accepted but failed; do not resubmit.
      if (response.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return true;
      }
      return false;
    } catch (err) {
      // If status check fails, be conservative and allow the retry only if
      // the error is a NOT_FOUND-style error. Otherwise, treat as unknown
      // and do not block (the idempotency cache still guards duplicates).
      this.logger.debug(
        `Status check for ${hash} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Safely extracts the transaction hash, if available.
   */
  private safeHash(
    transaction: Transaction | FeeBumpTransaction,
  ): string | undefined {
    try {
      return transaction.hash().toString('hex');
    } catch {
      return undefined;
    }
  }

  private readInt(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const parsed = typeof raw === 'number' ? raw : parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }
}