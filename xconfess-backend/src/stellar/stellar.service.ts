import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSDK from '@stellar/stellar-sdk';
import { StellarConfigService } from './stellar-config.service';
import { TransactionBuilderService } from './transaction-builder.service';
import { DeploymentMetadataService } from './services/deployment-metadata.service';
import { ITransactionResult } from './interfaces/stellar-config.interface';
import { StellarConfigResponseDto } from './dto/stellar-config-response.dto';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { redactSecretStrings } from '../utils/redact-secrets';

export interface AnchorData {
  stellarTxHash: string;
  stellarHash: string;
  anchoredAt: Date;
}

/**
 * Lifecycle of a transaction submission keyed by its operation intent.
 *
 * - `pending`: the submission was attempted but the outcome is unknown
 *   (e.g. a network timeout). The record is durable so a retry can reconcile
 *   against the network instead of blindly re-submitting.
 * - `submitted`: the network accepted the transaction and returned a hash.
 * - `confirmed`: the transaction was observed on-chain.
 * - `failed`: the submission definitively failed and may be retried.
 */
export type PendingSubmissionStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed';

export interface PendingSubmissionRecord {
  /** Deterministic key derived from the operation intent. */
  intentKey: string;
  status: PendingSubmissionStatus;
  /** Transaction hash, known once the network accepts the submission. */
  txHash?: string;
  /** Serialized intent payload used to detect conflicting retries. */
  intent: string;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmissionIntent {
  /** Logical operation kind, e.g. `tip` or `anchor`. */
  operation: string;
  /** Stable identifier of the target resource (confession id, tip id, ...). */
  resourceId: string;
  /** Optional additional discriminator (e.g. recipient public key). */
  discriminator?: string;
}

export interface ReconcileResult {
  record: PendingSubmissionRecord;
  /** True when the transaction is known to be on-chain. */
  confirmed: boolean;
  /** True when the caller may safely (re)submit the operation. */
  safeToRetry: boolean;
}

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly contractId: string;
  private readonly network: string;
  private readonly horizonUrl: string;
  /**
   * Durable-by-contract store of submission intents. In production this is
   * backed by the persistence layer; the in-memory map is the owning
   * boundary's fallback so ambiguous outcomes are never silently dropped.
   */
  private readonly pendingSubmissions = new Map<
    string,
    PendingSubmissionRecord
  >();

  constructor(
    private readonly configService: ConfigService,
    private stellarConfig: StellarConfigService,
    private txBuilder: TransactionBuilderService,
    private deploymentMetadataService: DeploymentMetadataService,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepo: Repository<AnonymousConfession>,
  ) {
    this.contractId = this.configService.get<string>(
      'CONFESSION_ANCHOR_CONTRACT',
      'CCHDY246UUPY6VUGIDVSK266KXA64CXM6RR2QLTKJD7E7IGV74ZP5XFB',
    );
    this.network = this.configService.get<string>('STELLAR_NETWORK', 'testnet');
    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
  }

