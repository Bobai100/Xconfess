// src/types/stellar.types.ts
// Placeholder for custom Stellar types (extend as needed)

import { createHash } from 'crypto';

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
 * User-visible finality states for a submitted Stellar transaction.
 *
 * A submitted transaction is NOT equivalent to a transaction that has been
 * included and finalized on the expected network. These states model the
 * verified lifecycle transitions observed from RPC responses.
 *
 * - ACCEPTED:  The transaction was accepted by the network (submitted / in mempool).
 * - INCLUDED:  The transaction was observed in a ledger (inclusion, not yet final).
 * - FINALIZED: The transaction is included in a finalized ledger and cannot be reverted.
 * - FAILED:    The transaction failed (rejected, errored, or dropped) and will not finalize.
 * - UNKNOWN:   The current state cannot be verified (e.g. RPC unavailable or conflicting observations).
 */
export enum TransactionFinality {
  ACCEPTED = 'ACCEPTED',
  INCLUDED = 'INCLUDED',
  FINALIZED = 'FINALIZED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Evidence attached to a finality observation, used for auditing and for
 * resolving conflicting RPC observations.
 */
export interface TransactionFinalityEvidence {
  /** Source of the observation, e.g. an RPC endpoint identifier. */
  source?: string;
  /** Raw status string returned by the RPC, if any. */
  rawStatus?: string;
  /** Ledger hash associated with the observation, if any. */
  ledgerHash?: string;
  /** Whether the transaction was successful on-chain (only meaningful once included). */
  successful?: boolean;
  /** Free-form additional details for diagnostics. */
  details?: Record<string, unknown>;
}

/**
 * A recorded finality observation for a user-visible transaction.
 */
export interface TransactionFinalityRecord {
  /** The on-chain transaction hash. */
  txHash: string;
  /** A caller-supplied logical transaction identifier (e.g. an internal id). */
  logicalTxId: string;
  /** The verified finality state. */
  state: TransactionFinality;
  /** The ledger sequence in which the transaction was included, if known. */
  ledger?: number;
  /** When this observation was made. */
  observedAt: Date;
  /** Supporting evidence for the observation. */
  evidence?: TransactionFinalityEvidence;
}

/**
 * Terminal states from which no further verified promotion is possible.
 */
const TERMINAL_STATES: ReadonlySet<TransactionFinality> = new Set([
  TransactionFinality.FINALIZED,
  TransactionFinality.FAILED,
]);

/**
 * Allowed verified promotions in the finality lifecycle.
 *
 * Only forward, verified promotions are permitted:
 *   ACCEPTED -> INCLUDED -> FINALIZED
 * Any non-terminal state may transition to FAILED or UNKNOWN.
 *
 * Conflicting transitions (e.g. FINALIZED -> FAILED), downgrades
 * (INCLUDED -> ACCEPTED), and self-transitions are rejected.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TransactionFinality, ReadonlySet<TransactionFinality>>> = {
  [TransactionFinality.ACCEPTED]: new Set([
    TransactionFinality.INCLUDED,
    TransactionFinality.FAILED,
    TransactionFinality.UNKNOWN,
  ]),
  [TransactionFinality.INCLUDED]: new Set([
    TransactionFinality.FINALIZED,
    TransactionFinality.FAILED,
    TransactionFinality.UNKNOWN,
  ]),
  [TransactionFinality.FINALIZED]: new Set([]),
  [TransactionFinality.FAILED]: new Set([]),
  [TransactionFinality.UNKNOWN]: new Set([
    TransactionFinality.ACCEPTED,
    TransactionFinality.INCLUDED,
    TransactionFinality.FINALIZED,
    TransactionFinality.FAILED,
  ]),
};

/**
 * Returns true when `from` may be promoted to `to` under the verified
 * finality state machine. Rejects downgrades, conflicting transitions,
 * self-transitions, and any transition out of a terminal state.
 */
export function canTransition(from: TransactionFinality, to: TransactionFinality): boolean {
  if (from === to) {
    return false;
  }
  if (TERMINAL_STATES.has(from)) {
    return false;
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed !== undefined && allowed.has(to);
}