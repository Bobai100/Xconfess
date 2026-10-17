// src/config/stellar.config.ts
// Loads Stellar config from environment for NestJS ConfigModule
import { registerAs } from '@nestjs/config';

/**
 * Parse a positive integer from an environment variable.
 * Falls back to the provided default when the value is missing or invalid.
 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
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

  // Ledger finality / confirmation settings.
  // A transaction is only treated as FINALIZED once it has been observed in a
  // ledger that is at least `stellarConfirmationDepth` ledgers behind the
  // current ledger head. Defaults to 1 (included in a closed ledger).
  stellarConfirmationDepth: parsePositiveInt(
    process.env.STELLAR_CONFIRMATION_DEPTH,
    1,
  ),
  // How often (in ms) the finality tracker polls Horizon/RPC for updated
  // transaction and ledger state while a transaction is pending confirmation.
  stellarFinalityPollIntervalMs: parsePositiveInt(
    process.env.STELLAR_FINALITY_POLL_INTERVAL_MS,
    5000,
  ),
  // Maximum age (in ms) a transaction may remain in a non-terminal state
  // (accepted/included) before it is surfaced as UNKNOWN to users. Prevents
  // transactions from being stuck indefinitely when RPC observations are
  // delayed or conflicting.
  stellarFinalityMaxAgeMs: parsePositiveInt(
    process.env.STELLAR_FINALITY_MAX_AGE_MS,
    300000, // 5 minutes
  ),
}));