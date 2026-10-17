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
 * User-visible lifecycle of a submitted transaction.
 *
 * - ACCEPTED:  the transaction was submitted to the network (hash known) but
 *              no verified ledger evidence has been observed yet.
 * - INCLUDED:  the transaction is present in a closed ledger but has not yet
 *              reached the configured confirmation depth.
 * - FINALIZED: the transaction is included at a ledger whose depth meets the
 *              confirmation threshold, so it is considered irreversible.
 * - FAILED:    the transaction was included in a ledger but its result code
 *              indicates failure (e.g. tx_failed / tx_bad_seq).
 * - UNKNOWN:   no trustworthy evidence is available (missing, ambiguous or
 *              conflicting RPC observations). Never promoted without evidence.
 */
export enum TransactionFinalityState {
  ACCEPTED = 'ACCEPTED',
  INCLUDED = 'INCLUDED',
  FINALIZED = 'FINALIZED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
}

/**
 * Verified evidence gathered from a single RPC/Horizon observation.
 */
export interface TransactionObservation {
  txHash: string;
  /** Ledger sequence the transaction was included in, if any. */
  ledger: number | null;
  /** Whether the transaction succeeded, if the network reported it. */
  successful: boolean | null;
  /** Raw result code reported by the network, if any. */
  resultCode: string | null;
  /** Whether the observation contained enough evidence to be trusted. */
  verified: boolean;
  /** Reason the observation could not be verified, when applicable. */
  reason?: string;
  observedAt: Date;
}

/**
 * Persisted finality record for a logical transaction.
 */
export interface TransactionFinalityRecord {
  txHash: string;
  state: TransactionFinalityState;
  ledger: number | null;
  resultCode: string | null;
  /** Replacement hashes linked to this logical transaction (fee bumps). */
  replacementHashes: string[];
  /** Hash of the transaction this one replaced, if any. */
  replacesHash: string | null;
  lastObservedAt: Date | null;
  updatedAt: Date;
}

/**
 * Minimal persistence boundary for finality records. Implementations may back
 * this with a database table; the service only depends on this contract so
 * that observations can be recorded and read back deterministically.
 */
export interface TransactionFinalityRepository {
  find(txHash: string): Promise<TransactionFinalityRecord | null>;
  save(record: TransactionFinalityRecord): Promise<TransactionFinalityRecord>;
}

/**
 * In-memory fallback used when no persistent repository is wired in. Kept
 * intentionally simple; production deployments should provide a durable
 * implementation via the DI token below.
 */
export class InMemoryTransactionFinalityRepository
  implements TransactionFinalityRepository
{
  private readonly records = new Map<string, TransactionFinalityRecord>();

  async find(txHash: string): Promise<TransactionFinalityRecord | null> {
    const record = this.records.get(txHash);
    return record ? { ...record, replacementHashes: [...record.replacementHashes] } : null;
  }

  async save(record: TransactionFinalityRecord): Promise<TransactionFinalityRecord> {
    const stored = { ...record, replacementHashes: [...record.replacementHashes] };
    this.records.set(record.txHash, stored);
    return { ...stored, replacementHashes: [...stored.replacementHashes] };
  }
}

