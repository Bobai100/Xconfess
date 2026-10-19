// src/stellar/transaction-builder.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as StellarSDK from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { StellarConfigService } from './stellar-config.service';
import { ITransactionOptions } from './interfaces/stellar-config.interface';
import { redactSecretStrings } from '../utils/redact-secrets';
import {
  PendingSubmissionStore,
  PendingSubmissionRecord,
} from './pending-submission.store';

/**
 * Options controlling durable, idempotent submission.
 *
 * `intentKey` is a caller-supplied, stable identifier for the *operation
 * intent* (e.g. `tip:<tipId>` or `anchor:<anchorId>`). When supplied, the
 * builder records the intent before touching the network and reconciles
 * against it on retry, so a timeout after submission can never produce a
 * duplicate tip or anchor.
 */
export interface ISubmitOptions {
  intentKey?: string;
  /** How long a pending record is considered authoritative before expiry. */
  pendingTtlMs?: number;
}
import {
  AccountSequenceCoordinator,
  AccountSequenceLease,
} from './account-sequence-coordinator.service';
import {
  TransactionLatencyService,
  TransactionOperationClass,
  TransactionPhase,
} from './transaction-latency.service';

/**
 * Envelope binding a simulation result to the exact network, contract and
 * operation inputs it was produced for, plus the ledger state it observed.
 * A submission must present a fresh, matching envelope or it is rejected.
 */
export interface SimulationResult {
  networkPassphrase: string;
  contractId: string;
  operationHash: string;
  latestLedgerSequence: number;
  timestamp: number;
}

export interface SimulationContext {
  contractId: string;
  operations: any[];
  latestLedgerSequence: number;
}

export class StaleSimulationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'network_mismatch'
      | 'contract_mismatch'
      | 'operation_mismatch'
      | 'expired'
      | 'ledger_advanced',
  ) {
    super(message);
    this.name = 'StaleSimulationError';
  }
}

@Injectable()
export class TransactionBuilderService {
  private readonly logger = new Logger(TransactionBuilderService.name);

  constructor(
    private stellarConfig: StellarConfigService,
    private readonly pendingStore: PendingSubmissionStore,
    private sequenceCoordinator: AccountSequenceCoordinator,
    private transactionLatency: TransactionLatencyService,
  ) {}

