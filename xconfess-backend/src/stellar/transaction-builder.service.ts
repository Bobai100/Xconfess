// src/stellar/transaction-builder.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as StellarSDK from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { StellarConfigService } from './stellar-config.service';
import { ITransactionOptions } from './interfaces/stellar-config.interface';
import { redactSecretStrings } from '../utils/redact-secrets';

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

  constructor(private stellarConfig: StellarConfigService) {}

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
        // Load source account
        const server = this.stellarConfig.getServer();
        const sourceAccount = await server.loadAccount(sourcePublicKey);

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
   * When a simulation envelope and context are supplied, the envelope is
   * validated first and a StaleSimulationError is thrown if it no longer
   * reflects current network/contract/operation/ledger state.
   */
  async submitTransaction(
    transaction: any,
    simulation?: SimulationResult,
    context?: SimulationContext,
  ): Promise<any> {
    if (simulation || context) {
      if (!context) {
        throw new StaleSimulationError(
          'Simulation context is required to validate a simulation result',
          'operation_mismatch',
        );
      }
      await this.validateSimulationResult(simulation, context);
    }

    const maxRetries = this.stellarConfig.getConfig().rpcMaxRetries;
    const baseDelay = this.stellarConfig.getConfig().rpcRetryBaseDelayMs;
    const maxDelay = this.stellarConfig.getConfig().rpcRetryMaxDelayMs;

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
}
