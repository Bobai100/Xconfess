// src/types/stellar.types.ts
// Placeholder for custom Stellar types (extend as needed)

import { createHash } from 'crypto';

export type StellarPublicKey = string;
export type StellarSecret = string;
export type SorobanContractId = string;

/**
 * Canonical network identifiers used to bind simulation results to a network.
 * A simulation produced on one network must never be submitted to another.
 */
export type StellarNetwork = 'public' | 'testnet' | 'futurenet' | 'standalone' | (string & {});

/**
 * Inputs that uniquely identify a contract invocation. The operation hash is
 * derived from these so a simulation envelope can be bound to the exact
 * operation it was produced for.
 */
export interface SimulationOperationInputs {
  /** Network the invocation targets (e.g. "testnet"). */
  network: StellarNetwork;
  /** Contract being invoked. */
  contractId: SorobanContractId;
  /** Contract method / function name. */
  method: string;
  /** Serialized invocation arguments (must be deterministic). */
  args?: unknown;
  /** Optional source account the invocation is authorized from. */
  sourceAccount?: StellarPublicKey;
  /** Optional fee / resource parameters that affect the simulation. */
  fee?: string | number;
  /** Optional memo or other operation-level metadata. */
  memo?: string;
}

/**
 * Envelope describing a successful simulation result together with the state
 * it was produced against. Consumers must validate freshness (ledger sequence
 * and timestamp) and binding (network, contractId, operationHash) before
 * submitting the corresponding transaction.
 */
export interface SimulationResult {
  /** Network the simulation was produced on. */
  network: StellarNetwork;
  /** Contract the simulation targeted. */
  contractId: SorobanContractId;
  /** Hash binding the simulation to the exact operation inputs. */
  operationHash: string;
  /** Ledger sequence the simulation was evaluated against. */
  ledgerSequence: number;
  /** Wall-clock time (ms since epoch) the simulation was produced. */
  timestamp: number;
  /** Optional raw simulation payload (footprint, results, etc.). */
  result?: unknown;
}

/**
 * Error raised when a simulation result can no longer be safely submitted
 * because the underlying ledger state has aged or changed, or because the
 * envelope does not match the operation being submitted.
 */
export class StaleSimulationError extends Error {
  /** Machine-readable reason code for the rejection. */
  public readonly code: StaleSimulationErrorCode;
  /** Optional details about the expected vs. observed state. */
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: StaleSimulationErrorCode = 'STALE_SIMULATION',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StaleSimulationError';
    this.code = code;
    this.details = details;
    // Restore prototype chain for transpiled targets.
    Object.setPrototypeOf(this, StaleSimulationError.prototype);
  }
}

export type StaleSimulationErrorCode =
  | 'STALE_SIMULATION'
  | 'LEDGER_SEQUENCE_EXPIRED'
  | 'SIMULATION_AGE_EXCEEDED'
  | 'NETWORK_MISMATCH'
  | 'CONTRACT_MISMATCH'
  | 'OPERATION_MISMATCH'
  | 'MISSING_SIMULATION';

/**
 * Deterministically serialize a value so that structurally equal inputs
 * always produce the same string (and therefore the same hash).
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * Compute a deterministic hash binding a simulation to its exact operation
 * inputs. The hash covers the network, contract, method, arguments, source
 * account, fee and memo so that any change to the operation invalidates a
 * previously produced simulation.
 */
export function computeOperationHash(inputs: SimulationOperationInputs): string {
  const canonical = stableStringify({
    network: inputs.network,
    contractId: inputs.contractId,
    method: inputs.method,
    args: inputs.args ?? null,
    sourceAccount: inputs.sourceAccount ?? null,
    fee: inputs.fee ?? null,
    memo: inputs.memo ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}