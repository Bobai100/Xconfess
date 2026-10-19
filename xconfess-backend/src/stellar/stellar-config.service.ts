// src/stellar/stellar-config.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSDK from '@stellar/stellar-sdk';
import {
  IStellarConfig,
  StellarNetwork,
} from './interfaces/stellar-config.interface';
import {
  DeploymentMetadata,
  DeploymentMetadataService,
} from './services/deployment-metadata.service';

/** Networks a Stellar endpoint, contract ID, or signer can belong to. */
export type DetectedNetwork = StellarNetwork | 'unknown';

/** Signer metadata validated as part of the network isolation unit. */
export interface SignerMetadata {
  /** Public key of the signer (G...). */
  publicKey?: string;
  /** Secret key of the signer (S...), if present in the environment. */
  secretKey?: string;
  /** Explicit network the signer was provisioned for, if declared. */
  network?: string;
}

export interface NetworkIsolationInput {
  network: StellarNetwork;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  contractIds?: Partial<IStellarConfig['contractIds']>;
  signer?: SignerMetadata;
}

export interface NetworkIsolationResult {
  network: StellarNetwork;
  horizonNetwork: DetectedNetwork;
  sorobanNetwork: DetectedNetwork;
  contractNetwork: DetectedNetwork;
  signerNetwork: DetectedNetwork;
}

const TESTNET_URL_MARKERS = ['testnet', 'horizon-testnet', 'soroban-rpc-testnet'];
const MAINNET_URL_MARKERS = ['horizon.stellar.org', 'soroban-rpc.stellar.org'];

/**
 * Derives the network implied by a Horizon or Soroban RPC URL. Returns
 * `'unknown'` when the URL does not carry a recognizable network marker.
 */
export function detectNetworkFromUrl(url?: string): DetectedNetwork {
  if (!url) {
    return 'unknown';
  }
  const normalized = url.toLowerCase();
  if (TESTNET_URL_MARKERS.some((marker) => normalized.includes(marker))) {
    return StellarNetwork.TESTNET;
  }
  if (MAINNET_URL_MARKERS.some((marker) => normalized.includes(marker))) {
    return StellarNetwork.MAINNET;
  }
  return 'unknown';
}

/**
 * Derives the network implied by a contract ID. Soroban contract IDs are
 * network-agnostic (C...), so this only reports a network when the ID embeds a
 * recognizable network marker (e.g. a testnet/mainnet prefix used by tooling).
 */
export function detectNetworkFromContractId(
  contractId?: string,
): DetectedNetwork {
  if (!contractId) {
    return 'unknown';
  }
  const normalized = contractId.toLowerCase();
  if (normalized.includes('testnet')) {
    return StellarNetwork.TESTNET;
  }
  if (normalized.includes('mainnet') || normalized.includes('public')) {
    return StellarNetwork.MAINNET;
  }
  return 'unknown';
}

/**
 * Derives the network implied by signer metadata. An explicit `network` field
 * wins; otherwise a secret key prefixed with `S` is treated as network-agnostic
 * and reported as `'unknown'`.
 */
export function detectNetworkFromSigner(
  signer?: SignerMetadata,
): DetectedNetwork {
  if (!signer) {
    return 'unknown';
  }
  if (signer.network) {
    const normalized = signer.network.toLowerCase();
    if (normalized === StellarNetwork.MAINNET || normalized === 'public') {
      return StellarNetwork.MAINNET;
    }
    if (normalized === StellarNetwork.TESTNET) {
      return StellarNetwork.TESTNET;
    }
  }
  return 'unknown';
}

/**
 * Validates network, endpoints, contract IDs, and signer metadata as a single
 * configuration unit. Throws when any component belongs to a different network
 * than the configured one, preventing a production signer from pointing at
 * testnet endpoints or a testnet secret from being used with mainnet contracts.
 */
export function validateNetworkIsolation(
  input: NetworkIsolationInput,
): NetworkIsolationResult {
  const { network } = input;
  const horizonNetwork = detectNetworkFromUrl(input.horizonUrl);
  const sorobanNetwork = detectNetworkFromUrl(input.sorobanRpcUrl);

  const contractNetworks = Object.values(input.contractIds ?? {})
    .map((id) => detectNetworkFromContractId(id))
    .filter((detected): detected is StellarNetwork => detected !== 'unknown');
  const contractNetwork: DetectedNetwork =
    contractNetworks.length > 0 ? contractNetworks[0] : 'unknown';

  const signerNetwork = detectNetworkFromSigner(input.signer);

  const conflicts: string[] = [];
  const check = (label: string, detected: DetectedNetwork) => {
    if (detected !== 'unknown' && detected !== network) {
      conflicts.push(`${label} implies "${detected}"`);
    }
  };

  check('Horizon URL', horizonNetwork);
  check('Soroban RPC URL', sorobanNetwork);
  check('Contract ID', contractNetwork);
  check('Signer metadata', signerNetwork);

  if (conflicts.length > 0) {
    throw new Error(
      `Stellar network isolation violation: configured network is "${network}" but ${conflicts.join(
        '; ',
      )}. Refusing to boot with mixed testnet/mainnet configuration.`,
    );
  }

  return { network, horizonNetwork, sorobanNetwork, contractNetwork, signerNetwork };
}

