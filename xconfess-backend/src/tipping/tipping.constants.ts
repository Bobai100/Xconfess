/**
 * Tip amount bounds. Keep in sync with the anonymous tipping contract and the
 * frontend tip form.
 */
export const MIN_TIP_AMOUNT = 0.1;
export const MAX_TIP_AMOUNT = 10_000;
export const TIP_PRECISION = 7;

/**
 * Ledger finality states for a user-visible transaction.
 *
 * A submitted transaction is NOT equivalent to a transaction included and
 * finalized on the expected network. These states model the full lifecycle so
 * that only verified transitions are exposed to users.
 *
 * - `accepted`:  The transaction was accepted by an RPC node (submitted), but
 *                has not yet been observed in a ledger. Not final.
 * - `included`:  The transaction was observed in a ledger, but has not yet
 *                reached the required confirmation depth. Not final.
 * - `finalized`: The transaction reached the required confirmation depth on
 *                the expected network. Final and user-visible as success.
 * - `failed`:    The transaction was included but failed on-chain, or was
 *                definitively rejected. Final and user-visible as failure.
 * - `unknown`:   The current state cannot be verified (e.g. RPC unavailable,
 *                conflicting observations, or a hash we cannot reconcile).
 *                Never treated as success or failure.
 */
export const FINALITY_STATES = {
  ACCEPTED: 'accepted',
  INCLUDED: 'included',
  FINALIZED: 'finalized',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
} as const;

export type FinalityState = (typeof FINALITY_STATES)[keyof typeof FINALITY_STATES];

/**
 * All finality states as an ordered array (lifecycle order). Useful for
 * validation and for tests that iterate over every state.
 */
export const FINALITY_STATE_VALUES: readonly FinalityState[] = [
  FINALITY_STATES.ACCEPTED,
  FINALITY_STATES.INCLUDED,
  FINALITY_STATES.FINALIZED,
  FINALITY_STATES.FAILED,
  FINALITY_STATES.UNKNOWN,
];

/**
 * States that represent a terminal, user-visible outcome. Once a transaction
 * reaches one of these states it must not silently transition again.
 */
export const TERMINAL_FINALITY_STATES: readonly FinalityState[] = [
  FINALITY_STATES.FINALIZED,
  FINALITY_STATES.FAILED,
];

/**
 * Allowed forward transitions between finality states. Any transition not
 * listed here is rejected by the finality service so that only verified
 * transitions are exposed. `unknown` may be entered from any non-terminal
 * state (e.g. conflicting RPC observations) and may recover back to a
 * verifiable state.
 */
export const ALLOWED_FINALITY_TRANSITIONS: Readonly<
  Record<FinalityState, readonly FinalityState[]>
> = {
  [FINALITY_STATES.ACCEPTED]: [
    FINALITY_STATES.INCLUDED,
    FINALITY_STATES.FAILED,
    FINALITY_STATES.UNKNOWN,
  ],
  [FINALITY_STATES.INCLUDED]: [
    FINALITY_STATES.FINALIZED,
    FINALITY_STATES.FAILED,
    FINALITY_STATES.UNKNOWN,
  ],
  [FINALITY_STATES.FINALIZED]: [],
  [FINALITY_STATES.FAILED]: [],
  [FINALITY_STATES.UNKNOWN]: [
    FINALITY_STATES.ACCEPTED,
    FINALITY_STATES.INCLUDED,
    FINALITY_STATES.FINALIZED,
    FINALITY_STATES.FAILED,
  ],
};

/**
 * Number of ledger confirmations required before a transaction is considered
 * finalized. Overridable via configuration where the owning service supports
 * it; this is the shared default.
 */
export const REQUIRED_CONFIRMATIONS = 1;

/**
 * Maximum number of reconciliation attempts for a transaction whose state
 * cannot be verified (e.g. delayed or conflicting RPC observations). After
 * this bound is exhausted the transaction remains `unknown` and is surfaced
 * for operator review rather than being guessed.
 */
export const MAX_RECONCILIATION_ATTEMPTS = 5;

/**
 * Base delay (ms) between reconciliation attempts. Services should apply
 * bounded backoff on top of this value.
 */
export const RECONCILIATION_BACKOFF_MS = 2_000;

/**
 * Upper bound (ms) for a single reconciliation attempt, including all RPC
 * calls made while verifying a transaction's finality.
 */
export const RECONCILIATION_TIMEOUT_MS = 15_000;

/**
 * Timeout (ms) for a single compensating action when recovering from a
 * partially completed multi-contract operation. If compensation does not
 * complete within this bound the operation is marked for reconciliation
 * instead of being retried indefinitely.
 */
export const COMPENSATION_TIMEOUT_MS = 30_000;

/**
 * Maximum number of bounded recovery attempts for a partial multi-contract
 * operation before it is escalated for manual reconciliation.
 */
export const MAX_COMPENSATION_ATTEMPTS = 3;

/**
 * Maximum number of replacement hashes (fee bumps) that may be linked to a
 * single logical transaction. Guards against unbounded lineage growth.
 */
export const MAX_FEE_BUMP_REPLACEMENTS = 10;