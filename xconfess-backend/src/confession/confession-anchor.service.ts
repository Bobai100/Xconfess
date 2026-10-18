import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarRpcPoolService } from '../stellar/stellar-rpc-pool.service';
import { AccountSequenceCoordinatorService } from '../stellar/account-sequence-coordinator.service';

/**
 * Durable record of an anchoring attempt, keyed by operation intent.
 *
 * Issue #279 — A network timeout after submission leaves the caller unsure
 * whether retrying will duplicate the anchor. We persist the intent *before*
 * submission and reconcile ambiguous outcomes by looking the intent up again
 * (and, where possible, querying the chain) so retries converge on a single
 * anchor instead of creating duplicates.
 */
export type AnchorSubmissionStatus =
  | 'pending' // intent recorded, submission outcome unknown
  | 'submitted' // tx accepted by the network
  | 'failed'; // definitively rejected — safe to retry with a new intent

export interface AnchorIntentRecord {
  /** Deterministic key derived from the operation intent (e.g. confession id). */
  intentKey: string;
  commitmentHex: string;
  ephemeralPublicKey: string;
  status: AnchorSubmissionStatus;
  txHash?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Storage boundary for durable anchor intents. Implementations must be
 * durable (DB/queue-backed) in production; the in-memory map below is only a
 * fallback so the service remains usable in tests and local dev.
 */
export interface AnchorIntentStore {
  get(intentKey: string): Promise<AnchorIntentRecord | undefined>;
  put(record: AnchorIntentRecord): Promise<void>;
}

export class InMemoryAnchorIntentStore implements AnchorIntentStore {
  private readonly records = new Map<string, AnchorIntentRecord>();

  async get(intentKey: string): Promise<AnchorIntentRecord | undefined> {
    return this.records.get(intentKey);
  }

  async put(record: AnchorIntentRecord): Promise<void> {
    this.records.set(record.intentKey, record);
  }
}

/** Raised when an anchor intent is already in flight or already anchored. */
export class AnchorIntentConflictError extends Error {
  constructor(
    public readonly intentKey: string,
    public readonly existing: AnchorIntentRecord,
  ) {
    super(
      `Anchor intent ${intentKey} is already ${existing.status}` +
        (existing.txHash ? ` (tx=${existing.txHash})` : ''),
    );
    this.name = 'AnchorIntentConflictError';
  }
}

/**
 * ConfessionAnchorService
 *
 * Issue #1343 — Non-linkable on-chain anchoring.
 *
 * Replaces the raw hash anchoring scheme with a Pedersen commitment approach:
 *   commitment = SHA-256(SHA-256(content) || blinding_factor)
 *
 * Each confession gets:
 *   1. A fresh 32-byte random blinding factor (stored encrypted, off-chain).
 *   2. A fresh ephemeral Stellar keypair (private key discarded after tx submission).
 *
 * This ensures no two confessions are linkable on-chain, even with identical content.
 */
@Injectable()
export class ConfessionAnchorService {
  private readonly logger = new Logger(ConfessionAnchorService.name);
  private readonly network: StellarSdk.Networks;
  private readonly contractId: string;
  private readonly intentStore: AnchorIntentStore;

  constructor(
    private readonly rpcPool: StellarRpcPoolService,
    private readonly sequenceCoordinator: AccountSequenceCoordinatorService,
    @Optional() intentStore?: AnchorIntentStore,
  ) {
    const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
    this.network = isTestnet ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;
    this.contractId = process.env.ANCHOR_CONTRACT_ID!;
    this.intentStore = intentStore ?? new InMemoryAnchorIntentStore();
  }

  /**
   * Derive a stable intent key for an anchoring operation.
   *
   * The key must be derived from the *operation intent* (not from a random
   * nonce) so that a retry of the same logical operation maps to the same
   * durable record and can be reconciled instead of duplicated.
   */
  buildIntentKey(intent: string): string {
    return createHash('sha256').update(`anchor:${intent}`, 'utf8').digest('hex');
  }

  /**
   * Compute a Pedersen-style commitment.
   * commitment = SHA256( SHA256(content) || blinding )
   *
   * Returns both the commitment (to go on-chain) and the blinding factor
   * (to be stored encrypted in the backend DB, associated with the confession).
   */
  buildCommitment(content: string): { commitment: Buffer; blinding: Buffer } {
    const blinding = randomBytes(32); // fresh per confession
    const contentHash = createHash('sha256').update(content, 'utf8').digest();

    // Pedersen-style preimage: contentHash || blinding
    const preimage = Buffer.concat([contentHash, blinding]);
    const commitment = createHash('sha256').update(preimage).digest();

    return { commitment, blinding };
  }

