/**
 * useStellarWallet.ts
 * Issue #194 – Fix React Compiler preservation error & stabilise callback contract
 * Issue #196 – Expose network-mismatch state for callers to gate CTAs
 * Issue #278 – Wallet authorization scope review for contract operations
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type WalletNetwork = "testnet" | "mainnet" | "unknown";

/**
 * Issue #278 – Authorization scope review.
 *
 * Every wallet-connected contract action must declare the exact operation it
 * intends to perform. The hook compares that declared intent against the
 * authorization footprint of the transaction being signed and rejects any
 * unexpected authorization requirement before the wallet is prompted.
 */
export type ContractOperationScope =
  | "anchor:deposit"
  | "anchor:withdraw"
  | "confession:create"
  | "confession:tip";

export interface ContractOperationIntent {
  /** The exact contract operation the user was shown and agreed to. */
  operation: ContractOperationScope;
  /** Contract the operation targets (C... address). */
  contractId: string;
  /** Public key that must authorize the operation. */
  authorizedPublicKey: string;
  /** Optional human-readable summary displayed to the user. */
  summary?: string;
}

export interface AuthorizationScopeReview {
  intent: ContractOperationIntent;
  /** Operations discovered in the transaction envelope. */
  observedOperations: string[];
  /** Public keys the transaction requires signatures from. */
  requiredSigners: string[];
  /** True when observed operations match the declared intent exactly. */
  matchesIntent: boolean;
  /** Reasons the review failed; empty when the review passed. */
  violations: string[];
}

export class AuthorizationScopeError extends Error {
  readonly review: AuthorizationScopeReview;

  constructor(message: string, review: AuthorizationScopeReview) {
    super(message);
    this.name = "AuthorizationScopeError";
    this.review = review;
  }
}

const KNOWN_OPERATION_SCOPES: ReadonlySet<string> = new Set<ContractOperationScope>([
  "anchor:deposit",
  "anchor:withdraw",
  "confession:create",
  "confession:tip",
]);

/**
 * Review the authorization footprint of a transaction against the declared
 * user intent. This is a pure function so it can be unit tested without a
 * wallet and reused by any signing boundary.
 *
 * `observedOperations` and `requiredSigners` are supplied by the caller that
 * decoded the transaction envelope; the review itself never trusts the intent
 * alone.
 */
export function reviewAuthorizationScope(
  intent: ContractOperationIntent,
  observedOperations: readonly string[],
  requiredSigners: readonly string[],
): AuthorizationScopeReview {
  const violations: string[] = [];

  if (!KNOWN_OPERATION_SCOPES.has(intent.operation)) {
    violations.push(`Unknown operation scope: ${String(intent.operation)}`);
  }
  if (!intent.contractId) {
    violations.push("Intent is missing a target contract id.");
  }
  if (!intent.authorizedPublicKey) {
    violations.push("Intent is missing the authorized public key.");
  }

  const uniqueObserved = Array.from(new Set(observedOperations));
  if (uniqueObserved.length !== 1 || uniqueObserved[0] !== intent.operation) {
    violations.push(
      `Transaction operations [${uniqueObserved.join(", ")}] do not match the displayed intent "${intent.operation}".`,
    );
  }

  const uniqueSigners = Array.from(new Set(requiredSigners));
  const unexpectedSigners = uniqueSigners.filter(
    (signer) => signer !== intent.authorizedPublicKey,
  );
  if (unexpectedSigners.length > 0) {
    violations.push(
      `Unexpected authorization required from: ${unexpectedSigners.join(", ")}`,
    );
  }
  if (uniqueSigners.length === 0) {
    violations.push("Transaction requires no authorization; refusing to sign.");
  }

  return {
    intent,
    observedOperations: uniqueObserved,
    requiredSigners: uniqueSigners,
    matchesIntent: violations.length === 0,
    violations,
  };
}

export interface StellarWalletState {
  publicKey: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  network: WalletNetwork;
  networkMismatch: boolean;
  error: string | null;
}

export interface UseStellarWalletReturn extends StellarWalletState {
  connect: () => Promise<void>;
  disconnect: () => void;
  /**
   * Review the authorization footprint of a transaction against the declared
   * intent without prompting the wallet. Throws AuthorizationScopeError when
   * the review fails.
   */
  reviewContractOperation: (
    intent: ContractOperationIntent,
    observedOperations: readonly string[],
    requiredSigners: readonly string[],
  ) => AuthorizationScopeReview;
  /**
   * Sign a transaction after enforcing the authorization scope review.
   * `intent` must describe exactly what the user was shown; the call rejects
   * with AuthorizationScopeError if the transaction's authorization footprint
   * does not match.
   */
  signAndSubmitAnchorTx: (
    xdr: string,
    intent: ContractOperationIntent,
    observedOperations: readonly string[],
    requiredSigners: readonly string[],
  ) => Promise<string>;
}

