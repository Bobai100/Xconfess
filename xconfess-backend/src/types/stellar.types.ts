// src/types/stellar.types.ts
// Placeholder for custom Stellar types (extend as needed)

export type StellarPublicKey = string;
export type StellarSecret = string;
export type SorobanContractId = string;

/**
 * Health state of a configured Stellar RPC endpoint.
 *
 * - `healthy`: endpoint is usable for reads and submissions.
 * - `degraded`: endpoint recently failed or was slow; usable for reads only
 *   until it recovers (submit safety is restricted).
 * - `unhealthy`: endpoint is in cooldown and must not be used.
 */
export type StellarRpcEndpointHealthState = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Snapshot of a single RPC endpoint's health, maintained by the failover
 * manager. Consumers should treat this as read-only.
 */
export interface StellarRpcEndpointHealth {
  /** Configured endpoint URL. */
  url: string;
  /** Current health state. */
  state: StellarRpcEndpointHealthState;
  /** Consecutive failures observed since last success. */
  consecutiveFailures: number;
  /** Epoch millis of the last successful call, if any. */
  lastSuccessAt?: number;
  /** Epoch millis of the last failure, if any. */
  lastFailureAt?: number;
  /** Epoch millis until which the endpoint is in cooldown (unhealthy). */
  cooldownUntil?: number;
  /** Last observed latency in milliseconds, if any. */
  lastLatencyMs?: number;
}

/**
 * Retry policy applied by the failover manager when an endpoint fails.
 * Retries are bounded: at most `maxAttempts` total attempts across the
 * configured endpoint list, with exponential backoff capped at `maxBackoffMs`.
 */
export interface StellarRpcRetryPolicy {
  /** Maximum total attempts (including the first) across all endpoints. */
  maxAttempts: number;
  /** Base backoff delay in milliseconds. */
  baseBackoffMs: number;
  /** Maximum backoff delay in milliseconds. */
  maxBackoffMs: number;
  /** Per-attempt timeout in milliseconds. */
  attemptTimeoutMs: number;
  /** Cooldown applied to an endpoint after it is marked unhealthy. */
  cooldownMs: number;
  /** Consecutive failures required before an endpoint is marked unhealthy. */
  failureThreshold: number;
}

/**
 * Idempotency record used to prevent duplicate transaction submission when
 * the active endpoint changes mid-flight (failover) or a submit is retried.
 *
 * Keyed by a deterministic idempotency key derived from the transaction
 * envelope (e.g. source account + sequence + hash).
 */
export interface StellarSubmitIdempotencyRecord {
  /** Deterministic idempotency key for the submission. */
  key: string;
  /** Transaction hash (hex) once known. */
  transactionHash?: string;
  /** Source account public key. */
  sourceAccount: StellarPublicKey;
  /** Sequence number used by the transaction. */
  sequence: string;
  /** Current submission status. */
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  /** Endpoint URL that last handled the submission. */
  lastEndpoint?: string;
  /** Epoch millis when the record was created. */
  createdAt: number;
  /** Epoch millis when the record was last updated. */
  updatedAt: number;
  /** Epoch millis after which a pending record may be reclaimed. */
  expiresAt: number;
  /** Optional last error message for diagnostics. */
  lastError?: string;
}

/**
 * Result of a failover-aware RPC operation.
 */
export interface StellarRpcOperationResult<T> {
  /** Whether the operation succeeded. */
  ok: boolean;
  /** Result value when `ok` is true. */
  value?: T;
  /** Endpoint URL that produced the result. */
  endpoint?: string;
  /** Number of attempts made across endpoints. */
  attempts: number;
  /** Error message when `ok` is false. */
  error?: string;
}