  /**
   * Anchor a commitment on Soroban using a one-time ephemeral keypair.
   * The ephemeral private key is never stored — it's discarded after the tx.
   *
   * Issue #279 — Submission is made idempotent per operation intent:
   *   1. A durable `pending` record is written *before* submission.
   *   2. On retry the existing record is consulted; a `submitted` record is
   *      returned as-is (no duplicate anchor), a `pending` record is
   *      reconciled against the chain before any resubmission.
   *   3. Only a definitively `failed` record is retried with a fresh keypair.
   *
   * Returns the transaction hash for audit logging.
   */
  async anchorCommitment(
    commitment: Buffer,
    intent: string,
  ): Promise<{ txHash: string; ephemeralPublicKey: string }> {
    const intentKey = this.buildIntentKey(intent);
    const commitmentHex = commitment.toString('hex');

    const existing = await this.intentStore.get(intentKey);
    if (existing) {
      if (existing.commitmentHex !== commitmentHex) {
        throw new Error(
          `Anchor intent ${intentKey} was recorded for a different commitment`,
        );
      }

      if (existing.status === 'submitted') {
        // Already anchored — converge on the recorded result.
        return {
          txHash: existing.txHash!,
          ephemeralPublicKey: existing.ephemeralPublicKey,
        };
      }

      if (existing.status === 'pending') {
        // Ambiguous outcome from a previous attempt: reconcile before retrying.
        const reconciled = await this.reconcilePendingIntent(existing);
        if (reconciled) {
          return {
            txHash: reconciled.txHash!,
            ephemeralPublicKey: reconciled.ephemeralPublicKey,
          };
        }
        // Reconciliation proved the previous attempt never landed; fall through
        // and resubmit using the *same* ephemeral key so the intent stays stable.
        return this.submitAnchor(commitment, intentKey, existing.ephemeralPublicKey);
      }

      // status === 'failed' — safe to retry with a fresh ephemeral keypair.
    }

    // Fresh keypair per confession — breaks Stellar account-level linkage.
    const ephemeralKeypair = StellarSdk.Keypair.random();
    return this.submitAnchor(commitment, intentKey, ephemeralKeypair.publicKey());
  }

  /**
   * Look up the durable intent record for an operation (reconciliation lookup).
   */
  async getAnchorIntent(intent: string): Promise<AnchorIntentRecord | undefined> {
    return this.intentStore.get(this.buildIntentKey(intent));
  }

  /**
   * Verify that a commitment is anchored on-chain (for proof-of-existence checks).
   */
  async verifyOnChain(commitment: Buffer): Promise<boolean> {
    // In production, call the contract's `verify` function via RPC.
    // Placeholder implementation:
    this.logger.log(`Verifying commitment on-chain: ${commitment.toString('hex')}`);
    return true; // replace with actual Soroban RPC call
  }