@Injectable()
export class StellarConfigService implements OnModuleInit {
  private readonly logger = new Logger(StellarConfigService.name);
  private config: IStellarConfig & {
    maxFeeBudget: number;
    feeBackoffMs: number;
    maxFeeRetries: number;
    rpcTimeoutMs: number;
    rpcMaxRetries: number;
    rpcRetryBaseDelayMs: number;
    rpcRetryMaxDelayMs: number;
    rpcEndpoints: string[];
    rpcHealthCheckIntervalMs: number;
    rpcCooldownMs: number;
    rpcFailureThreshold: number;
    rpcRecoveryProbeTimeoutMs: number;
  };
  private server: StellarSDK.Horizon.Server;

  /** Maps a configured contract field to its deployment metadata contract name. */
  private readonly contractMetadataKeys: Record<
    keyof IStellarConfig['contractIds'],
    string
  > = {
    confessionAnchor: 'confession-anchor',
    reputationBadges: 'reputation-badges',
    tippingSystem: 'anonymous-tipping',
  };

  constructor(
    private configService: ConfigService,
    private deploymentMetadataService: DeploymentMetadataService,
  ) {
    this.initializeConfig();
  }

  onModuleInit(): void {
    this.applyDeploymentMetadataFallback();
  }

  private initializeConfig() {
    // Validate network
    const network = this.configService.get<StellarNetwork>(
      'STELLAR_NETWORK',
      StellarNetwork.TESTNET,
    );
    if (!Object.values(StellarNetwork).includes(network)) {
      throw new Error(`Invalid network: ${network}`);
    }

    // Load fee/backoff policy
    const maxFeeBudget = Number(
      this.configService.get('STELLAR_MAX_FEE_BUDGET') ?? 100,
    );
    const feeBackoffMs = Number(
      this.configService.get('STELLAR_FEE_BACKOFF_MS') ?? 5000,
    );
    const maxFeeRetries = Number(
      this.configService.get('STELLAR_MAX_FEE_RETRIES') ?? 3,
    );

    // Load RPC timeout and retry policy
    const rpcTimeoutMs = Number(
      this.configService.get('STELLAR_RPC_TIMEOUT_MS') ?? 15000,
    );
    const rpcMaxRetries = Number(
      this.configService.get('STELLAR_RPC_MAX_RETRIES') ?? 3,
    );
    const rpcRetryBaseDelayMs = Number(
      this.configService.get('STELLAR_RPC_RETRY_BASE_DELAY_MS') ?? 1000,
    );
    const rpcRetryMaxDelayMs = Number(
      this.configService.get('STELLAR_RPC_RETRY_MAX_DELAY_MS') ?? 10000,
    );

    // Load RPC endpoint pool and health/cooldown policy
    const rpcEndpoints = this.getSorobanRpcEndpoints(network);
    const rpcHealthCheckIntervalMs = Number(
      this.configService.get('STELLAR_RPC_HEALTH_CHECK_INTERVAL_MS') ?? 30000,
    );
    const rpcCooldownMs = Number(
      this.configService.get('STELLAR_RPC_COOLDOWN_MS') ?? 60000,
    );
    const rpcFailureThreshold = Number(
      this.configService.get('STELLAR_RPC_FAILURE_THRESHOLD') ?? 2,
    );
    const rpcRecoveryProbeTimeoutMs = Number(
      this.configService.get('STELLAR_RPC_RECOVERY_PROBE_TIMEOUT_MS') ?? 5000,
    );

    // Build config
    this.config = {
      network,
      horizonUrl: this.getHorizonUrl(network),
      networkPassphrase: this.getNetworkPassphrase(network),
      sorobanRpcUrl: this.getSorobanRpcUrl(network),
      contractIds: {
        confessionAnchor: this.configService.get(
          'CONFESSION_ANCHOR_CONTRACT_ID',
        ),
        reputationBadges: this.configService.get(
          'REPUTATION_BADGES_CONTRACT_ID',
        ),
        tippingSystem: this.configService.get('TIPPING_SYSTEM_CONTRACT_ID'),
      },
      maxFeeBudget,
      feeBackoffMs,
      maxFeeRetries,
      rpcTimeoutMs,
      rpcMaxRetries,
      rpcRetryBaseDelayMs,
      rpcRetryMaxDelayMs,
      rpcEndpoints,
      rpcHealthCheckIntervalMs,
      rpcCooldownMs,
      rpcFailureThreshold,
      rpcRecoveryProbeTimeoutMs,
    };

    // Enforce testnet/mainnet isolation across endpoints, contracts, and signer
    validateNetworkIsolation({
      network,
      horizonUrl: this.config.horizonUrl,
      sorobanRpcUrl: this.config.sorobanRpcUrl,
      contractIds: this.config.contractIds,
      signer: this.getSignerMetadata(),
    });

    // Initialize Horizon server
    this.server = new StellarSDK.Horizon.Server(this.config.horizonUrl);

    this.logger.log(`Stellar configured for ${network}`);
    this.logger.log(`Horizon URL: ${this.config.horizonUrl}`);
    this.logger.log(
      `Fee budget: ${maxFeeBudget}, Backoff: ${feeBackoffMs}ms, Max retries: ${maxFeeRetries}`,
    );
    this.logger.log(
      `RPC timeout: ${rpcTimeoutMs}ms, RPC retries: ${rpcMaxRetries}, Retry backoff: ${rpcRetryBaseDelayMs}-${rpcRetryMaxDelayMs}ms`,
    );
    this.logger.log(
      `RPC endpoints (${rpcEndpoints.length}): ${rpcEndpoints.join(', ')}`,
    );
    this.logger.log(
      `RPC health policy: check interval ${rpcHealthCheckIntervalMs}ms, cooldown ${rpcCooldownMs}ms, failure threshold ${rpcFailureThreshold}, recovery probe timeout ${rpcRecoveryProbeTimeoutMs}ms`,
    );
  }