  /**
   * Deterministically hash operation inputs so a simulation envelope can be
   * bound to the exact operations it was produced for.
   */
  computeOperationHash(operations: any[]): string {
    const serialized = JSON.stringify(operations ?? []);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Capture a simulation envelope for the given contract/operations.
   * Callers must pass the envelope back to submitTransaction.
   */
  createSimulationResult(
    context: SimulationContext,
    now: number = Date.now(),
  ): SimulationResult {
    return {
      networkPassphrase: this.stellarConfig.getNetwork(),
      contractId: context.contractId,
      operationHash: this.computeOperationHash(context.operations),
      latestLedgerSequence: context.latestLedgerSequence,
      timestamp: now,
    };
  }

  /**
   * Validate a simulation envelope against the current invocation and ledger
   * state. Throws StaleSimulationError when the envelope is stale or does not
   * match the network, contract or operations being submitted.
   */
  async validateSimulationResult(
    simulation: SimulationResult | undefined,
    context: SimulationContext,
    now: number = Date.now(),
  ): Promise<void> {
    if (!simulation) {
      throw new StaleSimulationError(
        'Missing simulation result; refusing to submit',
        'expired',
      );
    }

    const currentNetwork = this.stellarConfig.getNetwork();
    if (simulation.networkPassphrase !== currentNetwork) {
      throw new StaleSimulationError(
        `Simulation network ${simulation.networkPassphrase} does not match current network ${currentNetwork}`,
        'network_mismatch',
      );
    }

    if (simulation.contractId !== context.contractId) {
      throw new StaleSimulationError(
        `Simulation contract ${simulation.contractId} does not match current contract ${context.contractId}`,
        'contract_mismatch',
      );
    }

    const currentHash = this.computeOperationHash(context.operations);
    if (simulation.operationHash !== currentHash) {
      throw new StaleSimulationError(
        'Simulation operation hash does not match current operations',
        'operation_mismatch',
      );
    }

    const freshnessWindowMs = this.stellarConfig.getSimulationFreshnessWindowMs();
    const age = now - simulation.timestamp;
    if (!Number.isFinite(age) || age < 0 || age > freshnessWindowMs) {
      throw new StaleSimulationError(
        `Simulation is stale: age ${age}ms exceeds freshness window ${freshnessWindowMs}ms`,
        'expired',
      );
    }

    const server = this.stellarConfig.getServer();
    const latestLedger = await server.getLatestLedger();
    const currentSequence = (latestLedger as any).sequence as number;
    if (
      typeof currentSequence === 'number' &&
      currentSequence > simulation.latestLedgerSequence
    ) {
      throw new StaleSimulationError(
        `Ledger advanced from ${simulation.latestLedgerSequence} to ${currentSequence} since simulation`,
        'ledger_advanced',
      );
    }
  }

  /**
   * Build a Stellar transaction with operations
   * Applies fee budget checks and backoff if fees exceed policy
   */
  async buildTransaction(
    sourcePublicKey: string,
    operations: any[],
    options?: ITransactionOptions,
  ): Promise<any> {
    const operationClass = TransactionLatencyService.classifyOperations(
      operations,
    );
    const startedAt = Date.now();
    const lease = await this.sequenceCoordinator.acquire(sourcePublicKey);
    try {
      const transaction = await this.buildTransactionWithLease(
        sourcePublicKey,
        operations,
        options,
        lease,
      );
      this.transactionLatency.record(
        TransactionPhase.BUILD,
        operationClass,
        Date.now() - startedAt,
        true,
      );
      return transaction;
    } catch (error) {
      this.transactionLatency.record(
        TransactionPhase.BUILD,
        operationClass,
        Date.now() - startedAt,
        false,
      );
      throw error;
    } finally {
      await this.sequenceCoordinator.release(lease);
    }
  }

  private async buildTransactionWithLease(
    sourcePublicKey: string,
    operations: any[],
    options: ITransactionOptions | undefined,
    lease: AccountSequenceLease,
  ): Promise<any> {
    const maxFee = this.stellarConfig.getConfig().maxFeeBudget;
    const feeBackoffMs = this.stellarConfig.getConfig().feeBackoffMs;
    const maxRetries = this.stellarConfig.getConfig().maxFeeRetries;

    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;

      // Estimate fee
      const feeEstimate = parseInt(await this.estimateFee(operations.length));
      if (feeEstimate > maxFee) {
        if (attempt > maxRetries) {
          const msg = `Transaction fee ${feeEstimate} exceeds max fee budget ${maxFee} after ${maxRetries} retries`;
          this.logger.warn(msg);
          throw new Error(msg);
        }

        this.logger.warn(
          `Transaction fee ${feeEstimate} exceeds max budget ${maxFee}. Backing off for ${feeBackoffMs}ms (attempt ${attempt})`,
        );
        await new Promise((res) => setTimeout(res, feeBackoffMs));
        continue;
      }

      try {
        // Load source account. The coordinator pins the sequence we are allowed
        // to build against so a stale network read cannot reuse a sequence.
        const server = this.stellarConfig.getServer();
        const sourceAccount = await server.loadAccount(sourcePublicKey);
        const pinnedSequence = this.sequenceCoordinator.nextSequence(
          lease,
          sourceAccount.sequenceNumber(),
        );
        sourceAccount.sequenceNumber = () => pinnedSequence;

        const txBuilder = new StellarSDK.TransactionBuilder(sourceAccount, {
          fee: options?.fee || feeEstimate.toString(),
          networkPassphrase: this.stellarConfig.getNetwork(),
        });

        operations.forEach((op) => txBuilder.addOperation(op));

        if (options?.memo) {
          txBuilder.addMemo(StellarSDK.Memo.text(options.memo));
        }

        if (options?.timebounds) {
          txBuilder.setTimeout(options.timebounds.maxTime);
        } else {
          txBuilder.setTimeout(300);
        }

        return txBuilder.build();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to build transaction on attempt ${attempt}: ${message}`,
        );
        if (attempt >= maxRetries) {
          const errMsg = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Transaction build failed after ${attempt} attempts: ${errMsg}`,
          );
        }
        await new Promise((res) => setTimeout(res, feeBackoffMs));
      }
    }
  }

  /**
   * Build a payment transaction
   */
  async buildPaymentTransaction(
    sourcePublicKey: string,
    destinationPublicKey: string,
    amount: string,
    asset: any = StellarSDK.Asset.native(),
    options?: ITransactionOptions,
  ): Promise<any> {
    const paymentOp = StellarSDK.Operation.payment({
      destination: destinationPublicKey,
      asset,
      amount,
    });

    return this.buildTransaction(sourcePublicKey, [paymentOp], options);
  }

  /**
   * Sign transaction with secret key
   */
  signTransaction(transaction: any, secretKey: string): any {
    try {
      const keypair = StellarSDK.Keypair.fromSecret(secretKey);
      transaction.sign(keypair);
      return transaction;
    } catch (error: unknown) {
      // Redacted defensively: the underlying error is derived from the secret
      // key itself and must never be assumed safe to log verbatim.
      const message = redactSecretStrings(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(`Failed to sign transaction: ${message}`);
      throw new Error(`Transaction signing failed: ${message}`);
    }
  }

  /**
   * Estimate transaction fee
   */
  async estimateFee(operationsCount: number): Promise<string> {
    try {
      const server = this.stellarConfig.getServer();
      const feeStats = await server.feeStats();
      const baseFee = (feeStats as any).fee_charged.mode || StellarSDK.BASE_FEE;
      return (parseInt(baseFee) * operationsCount).toString();
    } catch {
      return (parseInt(StellarSDK.BASE_FEE) * operationsCount).toString();
    }
  }

  /**
   * Submit transaction to network with bounded retries for transient failures.
   *
   * When `options.intentKey` is provided the submission becomes idempotent:
   *  1. A durable pending record is written *before* the first network call.
   *  2. On entry (and on every retry) the store is consulted; if a previous
   *     attempt already landed a transaction hash, that result is returned
   *     instead of submitting again.
   *  3. Ambiguous outcomes (timeouts / connection resets) leave the record in
   *     `pending` so a later call reconciles via `reconcilePendingSubmission`.
   */
  async submitTransaction(
    transaction: any,
    options: ISubmitOptions = {},
    operationClass: TransactionOperationClass = TransactionOperationClass.OTHER,
  ): Promise<any> {
    const { intentKey } = options;
    if (!intentKey) {
      return this.submitWithRetries(transaction, operationClass);
    }

    const ttlMs =
      options.pendingTtlMs ??
      this.stellarConfig.getConfig().pendingSubmissionTtlMs;

    // Reconcile first: a prior attempt may have already landed.
    const existing = await this.pendingStore.get(intentKey);
    if (existing && !this.pendingStore.isExpired(existing, ttlMs)) {
      if (existing.status === 'confirmed' && existing.txHash) {
        this.logger.log(
          `Intent ${intentKey} already confirmed as ${existing.txHash}; skipping submission`,
        );
        return { hash: existing.txHash, ledger: existing.ledger, reconciled: true };
      }
      if (existing.status === 'pending') {
        const reconciled = await this.reconcilePendingSubmission(
          intentKey,
          existing,
        );
        if (reconciled) {
          return reconciled;
        }
      }
    }

    const txHash = this.safeTransactionHash(transaction);
    const record: PendingSubmissionRecord = {
      intentKey,
      txHash,
      status: 'pending',
      attempts: (existing?.attempts ?? 0) + 1,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.pendingStore.put(record);

    try {
      const result = await this.submitWithRetries(transaction, operationClass);
      await this.pendingStore.put({
        ...record,
        status: 'confirmed',
        txHash: result?.hash ?? txHash,
        ledger: result?.ledger,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const definitive = this.isDefinitiveFailure(error);
      await this.pendingStore.put({
        ...record,
        status: definitive ? 'failed' : 'pending',
        lastError: message,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Look up a previously recorded intent and, if the network already has the
   * transaction, promote the record to `confirmed`. Returns the submission
   * result when reconciliation succeeds, otherwise `null`.
   */
  async reconcilePendingSubmission(
    intentKey: string,
    record?: PendingSubmissionRecord,
  ): Promise<any | null> {
    const pending = record ?? (await this.pendingStore.get(intentKey));

      return null;
    }

    try {
      const server = this.stellarConfig.getServer();
      const tx = await server.getTransaction(pending.txHash);
      const status = (tx as { status?: string }).status;
      if (status === 'SUCCESS') {
        await this.pendingStore.put({
          ...pending,
          status: 'confirmed',
          ledger: (tx as { ledger?: number }).ledger,
          updatedAt: new Date().toISOString(),
        });
        this.logger.log(
          `Reconciled intent ${intentKey} to confirmed tx ${pending.txHash}`,
        );
        return {
          hash: pending.txHash,
          ledger: (tx as { ledger?: number }).ledger,
          reconciled: true,
        };
      }
      if (status === 'FAILED') {
        await this.pendingStore.put({
          ...pending,
          status: 'failed',
          lastError: 'reconciled: transaction failed on-chain',
          updatedAt: new Date().toISOString(),
        });
        return null;
      }
      // NOT_FOUND: still ambiguous, leave pending for a later retry.
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Reconciliation lookup for intent ${intentKey} failed: ${message}`,
      );
      return null;
    }
  }

  private safeTransactionHash(transaction: any): string | undefined {
    try {
      if (typeof transaction?.hash === 'function') {
        return transaction.hash().toString('hex');
      }
    } catch {
      // Hash computation is best-effort; the record is still durable.
    }
    return undefined;
  }

  private isDefinitiveFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('non-retryable') ||
      message.includes('tx_bad_auth') ||
      message.includes('tx_bad_seq') ||
      message.includes('tx_malformed') ||
      message.includes('tx_not_supported')
    );
  }

  private async submitWithRetries(
    transaction: any,
    operationClass: TransactionOperationClass = TransactionOperationClass.OTHER,
  ): Promise<any> {
    // Hold the account sequence lease across submission so a retry or a
    // concurrent worker cannot interleave a competing sequence.
    const sourceAccountId = this.getSourceAccountId(transaction);
    const lease = sourceAccountId
      ? await this.sequenceCoordinator.acquire(sourceAccountId)
      : undefined;
  }
    const baseDelay = this.stellarConfig.getConfig().rpcRetryBaseDelayMs;
    const maxDelay = this.stellarConfig.getConfig().rpcRetryMaxDelayMs;
    const startedAt = Date.now();

    try {
      const result = await this.submitTransactionInternal(
        transaction,
        maxRetries,
        baseDelay,
        maxDelay,
      );
      this.transactionLatency.record(
        TransactionPhase.SUBMISSION,
        operationClass,
        Date.now() - startedAt,
        true,
      );
      return result;
    } catch (error) {
      this.transactionLatency.record(
        TransactionPhase.SUBMISSION,
        operationClass,
        Date.now() - startedAt,
        false,
      );
      throw error;
    } finally {
      if (lease) {
        await this.sequenceCoordinator.release(lease);
      }
    }
  }

  private getSourceAccountId(transaction: any): string | undefined {
    try {
      const source = transaction?.source;
      if (!source) {
        return undefined;
      }
      return typeof source === 'string' ? source : source.accountId?.();
    } catch {
      return undefined;
    }
  }

  private async submitTransactionInternal(
    transaction: any,
    maxRetries: number,
    baseDelay: number,
    maxDelay: number,
  ): Promise<any> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const server = this.stellarConfig.getServer();
        const result = await server.submitTransaction(transaction);
        this.logger.log(`Transaction submitted: ${result.hash}`);
        return result;
      } catch (error: unknown) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const withResponse = error as {
          response?: { data?: { extras?: { result_codes?: unknown } } };
          status?: number;
        };

        // Non-retryable errors: bad auth, malformed, sequence errors
        const resultCodes = withResponse.response?.data?.extras?.result_codes;
        if (resultCodes) {
          const codes = resultCodes as { transaction?: string; operations?: string[] };
          const txCode = codes.transaction;
          if (
            txCode === 'tx_bad_auth' ||
            txCode === 'tx_bad_seq' ||
            txCode === 'tx_malformed' ||
            txCode === 'tx_not_supported'
          ) {
            if (txCode === 'tx_bad_seq') {
              // Sequence was consumed or invalidated elsewhere; drop the cached
              // sequence so the next build re-reads from the network.
              const accountId = this.getSourceAccountId(transaction);
              if (accountId) {
                this.sequenceCoordinator.invalidate(accountId);
              }
            }
            throw new Error(`Transaction failed (non-retryable): ${JSON.stringify(resultCodes)}`);
          }
        }

        // 400 Bad Request is non-retryable
        if (withResponse.status === 400) {
          throw new Error(`Transaction submission failed: ${message}`);
        }

        // Retryable: network errors, timeouts, 5xx, 429
        const isRetryable =
          !withResponse.status ||
          withResponse.status >= 500 ||
          withResponse.status === 429 ||
          message.toLowerCase().includes('timeout') ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset');

        if (!isRetryable || attempt >= maxRetries) {
          if (withResponse.response?.data?.extras?.result_codes) {
            const codes = withResponse.response.data.extras.result_codes;
            throw new Error(`Transaction failed: ${JSON.stringify(codes)}`);
          }
          throw new Error(`Transaction submission failed: ${message}`);
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        this.logger.warn(
          `Transaction submission failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${message}`,
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Transaction submission failed after ${maxRetries + 1} attempts: ${message}`);
  }

  /**
   * Record inclusion/confirmation latency observed by callers once the
   * transaction is observed on-chain. Bounded labels only.
   */
  recordInclusionLatency(
    operationClass: TransactionOperationClass,
    latencyMs: number,
    success: boolean,
  ): void {
    this.transactionLatency.record(
      TransactionPhase.INCLUSION,
      operationClass,
      latencyMs,
      success,
    );
  }

  recordConfirmationLatency(
    operationClass: TransactionOperationClass,
    latencyMs: number,
    success: boolean,
  ): void {
    this.transactionLatency.record(
      TransactionPhase.CONFIRMATION,
      operationClass,
      latencyMs,
      success,
    );
  }
}