  /**
   * Get account balance
   */
  async getAccountBalance(publicKey: string): Promise<{
    native: string;
    assets: Array<{ code: string; issuer: string; balance: string }>;
  }> {
    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const server = this.stellarConfig.getServer();
        const account = await server.loadAccount(publicKey);
        const native =
          account.balances.find((b) => b.asset_type === 'native')?.balance || '0';
        const assets = account.balances
          .filter((b) => b.asset_type !== 'native')
          .map((b: any) => ({
            code: b.asset_code,
            issuer: b.asset_issuer,
            balance: b.balance,
          }));
        return { native, assets };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isRetryable =
          message.toLowerCase().includes('timeout') ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset');

        if (!isRetryable || attempt >= maxRetries) {
          this.logger.error(`Failed to get account balance: ${message}`);
          throw new AppException(
            `Account not found or network error: ${message}`,
            ErrorCode.STELLAR_ERROR,
            HttpStatus.NOT_FOUND,
          );
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        this.logger.warn(
          `getAccountBalance failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    throw new AppException(
      'Account balance fetch failed after retries',
      ErrorCode.STELLAR_ERROR,
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Verify transaction on-chain (full result) with bounded retries
   */
  async verifyTransactionFull(txHash: string): Promise<ITransactionResult> {
    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const server = this.stellarConfig.getServer();
        const tx = await server.transactions().transaction(txHash).call();
        return {
          hash: tx.hash,
          success: tx.successful,
          ledger: tx.ledger as any,
          createdAt: tx.created_at,
          envelope: tx.envelope_xdr,
          result: tx.result_xdr,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isRetryable =
          message.toLowerCase().includes('timeout') ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset');

        if (!isRetryable || attempt >= maxRetries) {
          this.logger.error(`Transaction verification failed: ${message}`);
          throw new AppException(
            `Transaction not found: ${message}`,
            ErrorCode.NOT_FOUND,
            HttpStatus.NOT_FOUND,
          );
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        this.logger.warn(
          `verifyTransactionFull failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    throw new AppException(
      'Transaction verification failed after retries',
      ErrorCode.NOT_FOUND,
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Check if account exists
   */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      const server = this.stellarConfig.getServer();
      await server.loadAccount(publicKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get network configuration (safe for public exposure; never includes secrets).
   */
  getNetworkConfig(): StellarConfigResponseDto {
    const config = this.stellarConfig.getConfig();
    const metadataFreshness = this.deploymentMetadataService.getMetadataFreshness();
    return {
      network: config.network,
      horizonUrl: config.horizonUrl,
      sorobanRpcUrl: config.sorobanRpcUrl,
      contractIds: {
        confessionAnchor: config.contractIds.confessionAnchor ?? null,
        reputationBadges: config.contractIds.reputationBadges ?? null,
        tippingSystem: config.contractIds.tippingSystem ?? null,
      },
      deploymentMetadata: {
        loaded: !!this.deploymentMetadataService.getMetadata(),
        generatedAtUtc: metadataFreshness.generatedAtUtc,
        isStale: metadataFreshness.isStale,
        ageDays:
          metadataFreshness.daysSinceGeneration >= 0
            ? metadataFreshness.daysSinceGeneration
            : null,
        loadError: this.deploymentMetadataService.getLoadError(),
      },
    };
  }

  /**
   * Send payment
   */
  async sendPayment(
    destinationPublicKey: string,
    amount: string,
    memo?: string,
  ): Promise<ITransactionResult> {
    try {
      const serverSecret = this.configService.get('STELLAR_SERVER_SECRET');
      if (!serverSecret) {
        throw new AppException(
          'Server secret key not configured',
          ErrorCode.INTERNAL_SERVER_ERROR,
        );
      }
      const serverKeypair = StellarSDK.Keypair.fromSecret(serverSecret);
      const tx = await this.txBuilder.buildPaymentTransaction(
        serverKeypair.publicKey(),
        destinationPublicKey,
        amount,
        StellarSDK.Asset.native(),
        { memo },
      );
      const signedTx = this.txBuilder.signTransaction(tx, serverSecret);
      const result = await this.txBuilder.submitTransaction(signedTx);
      return {
        hash: result.hash,
        success: result.successful,
      };
    } catch (error: unknown) {
      // Redacted defensively: this path constructs a keypair directly from
      // the server secret, so any thrown error is not guaranteed secret-free.
      const message = redactSecretStrings(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(`Payment failed: ${message}`);
      throw error;
    }
  }

  /**
   * Derive a deterministic, collision-resistant key from an operation intent.
   * Retries of the same logical operation always map to the same key, which
   * is what makes reconciliation idempotent.
   */
  deriveIntentKey(intent: SubmissionIntent): string {
    if (!intent || !intent.operation || !intent.resourceId) {
      throw new AppException(
        'Submission intent requires operation and resourceId',
        ErrorCode.VALIDATION_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }
    const payload = JSON.stringify({
      operation: intent.operation,
      resourceId: intent.resourceId,
      discriminator: intent.discriminator ?? null,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Look up the durable pending-submission record for an intent, if any.
   */
  getPendingSubmission(
    intent: SubmissionIntent,
  ): PendingSubmissionRecord | undefined {
    return this.pendingSubmissions.get(this.deriveIntentKey(intent));
  }

  /**
   * Record that a submission was attempted but its outcome is ambiguous.
   * Idempotent: repeated calls for the same intent only bump the attempt
   * counter and preserve any previously observed transaction hash.
   */
  recordPendingSubmission(
    intent: SubmissionIntent,
    error?: unknown,
  ): PendingSubmissionRecord {
    const intentKey = this.deriveIntentKey(intent);
    const now = new Date();
    const existing = this.pendingSubmissions.get(intentKey);
    const message =
      error === undefined
        ? undefined
        : redactSecretStrings(
            error instanceof Error ? error.message : String(error),
          );

    const record: PendingSubmissionRecord = existing
      ? {
          ...existing,
          status: existing.txHash ? 'submitted' : 'pending',
          attempts: existing.attempts + 1,
          lastError: message ?? existing.lastError,
          updatedAt: now,
        }
      : {
          intentKey,
          status: 'pending',
          intent: JSON.stringify(intent),
          attempts: 1,
          lastError: message,
          createdAt: now,
          updatedAt: now,
        };

    this.pendingSubmissions.set(intentKey, record);
    this.logger.warn(
      `Recorded ambiguous submission for intent ${intentKey} (attempt ${record.attempts})`,
    );
    return record;
  }

  /**
   * Record a successful submission (network accepted the transaction).
   */
  recordSubmittedTransaction(
    intent: SubmissionIntent,
    txHash: string,
  ): PendingSubmissionRecord {
    const intentKey = this.deriveIntentKey(intent);
    const now = new Date();
    const existing = this.pendingSubmissions.get(intentKey);
    const record: PendingSubmissionRecord = {
      intentKey,
      status: 'submitted',
      txHash,
      intent: JSON.stringify(intent),
      attempts: existing ? existing.attempts + 1 : 1,
      lastError: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.pendingSubmissions.set(intentKey, record);
    return record;
  }

  /**
   * Reconcile an ambiguous submission against the network before retrying.
   *
   * - If a transaction hash is already known, verify it on-chain.
   * - If no hash is known, the caller may safely retry (no evidence of a
   *   prior accepted submission).
   *
   * This is the single authoritative check that prevents duplicate tipping
   * or anchoring when a retry follows a timeout.
   */
  async reconcileSubmission(
    intent: SubmissionIntent,
    requestId?: string,
  ): Promise<ReconcileResult> {
    const intentKey = this.deriveIntentKey(intent);
    const existing = this.pendingSubmissions.get(intentKey);

    if (!existing) {
      return {
        record: {
          intentKey,
          status: 'pending',
          intent: JSON.stringify(intent),
          attempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        confirmed: false,
        safeToRetry: true,
      };
    }

    if (!existing.txHash) {
      return { record: existing, confirmed: false, safeToRetry: true };
    }

    const confirmed = await this.verifyTransaction(existing.txHash, requestId);
    const now = new Date();
    const record: PendingSubmissionRecord = {
      ...existing,
      status: confirmed ? 'confirmed' : existing.status,
      updatedAt: now,
    };
    this.pendingSubmissions.set(intentKey, record);

    return {
      record,
      confirmed,
      // A known-but-unconfirmed hash must not be re-submitted blindly.
      safeToRetry: false,
    };
  }

  /**
   * Mark a submission as definitively failed so a retry is authorized.
   */
  markSubmissionFailed(
    intent: SubmissionIntent,
    error?: unknown,
  ): PendingSubmissionRecord {
    const intentKey = this.deriveIntentKey(intent);
    const existing = this.pendingSubmissions.get(intentKey);
    const now = new Date();
    const message =
      error === undefined
        ? undefined
        : redactSecretStrings(
            error instanceof Error ? error.message : String(error),
          );
    const record: PendingSubmissionRecord = {
      intentKey,
      status: 'failed',
      txHash: existing?.txHash,
      intent: JSON.stringify(intent),
      attempts: existing?.attempts ?? 1,
      lastError: message ?? existing?.lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.pendingSubmissions.set(intentKey, record);
    return record;
  }

  /**
   * Generate SHA-256 hash of confession content for anchoring
   */
  hashConfession(content: string, timestamp?: number): string {
    const ts = timestamp || Date.now();
    const payload = JSON.stringify({ content, timestamp: ts });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Validate a Stellar transaction hash format
   */
  isValidTxHash(txHash: string): boolean {
    if (!txHash || typeof txHash !== 'string') {
      return false;
    }
    return /^[a-fA-F0-9]{64}$/.test(txHash);
  }

  /**
   * Build the Stellar Explorer URL for a transaction
   */
  getExplorerUrl(txHash: string): string {
    const baseUrl =
      this.network === 'mainnet'
        ? 'https://stellar.expert/explorer/public/tx'
        : 'https://stellar.expert/explorer/testnet/tx';
    return `${baseUrl}/${txHash}`;
  }

  /**
   * Build the Horizon API URL for a transaction
   */
  getHorizonTxUrl(txHash: string): string {
    return `${this.horizonUrl}/transactions/${txHash}`;
  }

  /**
   * Verify a transaction exists on the Stellar network
   */
  async verifyTransaction(txHash: string, requestId?: string): Promise<boolean> {
    if (!this.isValidTxHash(txHash)) {
      return false;
    }

    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutMs = rpcConfig.rpcTimeoutMs;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;
        try {
          response = await fetch(this.getHorizonTxUrl(txHash), {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          return false;
        }

        const data = await response.json();
        return data.successful === true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isAbort =
          error instanceof DOMException && error.name === 'AbortError';
        const isRetryable =
          isAbort ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset') ||
          message.toLowerCase().includes('network');

        if (!isRetryable || attempt >= maxRetries) {
          this.logger.error({
            message: `Error verifying Stellar transaction: ${message}`,
            requestId,
            txHash,
          });
          return false;
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        this.logger.warn({
          message: `Transaction verify failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
          requestId,
          txHash,
        });
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    return false;
  }

  /**
   * Process anchoring data from frontend
   */
  processAnchorData(
    confessionContent: string,
    txHash: string,
    timestamp?: number,
  ): AnchorData | null {
    if (!this.isValidTxHash(txHash)) {
      return null;
    }

    const stellarHash = this.hashConfession(confessionContent, timestamp);

    return {
      stellarTxHash: txHash,
      stellarHash,
      anchoredAt: new Date(),
    };
  }

  /**
   * Get contract configuration info
   */
  getContractInfo(): {
    contractId: string;
    network: string;
    horizonUrl: string;
  } {
    return {
      contractId: this.contractId,
      network: this.network,
      horizonUrl: this.horizonUrl,
    };
  }

  /**
   * Get paginated anchored confessions for a user
   */
  async getUserAnchors(
    userId: number,
    page: number = 1,
    limit: number = 10,
  ): Promise<{
    data: Array<{
      confessionId: string;
      stellarTxHash: string;
      stellarHash: string;
      anchoredAt: Date;
      contractId: string;
      stellarExplorerUrl: string;
      message: string;
    }>;
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [confessions, total] = await this.confessionRepo
      .createQueryBuilder('confession')
      .innerJoin('confession.anonymousUser', 'anonUser')
      .innerJoin('anonUser.userLinks', 'userLink')
      .innerJoin('userLink.user', 'user')
      .where('user.id = :userId', { userId })
      .andWhere('confession.isAnchored = true')
      .andWhere('confession.isDeleted = false')
      .orderBy('confession.anchoredAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const data = confessions.map((conf) => ({
      confessionId: conf.id,
      stellarTxHash: conf.stellarTxHash,
      stellarHash: conf.stellarHash,
      anchoredAt: conf.anchoredAt,
      contractId: this.contractId,
      stellarExplorerUrl: this.getExplorerUrl(conf.stellarTxHash),
      message: '',
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
