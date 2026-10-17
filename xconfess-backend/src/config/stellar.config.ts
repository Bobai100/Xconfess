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

  // De-duplicate while preserving order so the primary endpoint stays first.
  return Array.from(new Set(endpoints));
}

export default registerAs('stellar', () => ({
  network: process.env.STELLAR_NETWORK || 'testnet',
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
  rpcRetryBaseDelayMs: Number(process.env.STELLAR_RPC_RETRY_BASE_DELAY_MS) || 1000,
  rpcRetryMaxDelayMs: Number(process.env.STELLAR_RPC_RETRY_MAX_DELAY_MS) || 10000,

  // Health-aware RPC failover settings
  // Ordered list of Soroban RPC endpoints; the first entry is the primary.
  rpcEndpoints: parseRpcEndpoints(),
  // How often the health monitor probes each endpoint (ms).
  rpcHealthProbeIntervalMs:
    Number(process.env.STELLAR_RPC_HEALTH_PROBE_INTERVAL_MS) || 30000,
  // Per-probe timeout for the health check (ms).
  rpcHealthProbeTimeoutMs:
    Number(process.env.STELLAR_RPC_HEALTH_PROBE_TIMEOUT_MS) || 5000,
  // Consecutive probe failures before an endpoint is marked unhealthy.
  rpcHealthFailureThreshold:
    Number(process.env.STELLAR_RPC_HEALTH_FAILURE_THRESHOLD) || 2,
  // Consecutive probe successes before an unhealthy endpoint is restored.
  rpcHealthRecoveryThreshold:
    Number(process.env.STELLAR_RPC_HEALTH_RECOVERY_THRESHOLD) || 2,
  // Cooldown before an unhealthy endpoint is eligible for probing again (ms).
  rpcCooldownMs: Number(process.env.STELLAR_RPC_COOLDOWN_MS) || 60000,

  // Bounded retry settings for read (idempotent) RPC calls.
  rpcReadMaxAttempts: Number(process.env.STELLAR_RPC_READ_MAX_ATTEMPTS) || 3,
  rpcReadRetryBaseDelayMs:
    Number(process.env.STELLAR_RPC_READ_RETRY_BASE_DELAY_MS) || 500,
  rpcReadRetryMaxDelayMs:
    Number(process.env.STELLAR_RPC_READ_RETRY_MAX_DELAY_MS) || 5000,

  // Bounded retry settings for submit (non-idempotent) RPC calls.
  // Submits are never blindly retried across endpoints; only a single
  // failover attempt is allowed and only when the prior attempt is known
  // not to have been accepted (e.g. connection refused before send).
  rpcSubmitMaxAttempts:
    Number(process.env.STELLAR_RPC_SUBMIT_MAX_ATTEMPTS) || 2,
  rpcSubmitRetryBaseDelayMs:
    Number(process.env.STELLAR_RPC_SUBMIT_RETRY_BASE_DELAY_MS) || 1000,
  rpcSubmitRetryMaxDelayMs:
    Number(process.env.STELLAR_RPC_SUBMIT_RETRY_MAX_DELAY_MS) || 5000,
  // When true, a submit may fail over to another healthy endpoint if the
  // previous attempt failed before the transaction could be broadcast.
  rpcSubmitFailoverEnabled:
    (process.env.STELLAR_RPC_SUBMIT_FAILOVER_ENABLED || 'true') === 'true',
}));