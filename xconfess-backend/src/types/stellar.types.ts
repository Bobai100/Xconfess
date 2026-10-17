// src/types/stellar.types.ts
// Placeholder for custom Stellar types (extend as needed)

export type StellarPublicKey = string;
export type StellarSecret = string;
export type SorobanContractId = string;

/**
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