const APP_NETWORK: WalletNetwork =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK as WalletNetwork) ?? "testnet";

function detectNetwork(networkPassphrase: string | undefined): WalletNetwork {
  if (!networkPassphrase) return "unknown";
  if (networkPassphrase.includes("Test")) return "testnet";
  if (networkPassphrase.includes("Public")) return "mainnet";
  return "unknown";
}

export function useStellarWallet(): UseStellarWalletReturn {
  const [state, setState] = useState<StellarWalletState>({
    publicKey: null,
    isConnected: false,
    isConnecting: false,
    network: "unknown",
    networkMismatch: false,
    error: null,
  });

  // Stable ref so callbacks never need the state value in their dep-array
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ── connect ──────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    setState((s) => ({ ...s, isConnecting: true, error: null }));
    try {
      const freighter = await import("@stellar/freighter-api");
      const connection = await freighter.isConnected();
      if (!connection.isConnected) {
        throw new Error("Freighter wallet is not available.");
      }
      const access = await freighter.requestAccess();
      const publicKey = access.address ?? (await freighter.getAddress()).address;
      const { networkPassphrase } = await freighter.getNetworkDetails();
      const network = detectNetwork(networkPassphrase);
      const networkMismatch = network !== "unknown" && network !== APP_NETWORK;

      setState({
        publicKey,
        isConnected: true,
        isConnecting: false,
        network,
        networkMismatch,
        error: networkMismatch
          ? `Wallet is on ${network} but the app expects ${APP_NETWORK}. Please switch networks in Freighter.`
          : null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        isConnecting: false,
        error: err instanceof Error ? err.message : "Failed to connect wallet",
      }));
    }
  }, []); // no state dependencies – uses stateRef where needed

  // ── disconnect ───────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    setState({
      publicKey: null,
      isConnected: false,
      isConnecting: false,
      network: "unknown",
      networkMismatch: false,
      error: null,
    });
  }, []);

  // ── reviewContractOperation ───────────────────────────────────────────────
  const reviewContractOperation = useCallback(
    (
      intent: ContractOperationIntent,
      observedOperations: readonly string[],
      requiredSigners: readonly string[],
    ): AuthorizationScopeReview => {
      const review = reviewAuthorizationScope(
        intent,
        observedOperations,
        requiredSigners,
      );
      if (!review.matchesIntent) {
        throw new AuthorizationScopeError(
          `Authorization scope review failed: ${review.violations.join(" ")}`,
          review,
        );
      }
      return review;
    },
    [],
  );

  // ── signAndSubmitAnchorTx ─────────────────────────────────────────────────
  const signAndSubmitAnchorTx = useCallback(
    async (
      xdr: string,
      intent: ContractOperationIntent,
      observedOperations: readonly string[],
      requiredSigners: readonly string[],
    ): Promise<string> => {
      const { isConnected, networkMismatch, publicKey } = stateRef.current;

      if (!isConnected || !publicKey) {
        throw new Error("Wallet is not connected.");
      }
      if (networkMismatch) {
        throw new Error(
          `Network mismatch: wallet is not on ${APP_NETWORK}. Please switch networks.`,
        );
      }

      // Issue #278 – enforce the authorization scope review before prompting
      // the wallet. Rejects unexpected operations or signers.
      if (intent.authorizedPublicKey !== publicKey) {
        throw new AuthorizationScopeError(
          "Authorization scope review failed: intent is bound to a different public key than the connected wallet.",
          {
            intent,
            observedOperations: Array.from(new Set(observedOperations)),
            requiredSigners: Array.from(new Set(requiredSigners)),
            matchesIntent: false,
            violations: ["Intent authorizedPublicKey does not match connected wallet."],
          },
        );
      }
      reviewContractOperation(intent, observedOperations, requiredSigners);

      const freighter = await import("@stellar/freighter-api");
      const networkPassphrase =
        APP_NETWORK === "mainnet"
          ? "Public Global Stellar Network ; September 2015"
          : "Test SDF Network ; September 2015";
      const { signedTxXdr } = await freighter.signTransaction(xdr, {
        networkPassphrase,
        address: publicKey,
      });
      return signedTxXdr;
    },
    [],
  ); // stable – reads from stateRef, not reactive state

  return {
    ...state,
    connect,
    disconnect,
    reviewContractOperation,
    signAndSubmitAnchorTx,
  };
}