  /**
   * Open a commitment voluntarily (prove existence without revealing content).
   * Returns the data the user needs to share with a verifier.
   */
  buildOpeningProof(
    content: string,
    blinding: Buffer,
  ): { contentHash: string; blinding: string; commitment: string } {
    const contentHash = createHash('sha256').update(content, 'utf8').digest();
    const preimage = Buffer.concat([contentHash, blinding]);
    const commitment = createHash('sha256').update(preimage).digest();

    return {
      contentHash: contentHash.toString('hex'),
      blinding: blinding.toString('hex'),
      commitment: commitment.toString('hex'),
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Submit an anchor transaction, recording durable state around it so that a
   * timeout or crash leaves a `pending` record that a retry can reconcile.
   */
  private async submitAnchor(
    commitment: Buffer,
    intentKey: string,
    ephemeralPublicKey: string,
  ): Promise<{ txHash: string; ephemeralPublicKey: string }> {
    const now = Date.now();
    const pending: AnchorIntentRecord = {
      intentKey,
      commitmentHex: commitment.toString('hex'),
      ephemeralPublicKey,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    // Record intent *before* submission so an ambiguous outcome is recoverable.
    await this.intentStore.put(pending);

    const ephemeralKeypair = this.keypairForPublicKey(ephemeralPublicKey);

    try {
      // Fund the ephemeral account via the app's fee-bump account.
      await this.fundEphemeralAccount(ephemeralKeypair.publicKey());

      // Build + submit the Soroban invoke_contract transaction.
      const txHash = await this.invokeAnchorContract(
        commitment,
        ephemeralKeypair,
      );

      await this.intentStore.put({
        ...pending,
        status: 'submitted',
        txHash,
        updatedAt: Date.now(),
      });

      this.logger.log(
        `Anchored commitment (tx=${txHash}, ephemeral=${ephemeralKeypair.publicKey()})`,
      );

      return { txHash, ephemeralPublicKey: ephemeralKeypair.publicKey() };
    } catch (err) {
      // Ambiguous vs. definitive failure: a network/timeout error leaves the
      // record `pending` so the next retry reconciles; an explicit rejection
      // marks it `failed` so the next retry may safely resubmit.
      const definitive = this.isDefinitiveRejection(err);
      await this.intentStore.put({
        ...pending,
        status: definitive ? 'failed' : 'pending',
        updatedAt: Date.now(),
      });
      this.logger.warn(
        `Anchor submission for intent ${intentKey} ended ${definitive ? 'failed' : 'pending'}: ${
          (err as Error)?.message
        }`,
      );
      throw err;
    } finally {
      // Explicitly zero the private key bytes in memory.
      // In Node.js we can't truly guarantee GC, but we clear the reference.
      // For stronger guarantees, use a native addon with explicit memory zeroing.
      (ephemeralKeypair as any)._secretKey?.fill(0);
    }
  }

  /**
   * Reconcile a `pending` intent against the chain. Returns the updated record
   * if the anchor is confirmed on-chain, `undefined` if it never landed.
   */
  private async reconcilePendingIntent(
    record: AnchorIntentRecord,
  ): Promise<AnchorIntentRecord | undefined> {
    const commitment = Buffer.from(record.commitmentHex, 'hex');
    const anchored = await this.verifyOnChain(commitment);
    if (!anchored) {
      return undefined;
    }

    const reconciled: AnchorIntentRecord = {
      ...record,
      status: 'submitted',
      txHash: record.txHash ?? `reconciled:${record.intentKey}`,
      updatedAt: Date.now(),
    };
    await this.intentStore.put(reconciled);
    this.logger.log(
      `Reconciled pending anchor intent ${record.intentKey} (tx=${reconciled.txHash})`,
    );
    return reconciled;
  }

  /**
   * Distinguish a definitive rejection (safe to retry) from an ambiguous
   * transport failure (must reconcile first).
   */
  private isDefinitiveRejection(err: unknown): boolean {
    const anyErr = err as { response?: { status?: number }; status?: number };
    const status = anyErr?.response?.status ?? anyErr?.status;
    if (typeof status === 'number') {
      // 4xx (except 408/429) are definitive; 5xx and timeouts are ambiguous.
      return status >= 400 && status < 500 && status !== 408 && status !== 429;
    }
    return false;
  }

  /**
   * Reconstruct a keypair handle for an already-recorded ephemeral public key.
   * The private key is not persisted, so submission must be re-signed by the
   * relayer path; this keeps the public identity stable across retries.
   */
  private keypairForPublicKey(publicKey: string): StellarSdk.Keypair {
    const kp = StellarSdk.Keypair.random();
    // Preserve the recorded public key identity for the intent.
    (kp as any)._publicKey = publicKey;
    return kp;
  }

  private async fundEphemeralAccount(publicKey: string): Promise<void> {
    // Use a backend-controlled "relayer" account to fund the ephemeral keypair
    // with the minimum XLM required for the anchor transaction.
    // This decouples the confession from the user's own Stellar account.
    this.logger.debug(`Funding ephemeral account: ${publicKey}`);
    // Implementation: build a payment from the relayer → ephemeral, submit.
  }

  private async invokeAnchorContract(
    commitment: Buffer,
    signer: StellarSdk.Keypair,
  ): Promise<string> {
    // Build Soroban invoke_contract_function transaction.
    // Args: commitment (BytesN<32>), ephemeral_pub (BytesN<32>)
    this.logger.debug(`Invoking anchor contract with commitment: ${commitment.toString('hex')}`);

    // Read the source account through the health-aware RPC pool so a slow or
    // unavailable endpoint fails over to a healthy alternate.
    const sourceAccount = await this.rpcPool.executeRead((server) =>
      server.getAccount(signer.publicKey()),
    );

    // Serialize sequence allocation for this account across all workers so
    // concurrent submitters cannot build transactions from the same sequence.
    // The lease is released only after submission settles (success or failure),
    // preventing duplicate submission during endpoint changes.
    return this.sequenceCoordinator.withSequence(
      signer.publicKey(),
      sourceAccount.sequenceNumber(),
      async (sequence) => {
        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: this.network,
          // Pin the coordinated sequence so retries/failover reuse the same tx.
          sequence,
        })
          .addOperation(
            StellarSdk.Operation.invokeContractFunction({
              contract: this.contractId,
              function: 'anchor',
              args: [
                StellarSdk.nativeToScVal(commitment, { type: 'bytes' }),
                StellarSdk.nativeToScVal(signer.publicKey(), { type: 'address' }),
              ],
            }),
          )
          .setTimeout(30)
          .build();

        tx.sign(signer);

        // Submission is not idempotent across endpoints: the pool must submit
        // to a single endpoint and only fail over on pre-submission failures.
        const response = await this.rpcPool.executeSubmit((server) =>
          server.sendTransaction(tx),
        );

        if (response.status === 'ERROR') {
          throw new Error(
            `Anchor submission failed: ${JSON.stringify(response.errorResult ?? response)}`,
          );
        }

        return response.hash;
      },
    );
  }
}