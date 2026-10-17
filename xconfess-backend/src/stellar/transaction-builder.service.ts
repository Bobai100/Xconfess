// src/stellar/transaction-builder.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as StellarSDK from '@stellar/stellar-sdk';
import { StellarConfigService } from './stellar-config.service';
import { ITransactionOptions } from './interfaces/stellar-config.interface';
import { redactSecretStrings } from '../utils/redact-secrets';
import {
  AccountSequenceCoordinator,
  AccountSequenceLease,
} from './account-sequence-coordinator.service';

@Injectable()
export class TransactionBuilderService {
  private readonly logger = new Logger(TransactionBuilderService.name);

  constructor(
    private stellarConfig: StellarConfigService,
    private sequenceCoordinator: AccountSequenceCoordinator,
  ) {}

  /**
   * Build a Stellar transaction with operations
   * Applies fee budget checks and backoff if fees exceed policy
   */
  async buildTransaction(
    sourcePublicKey: string,
    operations: any[],
    options?: ITransactionOptions,
  ): Promise<any> {
    // Serialize sequence allocation for this account across workers. The lease
    // is held for the whole build (loadAccount -> build) so concurrent
    // submitters cannot observe and reuse the same sequence number.
    const lease = await this.sequenceCoordinator.acquire(sourcePublicKey);
    try {
      return await this.buildTransactionWithLease(
        sourcePublicKey,
        operations,
        options,
        lease,
      );
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
   * Submit transaction to network with bounded retries for transient failures
   */
  async submitTransaction(transaction: any): Promise<any> {
    // Hold the account sequence lease across submission so a retry or a
    // concurrent worker cannot interleave a competing sequence.
    const sourceAccountId = this.getSourceAccountId(transaction);
    const lease = sourceAccountId
      ? await this.sequenceCoordinator.acquire(sourceAccountId)
      : undefined;

    try {
      return await this.submitTransactionWithLease(transaction);
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

  private async submitTransactionWithLease(transaction: any): Promise<any> {
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
}