  private getSignerMetadata(): SignerMetadata {
    return {
      publicKey: this.configService.get<string>('STELLAR_SIGNER_PUBLIC_KEY'),
      secretKey: this.configService.get<string>('STELLAR_SIGNER_SECRET_KEY'),
      network: this.configService.get<string>('STELLAR_SIGNER_NETWORK'),
    };
  }

  private applyDeploymentMetadataFallback(): void {
    const metadata = this.deploymentMetadataService.getMetadata();
    if (!metadata) {
      this.logger.warn(
        'Deployment metadata not available for fallback contract IDs',
      );
    }

    const fallbackIds = this.deploymentMetadataService.getAllContractIds();
    const explicitContractIds = { ...this.config.contractIds };
    this.config.contractIds = {
      confessionAnchor:
        explicitContractIds.confessionAnchor || fallbackIds['confession-anchor'],
      reputationBadges:
        explicitContractIds.reputationBadges || fallbackIds['reputation-badges'],
      tippingSystem:
        explicitContractIds.tippingSystem || fallbackIds['anonymous-tipping'],
    };

    const featuresEnabled =
      this.configService.get<string>('STELLAR_FEATURES_ENABLED') === 'true';

    if (featuresEnabled && metadata) {
      this.validateContractIdsAgainstNetwork(metadata, explicitContractIds);
    }

    // Re-validate isolation now that contract IDs may have been resolved from
    // deployment metadata, so a metadata-sourced ID cannot smuggle in a
    // cross-network combination.
    validateNetworkIsolation({
      network: this.config.network,
      horizonUrl: this.config.horizonUrl,
      sorobanRpcUrl: this.config.sorobanRpcUrl,
      contractIds: this.config.contractIds,
      signer: this.getSignerMetadata(),
    });

    const missingContractIds = Object.entries(this.config.contractIds)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (featuresEnabled && missingContractIds.length > 0) {
      throw new Error(
        `Stellar features are enabled but missing contract IDs: ${missingContractIds.join(
          ', ',
        )}. Provide contract IDs through environment variables or deployment metadata.
        `,
      );
    }
  }

