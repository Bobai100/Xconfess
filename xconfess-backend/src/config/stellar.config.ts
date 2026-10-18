// src/config/stellar.config.ts
// Loads Stellar config from environment for NestJS ConfigModule
import { registerAs } from '@nestjs/config';

/**
 * Parse a comma-separated list of Stellar Soroban RPC endpoints.
 * Falls back to the single `STELLAR_SOROBAN_RPC_URL` (or the public testnet
 * default) when no explicit endpoint list is configured.
 */
function parseRpcEndpoints(): string[] {
  const raw = process.env.STELLAR_SOROBAN_RPC_URLS;
  const fallback =
    process.env.STELLAR_SOROBAN_RPC_URL ||
    'https://soroban-rpc-testnet.stellar.org';

  const endpoints = (raw ? raw.split(',') : [])
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  if (endpoints.length === 0) {
    endpoints.push(fallback);
  }

  return Array.from(new Set(endpoints));
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

/**
 * Bounded label enums for transaction latency/failure metrics.
 * These labels are intentionally closed sets so that metric cardinality
 * remains bounded and safe for aggregation.
 */
export enum StellarNetworkLabel {
  TESTNET = 'testnet',
  MAINNET = 'mainnet',
  FUTURENET = 'futurenet',
}

export enum StellarOperationClass {
  ANCHOR = 'anchor',
  REPUTATION = 'reputation',
  TIPPING = 'tipping',
  OTHER = 'other',
}

export enum StellarTransactionPhase {
  SUBMISSION = 'submission',
  INCLUSION = 'inclusion',
  CONFIRMATION = 'confirmation',
}

export const STELLAR_NETWORK_LABELS: readonly StellarNetworkLabel[] =
  Object.freeze([
    StellarNetworkLabel.TESTNET,
    StellarNetworkLabel.MAINNET,
    StellarNetworkLabel.FUTURENET,
  ]);

export const STELLAR_OPERATION_CLASSES: readonly StellarOperationClass[] =
  Object.freeze([
    StellarOperationClass.ANCHOR,
    StellarOperationClass.REPUTATION,
    StellarOperationClass.TIPPING,
    StellarOperationClass.OTHER,
  ]);

export const STELLAR_TRANSACTION_PHASES: readonly StellarTransactionPhase[] =
  Object.freeze([
    StellarTransactionPhase.SUBMISSION,
    StellarTransactionPhase.INCLUSION,
    StellarTransactionPhase.CONFIRMATION,
  ]);

/**
 * Latency budget (in milliseconds) for a single transaction phase.
 */
export interface PhaseLatencyBudget {
  /** Maximum acceptable latency (ms) before the phase is considered degraded. */
  latencyMs: number;
  /** Maximum acceptable failure rate (0..1) before the phase is considered degraded. */
  failureRate: number;
}

/**
 * Per-network transaction budget covering all phases.
 */
export interface NetworkTransactionBudget {
  submission: PhaseLatencyBudget;
  inclusion: PhaseLatencyBudget;
  confirmation: PhaseLatencyBudget;
}

export type TransactionLatencyBudgets = Record<
  StellarNetworkLabel,
  NetworkTransactionBudget
>;

const DEFAULT_BUDGETS: TransactionLatencyBudgets = {
  [StellarNetworkLabel.TESTNET]: {
    submission: { latencyMs: 5000, failureRate: 0.1 },
    inclusion: { latencyMs: 15000, failureRate: 0.1 },
    confirmation: { latencyMs: 30000, failureRate: 0.1 },
  },
  [StellarNetworkLabel.MAINNET]: {
    submission: { latencyMs: 3000, failureRate: 0.05 },
    inclusion: { latencyMs: 10000, failureRate: 0.05 },
    confirmation: { latencyMs: 20000, failureRate: 0.05 },
  },
  [StellarNetworkLabel.FUTURENET]: {
    submission: { latencyMs: 5000, failureRate: 0.1 },
    inclusion: { latencyMs: 15000, failureRate: 0.1 },
    confirmation: { latencyMs: 30000, failureRate: 0.1 },
  },
};

function parsePositiveNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid stellar config: ${name} must be a positive number, received "${raw}"`,
    );
  }
  return parsed;
}

function parseFailureRate(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `Invalid stellar config: ${name} must be a number between 0 and 1, received "${raw}"`,
    );
  }
  return parsed;
}

function resolveNetworkLabel(raw: string | undefined): StellarNetworkLabel {
  const normalized = (raw || 'testnet').toLowerCase();
  switch (normalized) {
    case StellarNetworkLabel.MAINNET:
      return StellarNetworkLabel.MAINNET;
    case StellarNetworkLabel.FUTURENET:
      return StellarNetworkLabel.FUTURENET;
    case StellarNetworkLabel.TESTNET:
    default:
      return StellarNetworkLabel.TESTNET;
  }
}

function buildNetworkBudget(
  network: StellarNetworkLabel,
): NetworkTransactionBudget {
  const defaults = DEFAULT_BUDGETS[network];
  const prefix = `STELLAR_${network.toUpperCase()}`;
  return {
    submission: {
      latencyMs: parsePositiveNumber(
        process.env[`${prefix}_SUBMISSION_LATENCY_BUDGET_MS`],
        defaults.submission.latencyMs,
        `${prefix}_SUBMISSION_LATENCY_BUDGET_MS`,
      ),
      failureRate: parseFailureRate(
        process.env[`${prefix}_SUBMISSION_FAILURE_RATE_BUDGET`],
        defaults.submission.failureRate,
        `${prefix}_SUBMISSION_FAILURE_RATE_BUDGET`,
      ),
    },
    inclusion: {
      latencyMs: parsePositiveNumber(
        process.env[`${prefix}_INCLUSION_LATENCY_BUDGET_MS`],
        defaults.inclusion.latencyMs,
        `${prefix}_INCLUSION_LATENCY_BUDGET_MS`,
      ),
      failureRate: parseFailureRate(
        process.env[`${prefix}_INCLUSION_FAILURE_RATE_BUDGET`],
        defaults.inclusion.failureRate,
        `${prefix}_INCLUSION_FAILURE_RATE_BUDGET`,
      ),
    },
    confirmation: {
      latencyMs: parsePositiveNumber(
        process.env[`${prefix}_CONFIRMATION_LATENCY_BUDGET_MS`],
        defaults.confirmation.latencyMs,
        `${prefix}_CONFIRMATION_LATENCY_BUDGET_MS`,
      ),
      failureRate: parseFailureRate(
        process.env[`${prefix}_CONFIRMATION_FAILURE_RATE_BUDGET`],
        defaults.confirmation.failureRate,
        `${prefix}_CONFIRMATION_FAILURE_RATE_BUDGET`,
      ),
    },
  };
}

/**
 * Validates that all latency/failure thresholds in the provided budgets are
 * positive numbers (latency) or valid rates (0..1).
 */
export function validateTransactionLatencyBudgets(
  budgets: TransactionLatencyBudgets,
): void {
  for (const network of STELLAR_NETWORK_LABELS) {
    const budget = budgets[network];
    if (!budget) {
      throw new Error(`Missing transaction budget for network "${network}"`);
    }
    for (const phase of STELLAR_TRANSACTION_PHASES) {
      const phaseBudget = budget[phase];
      if (!phaseBudget) {
        throw new Error(
          `Missing transaction budget for network "${network}" phase "${phase}"`,
        );
      }
      if (
        !Number.isFinite(phaseBudget.latencyMs) ||
        phaseBudget.latencyMs <= 0
      ) {
        throw new Error(
          `Invalid latency budget for network "${network}" phase "${phase}": must be a positive number`,
        );
      }
      if (
        !Number.isFinite(phaseBudget.failureRate) ||
        phaseBudget.failureRate < 0 ||
        phaseBudget.failureRate > 1
      ) {
        throw new Error(
          `Invalid failure rate budget for network "${network}" phase "${phase}": must be between 0 and 1`,
        );
      }
    }
  }
}

export default registerAs('stellar', () => {
  const network = resolveNetworkLabel(process.env.STELLAR_NETWORK);

  const transactionLatencyBudgets: TransactionLatencyBudgets = {
    [StellarNetworkLabel.TESTNET]: buildNetworkBudget(
      StellarNetworkLabel.TESTNET,
    ),
    [StellarNetworkLabel.MAINNET]: buildNetworkBudget(
      StellarNetworkLabel.MAINNET,
    ),
    [StellarNetworkLabel.FUTURENET]: buildNetworkBudget(
      StellarNetworkLabel.FUTURENET,
    ),
  };

  validateTransactionLatencyBudgets(transactionLatencyBudgets);

  return {
    network,
    horizonUrl:
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl:
      process.env.STELLAR_SOROBAN_RPC_URL ||
      'https://soroban-rpc-testnet.stellar.org',
    confessionAnchorContractId: process.env.CONFESSION_ANCHOR_CONTRACT_ID,
    reputationBadgesContractId: process.env.REPUTATION_BADGES_CONTRACT_ID,
    tippingSystemContractId: process.env.TIPPING_SYSTEM_CONTRACT_ID,
    serverSecret: process.env.STELLAR_SERVER_SECRET,

    // Fee guard and backoff settings
    maxFeeBudget: Number(process.env.STELLAR_MAX_FEE_BUDGET) || 100, // in stroops
    feeBackoffMs: Number(process.env.STELLAR_FEE_BACKOFF_MS) || 5000, // ms
    maxFeeRetries: Number(process.env.STELLAR_MAX_FEE_RETRIES) || 3,

    // RPC call timeout and retry settings
    rpcTimeoutMs: Number(process.env.STELLAR_RPC_TIMEOUT_MS) || 15000, // 15s default
    rpcMaxRetries: Number(process.env.STELLAR_RPC_MAX_RETRIES) || 3,
    rpcRetryBaseDelayMs:
      Number(process.env.STELLAR_RPC_RETRY_BASE_DELAY_MS) || 1000,
    rpcRetryMaxDelayMs:
      Number(process.env.STELLAR_RPC_RETRY_MAX_DELAY_MS) || 10000,

    eventVerifier: {
      enabled: parseBoolean(process.env.STELLAR_EVENT_VERIFIER_ENABLED, false),
      maxLedgerRange:
        Number(process.env.STELLAR_EVENT_VERIFIER_MAX_LEDGER_RANGE) || 1000,
      reprocessingBatchSize:
        Number(process.env.STELLAR_EVENT_VERIFIER_REPROCESSING_BATCH_SIZE) || 100,
      scheduleCron:
        process.env.STELLAR_EVENT_VERIFIER_SCHEDULE_CRON || '*/15 * * * *',
    },

    // Health-aware RPC failover settings.
    rpcEndpoints: parseRpcEndpoints(),
    rpcHealthProbeIntervalMs:
      Number(process.env.STELLAR_RPC_HEALTH_PROBE_INTERVAL_MS) || 30000,
    rpcHealthProbeTimeoutMs:
      Number(process.env.STELLAR_RPC_HEALTH_PROBE_TIMEOUT_MS) || 5000,
    rpcHealthFailureThreshold:
      Number(process.env.STELLAR_RPC_HEALTH_FAILURE_THRESHOLD) || 2,
    rpcHealthRecoveryThreshold:
      Number(process.env.STELLAR_RPC_HEALTH_RECOVERY_THRESHOLD) || 2,
    rpcCooldownMs: Number(process.env.STELLAR_RPC_COOLDOWN_MS) || 60000,

    // Read calls are idempotent and may retry across healthy endpoints.
    rpcReadMaxAttempts: Number(process.env.STELLAR_RPC_READ_MAX_ATTEMPTS) || 3,
    rpcReadRetryBaseDelayMs:
      Number(process.env.STELLAR_RPC_READ_RETRY_BASE_DELAY_MS) || 500,
    rpcReadRetryMaxDelayMs:
      Number(process.env.STELLAR_RPC_READ_RETRY_MAX_DELAY_MS) || 5000,

    // Writes only fail over when the previous endpoint did not accept them.
    rpcSubmitMaxAttempts:
      Number(process.env.STELLAR_RPC_SUBMIT_MAX_ATTEMPTS) || 2,
    rpcSubmitRetryBaseDelayMs:
      Number(process.env.STELLAR_RPC_SUBMIT_RETRY_BASE_DELAY_MS) || 1000,
    rpcSubmitRetryMaxDelayMs:
      Number(process.env.STELLAR_RPC_SUBMIT_RETRY_MAX_DELAY_MS) || 5000,
    rpcSubmitFailoverEnabled:
      (process.env.STELLAR_RPC_SUBMIT_FAILOVER_ENABLED || 'true') === 'true',

    // Network-specific transaction latency and failure budgets
    transactionLatencyBudgets,
  };
});