export const TRANSACTION_FINALITY_REPOSITORY = Symbol(
  'TRANSACTION_FINALITY_REPOSITORY',
);

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly contractId: string;
  private readonly network: string;
  private readonly horizonUrl: string;
  private readonly confirmationDepth: number;
  private readonly finalityRepository: TransactionFinalityRepository;

  constructor(
    private readonly configService: ConfigService,
    private stellarConfig: StellarConfigService,
    private txBuilder: TransactionBuilderService,
    private deploymentMetadataService: DeploymentMetadataService,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepo: Repository<AnonymousConfession>,
    finalityRepository?: TransactionFinalityRepository,
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
    const configuredDepth = Number(
      this.configService.get<string | number>('STELLAR_CONFIRMATION_DEPTH', 1),
    );
    this.confirmationDepth =
      Number.isFinite(configuredDepth) && configuredDepth >= 1
        ? Math.floor(configuredDepth)
        : 1;
    this.finalityRepository =
      finalityRepository ?? new InMemoryTransactionFinalityRepository();
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
   * Record that a transaction has been accepted (submitted) by the network.
   *
   * This only establishes the ACCEPTED baseline; it never promotes a
   * transaction to INCLUDED/FINALIZED without verified ledger evidence.
   */
  async recordAccepted(txHash: string): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(txHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.finalityRepository.find(txHash);
    if (existing && existing.state !== TransactionFinalityState.UNKNOWN) {
      // Never downgrade a verified state back to ACCEPTED.
      return existing;
    }

    const now = new Date();
    const record: TransactionFinalityRecord = {
      txHash,
      state: TransactionFinalityState.ACCEPTED,
      ledger: existing?.ledger ?? null,
      resultCode: existing?.resultCode ?? null,
      replacementHashes: existing?.replacementHashes ?? [],
      replacesHash: existing?.replacesHash ?? null,
      lastObservedAt: existing?.lastObservedAt ?? null,
      updatedAt: now,
    };
    return this.finalityRepository.save(record);
  }

  /**
   * Observe a transaction on the network and persist verified evidence.
   *
   * Only verified observations promote state:
   *  - included at ledger depth >= confirmationDepth -> FINALIZED
   *  - included but below confirmation depth          -> INCLUDED
   *  - included with a failing result code            -> FAILED
   *  - missing / ambiguous / conflicting evidence     -> UNKNOWN (no promotion)
   */
  async observeTransaction(txHash: string): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(txHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.finalityRepository.find(txHash);
    const observation = await this.fetchObservation(txHash);
    const now = new Date();

    const base: TransactionFinalityRecord = existing ?? {
      txHash,
      state: TransactionFinalityState.UNKNOWN,
      ledger: null,
      resultCode: null,
      replacementHashes: [],
      replacesHash: null,
      lastObservedAt: null,
      updatedAt: now,
    };

    if (!observation.verified) {
      // Ambiguous or missing evidence: keep any previously verified state,
      // otherwise remain UNKNOWN. Never promote on unverified data.
      const next: TransactionFinalityRecord = {
        ...base,
        state:
          base.state === TransactionFinalityState.ACCEPTED
            ? TransactionFinalityState.ACCEPTED
            : base.state,
        lastObservedAt: now,
        updatedAt: now,
      };
      return this.finalityRepository.save(next);
    }

    // Conflicting observation: a previously finalized/included record that now
    // reports a different ledger is treated as untrusted and left untouched.
    if (
      base.ledger !== null &&
      observation.ledger !== null &&
      base.ledger !== observation.ledger &&
      (base.state === TransactionFinalityState.FINALIZED ||
        base.state === TransactionFinalityState.INCLUDED)
    ) {
      this.logger.warn(
        `Conflicting ledger observation for ${txHash}: recorded ${base.ledger}, observed ${observation.ledger}`,
      );
      const next: TransactionFinalityRecord = {
        ...base,
        lastObservedAt: now,
        updatedAt: now,
      };
      return this.finalityRepository.save(next);
    }

    const nextState = this.resolveState(observation);
    const next: TransactionFinalityRecord = {
      ...base,
      state: nextState,
      ledger: observation.ledger ?? base.ledger,
      resultCode: observation.resultCode ?? base.resultCode,
      lastObservedAt: now,
      updatedAt: now,
    };
    return this.finalityRepository.save(next);
  }

  /**
   * Read the current verified finality state for a transaction.
   */
  async getFinality(txHash: string): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(txHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const record = await this.finalityRepository.find(txHash);
    if (record) {
      return record;
    }

    return {
      txHash,
      state: TransactionFinalityState.UNKNOWN,
      ledger: null,
      resultCode: null,
      replacementHashes: [],
      replacesHash: null,
      lastObservedAt: null,
      updatedAt: new Date(),
    };
  }

  /**
   * Link a fee-bump replacement hash to the logical transaction it replaces so
   * that the user-facing ledger records a single logical operation.
   */
  async recordReplacement(
    originalHash: string,
    replacementHash: string,
  ): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(originalHash) || !this.isValidTxHash(replacementHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const original =
      (await this.finalityRepository.find(originalHash)) ??
      (await this.recordAccepted(originalHash));

    const replacementHashes = original.replacementHashes.includes(replacementHash)
      ? original.replacementHashes
      : [...original.replacementHashes, replacementHash];

    const updated = await this.finalityRepository.save({
      ...original,
      replacementHashes,
      updatedAt: new Date(),
    });

    // Ensure the replacement hash resolves to the same logical record.
    const replacementRecord = await this.finalityRepository.find(replacementHash);
    await this.finalityRepository.save({
      txHash: replacementHash,
      state: replacementRecord?.state ?? TransactionFinalityState.ACCEPTED,
      ledger: replacementRecord?.ledger ?? null,
      resultCode: replacementRecord?.resultCode ?? null,
      replacementHashes: updated.replacementHashes,
      replacesHash: originalHash,
      lastObservedAt: replacementRecord?.lastObservedAt ?? null,
      updatedAt: new Date(),
    });

    return updated;
  }

  /**
   * Fetch a single observation from Horizon and classify its trustworthiness.
   */
  private async fetchObservation(txHash: string): Promise<TransactionObservation> {
    const observedAt = new Date();
    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          rpcConfig.rpcTimeoutMs,
        );

        let response: Response;
        try {
          response = await fetch(this.getHorizonTxUrl(txHash), {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (response.status === 404) {
          // Not yet visible: a delayed observation, not a failure.
          return {
            txHash,
            ledger: null,
            successful: null,
            resultCode: null,
            verified: false,
            reason: 'not_found',
            observedAt,
          };
        }

        if (!response.ok) {
          return {
            txHash,
            ledger: null,
            successful: null,
            resultCode: null,
            verified: false,
            reason: `http_${response.status}`,
            observedAt,
          };
        }

        const data: any = await response.json();
        const ledger =
          typeof data.ledger === 'number' && data.ledger > 0 ? data.ledger : null;
        const successful =
          typeof data.successful === 'boolean' ? data.successful : null;
        const resultCode =
          typeof data.result_code === 'string' ? data.result_code : null;

        // Evidence is only trusted when a ledger inclusion is reported.
        if (ledger === null || successful === null) {
          return {
            txHash,
            ledger,
            successful,
            resultCode,
            verified: false,
            reason: 'incomplete_evidence',
            observedAt,
          };
        }

        return {
          txHash,
          ledger,
          successful,
          resultCode,
          verified: true,
          observedAt,
        };
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
          this.logger.error(
            `Finality observation failed for ${txHash}: ${message}`,
          );
          return {
            txHash,
            ledger: null,
            successful: null,
            resultCode: null,
            verified: false,
            reason: 'rpc_error',
            observedAt,
          };
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    return {
      txHash,
      ledger: null,
      successful: null,
      resultCode: null,
      verified: false,
      reason: 'exhausted_retries',
      observedAt,
    };
  }

  /**
   * Map a verified observation to a finality state.
   */
  private resolveState(
    observation: TransactionObservation,
  ): TransactionFinalityState {
    if (!observation.verified || observation.ledger === null) {
      return TransactionFinalityState.UNKNOWN;
    }

    if (observation.successful === false) {
      return TransactionFinalityState.FAILED;
    }

    const currentLedger = this.getLatestKnownLedger(observation.ledger);
    const depth = currentLedger - observation.ledger + 1;
    if (depth >= this.confirmationDepth) {
      return TransactionFinalityState.FINALIZED;
    }
    return TransactionFinalityState.INCLUDED;
  }

  /**
   * Determine the latest ledger used to compute confirmation depth. The
   * observation's own ledger is the conservative lower bound; callers may
   * override via configuration for deterministic testing.
   */
  private getLatestKnownLedger(observedLedger: number): number {
    const configured = Number(
      this.configService.get<string | number>('STELLAR_LATEST_LEDGER', 0),
    );
    if (Number.isFinite(configured) && configured >= observedLedger) {
      return Math.floor(configured);
    }
    return observedLedger;
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