  /**
   * Ensure deployment metadata belongs to the configured network, and that any
   * explicitly-configured (env var) contract ID agrees with that network's
   * deployment metadata. Prevents e.g. a testnet config accidentally loading
   * mainnet deployment metadata, or an env var left over from another network.
   */
  private validateContractIdsAgainstNetwork(
    metadata: DeploymentMetadata,
    explicitContractIds: IStellarConfig['contractIds'],
  ): void {
    if (metadata.network !== this.config.network) {
      throw new Error(
        `Deployment metadata network mismatch: configured Stellar network is "${this.config.network}" but the loaded deployment metadata was generated for "${metadata.network}". Refusing to boot with mismatched network deployment metadata.`,
      );
    }

    const mismatches = (
      Object.keys(explicitContractIds) as Array<keyof IStellarConfig['contractIds']>
    ).filter((field) => {
      const explicitId = explicitContractIds[field];
      const metadataId = metadata.contracts[this.contractMetadataKeys[field]]?.contract_id;
      return !!explicitId && !!metadataId && explicitId !== metadataId;
    });

    if (mismatches.length > 0) {
      throw new Error(
        `Stellar contract ID mismatch for network "${this.config.network}": ${mismatches.join(
          ', ',
        )} do not match the ID recorded in deployment metadata. Verify contract ID environment variables are configured for the correct network.`,
      );
    }
  }

  getConfig() {
    return { ...this.config, rpcEndpoints: [...this.config.rpcEndpoints] };
  }

  /**
   * Ordered list of configured Soroban RPC endpoints (primary first). Consumers
   * performing failover should treat this as the candidate pool.
   */
  getSorobanRpcEndpointsList(): string[] {
    return [...this.config.rpcEndpoints];
  }

  /**
   * Health/cooldown policy for the RPC endpoint pool. Exposed so the failover
   * client can apply consistent thresholds across read and submit paths.
   */
  getRpcHealthPolicy(): {
    timeoutMs: number;
    healthCheckIntervalMs: number;
    cooldownMs: number;
    failureThreshold: number;
    recoveryProbeTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  } {
    return {
      timeoutMs: this.config.rpcTimeoutMs,
      healthCheckIntervalMs: this.config.rpcHealthCheckIntervalMs,
      cooldownMs: this.config.rpcCooldownMs,
      failureThreshold: this.config.rpcFailureThreshold,
      recoveryProbeTimeoutMs: this.config.rpcRecoveryProbeTimeoutMs,
      maxRetries: this.config.rpcMaxRetries,
      retryBaseDelayMs: this.config.rpcRetryBaseDelayMs,
      retryMaxDelayMs: this.config.rpcRetryMaxDelayMs,
    };
  }

  getServer(): StellarSDK.Horizon.Server {
    return this.server;
  }

  getNetwork(): string {
    return this.config.network === StellarNetwork.MAINNET
      ? StellarSDK.Networks.PUBLIC
      : StellarSDK.Networks.TESTNET;
  }

  private getHorizonUrl(network: StellarNetwork): string {
    return network === StellarNetwork.MAINNET
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
  }

  private getNetworkPassphrase(network: StellarNetwork): string {
    return network === StellarNetwork.MAINNET
      ? StellarSDK.Networks.PUBLIC
      : StellarSDK.Networks.TESTNET;
  }

  private getSorobanRpcUrl(network: StellarNetwork): string {
    return network === StellarNetwork.MAINNET
      ? 'https://soroban-rpc.stellar.org'
      : 'https://soroban-rpc-testnet.stellar.org';
  }

  /**
   * Resolve the ordered RPC endpoint pool. `STELLAR_SOROBAN_RPC_URLS` accepts a
   * comma-separated list of endpoints (primary first); `STELLAR_SOROBAN_RPC_URL`
   * remains supported as a single-endpoint override. Falls back to the network
   * default when neither is configured.
   */
  private getSorobanRpcEndpoints(network: StellarNetwork): string[] {
    const listValue = this.configService.get<string>(
      'STELLAR_SOROBAN_RPC_URLS',
    );
    const singleValue = this.configService.get<string>(
      'STELLAR_SOROBAN_RPC_URL',
    );

    const raw = listValue?.trim()
      ? listValue.split(',')
      : singleValue?.trim()
        ? [singleValue]
        : [];

    const endpoints = raw
      .map((url) => url.trim())
      .filter((url) => url.length > 0);

    const deduped = Array.from(new Set(endpoints));

    if (deduped.length === 0) {
      return [this.getSorobanRpcUrl(network)];
    }

    return deduped;
  }

  isMainnet(): boolean {
    return this.config.network === StellarNetwork.MAINNET;
  }

  getContractId(
    contractName: 'confessionAnchor' | 'reputationBadges' | 'tippingSystem',
  ): string {
    const id = this.config.contractIds[contractName];
    if (!id) {
      throw new Error(`Contract ID for ${contractName} not configured`);
    }
    return id;
  }
}
