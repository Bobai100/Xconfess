#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DEPLOYMENT_FILE = path.join(ROOT, 'deployments', 'testnet.json');
const DEFAULT_TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_MAINNET_HORIZON_URL = 'https://horizon.stellar.org';
const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const SHA256_REGEX = /^[a-fA-F0-9]{64}$/;
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

// Canonical network identifiers, their passphrases, and the Horizon endpoints
// that belong to each network. Used to enforce testnet/mainnet isolation.
const NETWORK_PROFILES = {
  testnet: {
    passphrase: 'Test SDF Network ; September 2015',
    horizonHosts: ['horizon-testnet.stellar.org'],
    horizonHostSuffixes: ['testnet.stellar.org'],
    friendbot: 'https://friendbot.stellar.org',
  },
  mainnet: {
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonHosts: ['horizon.stellar.org'],
    horizonHostSuffixes: [],
    friendbot: null,
  },
};
const NETWORK_ALIASES = new Map([
  ['testnet', 'testnet'],
  ['test', 'testnet'],
  ['futurenet', 'testnet'],
  ['mainnet', 'mainnet'],
  ['public', 'mainnet'],
  ['pubnet', 'mainnet'],
]);

/**
 * Normalizes a network name to its canonical form ('testnet' | 'mainnet').
 * @param {string} value
 * @returns {string|null} canonical network or null when unrecognized
 */
function normalizeNetwork(value) {
  if (value === undefined || value === null) return null;
  return NETWORK_ALIASES.get(String(value).trim().toLowerCase()) || null;
}

/**
 * Determines which network a Horizon URL belongs to based on its host.
 * @param {string} url
 * @returns {string|null} canonical network or null when unrecognized
 */
function networkForHorizonUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (error) {
    return null;
  }
  for (const [network, profile] of Object.entries(NETWORK_PROFILES)) {
    if (profile.horizonHosts.includes(host)) return network;
    if (profile.horizonHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return network;
    }
  }
  return null;
}

/**
 * Validates that network, endpoint, contract IDs, and signer metadata form one
 * consistent configuration unit. Any cross-network combination is a failure.
 *
 * @param {object} params
 * @param {object} params.deploymentData - Parsed deployment metadata
 * @param {object} params.env - Environment variables (defaults to process.env)
 * @param {string} [params.deploymentLabel] - Human readable metadata path
 * @param {string} [params.derivedPublicKey] - Public key derived from the signer secret
 * @returns {{ failures: string[], warnings: string[], network: string|null }}
 */
function validateNetworkIsolation({
  deploymentData,
  env = process.env,
  deploymentLabel = 'deployment metadata',
  derivedPublicKey = null,
}) {
  const failures = [];
  const warnings = [];

  const metadataNetwork = normalizeNetwork(deploymentData && deploymentData.network);
  if (deploymentData && deploymentData.network && !metadataNetwork) {
    failures.push(
      `${deploymentLabel} declares unsupported network "${deploymentData.network}". ` +
        'Expected one of: testnet, mainnet (aliases: test, futurenet, public, pubnet).',
    );
  }

  const configuredNetworkRaw = env.STELLAR_NETWORK;
  const configuredNetwork = normalizeNetwork(configuredNetworkRaw);
  if (configuredNetworkRaw && !configuredNetwork) {
    failures.push(
      `STELLAR_NETWORK (${configuredNetworkRaw}) is not a recognized network. ` +
        'Expected one of: testnet, mainnet (aliases: test, futurenet, public, pubnet).',
    );
  }

  if (configuredNetwork && metadataNetwork && configuredNetwork !== metadataNetwork) {
    failures.push(
      `STELLAR_NETWORK (${configuredNetworkRaw}) does not match ${deploymentLabel} network (${deploymentData.network}). ` +
        'Refusing to mix testnet and mainnet configuration.',
    );
  }

  const effectiveNetwork = configuredNetwork || metadataNetwork || null;

  // Endpoint isolation: Horizon URL must belong to the effective network.
  const horizonUrl = env.STELLAR_HORIZON_URL;
  if (horizonUrl) {
    const horizonNetwork = networkForHorizonUrl(horizonUrl);
    if (!horizonNetwork) {
      failures.push(
        `STELLAR_HORIZON_URL (${horizonUrl}) is not a recognized Stellar Horizon endpoint. ` +
          `Use ${DEFAULT_TESTNET_HORIZON_URL} for testnet or ${DEFAULT_MAINNET_HORIZON_URL} for mainnet.`,
      );
    } else if (effectiveNetwork && horizonNetwork !== effectiveNetwork) {
      failures.push(
        `STELLAR_HORIZON_URL (${horizonUrl}) belongs to ${horizonNetwork} but the configured network is ${effectiveNetwork}. ` +
          'Refusing to point a signer at a Horizon endpoint from another network.',
      );
    }
  }

  // Network passphrase isolation.
  const passphrase = env.STELLAR_NETWORK_PASSPHRASE;
  if (passphrase && effectiveNetwork) {
    const expectedPassphrase = NETWORK_PROFILES[effectiveNetwork].passphrase;
    if (passphrase !== expectedPassphrase) {
      failures.push(
        `STELLAR_NETWORK_PASSPHRASE does not match the ${effectiveNetwork} network passphrase. ` +
          `Expected "${expectedPassphrase}".`,
      );
    }
  }

  // Signer metadata isolation: a signer must not be shared across networks.
  const signerNetworkRaw = env.STELLAR_SIGNER_NETWORK;
  const signerNetwork = normalizeNetwork(signerNetworkRaw);
  if (signerNetworkRaw && !signerNetwork) {
    failures.push(
      `STELLAR_SIGNER_NETWORK (${signerNetworkRaw}) is not a recognized network. ` +
        'Expected one of: testnet, mainnet (aliases: test, futurenet, public, pubnet).',
    );
  } else if (signerNetwork && effectiveNetwork && signerNetwork !== effectiveNetwork) {
    failures.push(
      `STELLAR_SIGNER_NETWORK (${signerNetworkRaw}) does not match the configured network (${effectiveNetwork}). ` +
        'A signer provisioned for one network must not be used on another.',
    );
  }

  // Contract ID isolation: metadata contract IDs must be tagged for the same network.
  const contracts = (deploymentData && deploymentData.contracts) || {};
  for (const [name, contract] of Object.entries(contracts)) {
    if (!contract || typeof contract !== 'object') continue;
    const contractNetworkRaw = contract.network;
    if (contractNetworkRaw === undefined || contractNetworkRaw === null) continue;
    const contractNetwork = normalizeNetwork(contractNetworkRaw);
    if (!contractNetwork) {
      failures.push(
        `Contract "${name}" declares unsupported network "${contractNetworkRaw}". ` +
          'Expected one of: testnet, mainnet (aliases: test, futurenet, public, pubnet).',
      );
    } else if (effectiveNetwork && contractNetwork !== effectiveNetwork) {
      failures.push(
        `Contract "${name}" is tagged for ${contractNetwork} but the configured network is ${effectiveNetwork}. ` +
          'Refusing to deploy cross-network contract IDs.',
      );
    }
  }

  if (derivedPublicKey && effectiveNetwork === 'mainnet' && isTruthy(env.STELLAR_FEATURES_ENABLED)) {
    warnings.push(
      `Signer ${derivedPublicKey} will be used against Stellar mainnet. ` +
        'Confirm this is intentional and that the secret is stored in a production-only secret manager.',
    );
  }

  return { failures, warnings, network: effectiveNetwork };
}

/**
 * Validates the structural shape and schema integrity of deployment metadata (#1738).
 * @param {object} data - Parsed deployment metadata JSON object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDeploymentMetadataSchema(data) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Deployment metadata must be a non-null object.'] };
  }

  if (!data.network || typeof data.network !== 'string') {
    errors.push('Metadata missing valid "network" string field.');
  }

  if (!data.generated_at_utc || typeof data.generated_at_utc !== 'string') {
    errors.push('Metadata missing "generated_at_utc" timestamp string.');
  } else if (isNaN(Date.parse(data.generated_at_utc))) {
    errors.push('"generated_at_utc" must be a valid ISO 8601 UTC date string.');
  }

  if (!data.contracts || typeof data.contracts !== 'object' || Object.keys(data.contracts).length === 0) {
    errors.push('Metadata missing valid non-empty "contracts" dictionary.');
  } else {
    for (const [name, contract] of Object.entries(data.contracts)) {
      if (!contract || typeof contract !== 'object') {
        errors.push(`Contract entry "${name}" must be an object.`);
        continue;
      }

      if (!contract.contract_id || !CONTRACT_ID_REGEX.test(contract.contract_id)) {
        errors.push(`Contract "${name}" has missing or invalid "contract_id" (must match ^C[A-Z2-7]{55}$).`);
      }

      if (!contract.sha256 || !SHA256_REGEX.test(contract.sha256)) {
        errors.push(`Contract "${name}" has missing or invalid "sha256" (must be a 64-char hex string).`);
      }

      if (!contract.wasm_file || typeof contract.wasm_file !== 'string' || !contract.wasm_file.endsWith('.wasm')) {
        errors.push(`Contract "${name}" must have a valid "wasm_file" path ending with .wasm.`);
      }

      if (!contract.version || typeof contract.version !== 'string') {
        errors.push(`Contract "${name}" must have a valid "version" string.`);
      }

      if (!contract.source || typeof contract.source !== 'string') {
        errors.push(`Contract "${name}" must have a valid "source" string.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function readDeploymentData(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function readDeploymentIds(filePath) {
  const data = readDeploymentData(filePath);
  if (!data) return {};
  const contracts = data.contracts || data;
  return {
    CONFESSION_ANCHOR_CONTRACT_ID:
      contracts['confession-anchor']?.contract_id ||
      contracts.confession_anchor?.contractId ||
      contracts.confessionAnchor?.contractId ||
      contracts.CONFESSION_ANCHOR_CONTRACT_ID,
    REPUTATION_BADGES_CONTRACT_ID:
      contracts['reputation-badges']?.contract_id ||
      contracts.reputation_badges?.contractId ||
      contracts.reputationBadges?.contractId ||
      contracts.REPUTATION_BADGES_CONTRACT_ID,
    TIPPING_SYSTEM_CONTRACT_ID:
      contracts['anonymous-tipping']?.contract_id ||
      contracts.tipping_system?.contractId ||
      contracts.tippingSystem?.contractId ||
      contracts.TIPPING_SYSTEM_CONTRACT_ID,
  };
}

function isTruthy(value) {
  return TRUE_VALUES.has(String(value || '').toLowerCase());
}

function derivePublicKeyFromSecret(secret) {
  try {
    const { Keypair } = require('@stellar/stellar-sdk');
    return { publicKey: Keypair.fromSecret(secret).publicKey() };
  } catch (error) {
    return {
      error:
        'STELLAR_SERVER_SECRET is not a valid Stellar secret seed. Generate or configure a funded signer for the selected network.',
    };
  }
}

async function checkHorizonAccount(publicKey, horizonUrl, network) {
  const networkLabel = network || 'testnet';
  if (typeof fetch !== 'function') {
    return {
      warning:
        `Could not verify signer account ${publicKey}: this Node runtime does not provide fetch. ` +
        `Confirm the account is funded on Stellar ${networkLabel} before deploy.`,
    };
  }

  const baseUrl =
    horizonUrl || (networkLabel === 'mainnet' ? DEFAULT_MAINNET_HORIZON_URL : DEFAULT_TESTNET_HORIZON_URL);

  try {
    const accountUrl = new URL(`/accounts/${publicKey}`, baseUrl);
    const response = await fetch(accountUrl, {
      headers: { Accept: 'application/json' },
    });

    if (response.status === 404) {
      const friendbot = NETWORK_PROFILES[networkLabel] && NETWORK_PROFILES[networkLabel].friendbot;
      const fundHint = friendbot
        ? `Fund it with Friendbot: ${friendbot}?addr=${publicKey}`
        : 'Fund the account on Stellar mainnet before deploy.';
      return {
        warning:
          `STELLAR_SERVER_SECRET resolves to ${publicKey}, but that account does not exist or is unfunded on Stellar ${networkLabel}. ` +
          fundHint,
      };
    }

    if (!response.ok) {
      return {
        warning:
          `Could not verify signer account ${publicKey} on Stellar ${networkLabel} Horizon (${baseUrl}); Horizon returned HTTP ${response.status}. ` +
          'Confirm the signer is funded on the intended network before deploy.',
      };
    }

    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      warning:
        `Could not verify signer account ${publicKey} on Stellar ${networkLabel} Horizon (${baseUrl}): ${message}. ` +
        'Confirm the signer is funded on the intended network before deploy.',
    };
  }
}

async function checkHorizonTestnetAccount(publicKey, horizonUrl) {
  return checkHorizonAccount(publicKey, horizonUrl, 'testnet');
}

async function collectStellarSignerDiagnostics(rawData, network) {
  const warnings = [];
  const failures = [];

  if (!isTruthy(process.env.STELLAR_FEATURES_ENABLED)) {
    return { warnings, failures };
  }

  const secret = process.env.STELLAR_SERVER_SECRET;
  if (!secret) {
    warnings.push(
      `STELLAR_SERVER_SECRET is not set; configure a funded Stellar ${network || 'testnet'} signer before enabling on-chain writes.`,
    );
    return { warnings, failures };
  }

  const derived = derivePublicKeyFromSecret(secret);
  if (derived.error) {
    failures.push(derived.error);
    return { warnings, failures };
  }

  const effectiveNetwork = normalizeNetwork(network) || 'testnet';
  const accountCheck = await checkHorizonAccount(
    derived.publicKey,
    process.env.STELLAR_HORIZON_URL ||
      (effectiveNetwork === 'mainnet' ? DEFAULT_MAINNET_HORIZON_URL : DEFAULT_TESTNET_HORIZON_URL),
    effectiveNetwork,
  );
  if (accountCheck.warning) warnings.push(accountCheck.warning);

  return { warnings, failures, publicKey: derived.publicKey };
}

async function main() {
  const deploymentFile = process.env.DEPLOYMENT_METADATA_PATH
    ? path.resolve(ROOT, process.env.DEPLOYMENT_METADATA_PATH)
    : DEFAULT_DEPLOYMENT_FILE;

  if (!fs.existsSync(deploymentFile)) {
    console.error(`Deployment metadata file not found at: ${deploymentFile}`);
    process.exit(1);
  }

  const rawData = readDeploymentData(deploymentFile);
  if (!rawData) {
    console.error(`Failed to parse JSON in deployment file: ${deploymentFile}`);
    process.exit(1);
  }

  // Validate metadata schema
  const schemaValidation = validateDeploymentMetadataSchema(rawData);
  if (!schemaValidation.valid) {
    console.error(`Deployment metadata schema validation failed for ${path.relative(ROOT, deploymentFile)}:`);
    for (const err of schemaValidation.errors) console.error(`- ${err}`);
    process.exit(1);
  }

  const expected = readDeploymentIds(deploymentFile);
  const failures = [];
  const stellarFeaturesEnabled = isTruthy(process.env.STELLAR_FEATURES_ENABLED);
  const deploymentLabel = path.relative(ROOT, deploymentFile);

  // Unified network/endpoint/contract-ID/signer isolation checks.
  const isolation = validateNetworkIsolation({
    deploymentData: rawData,
    env: process.env,
    deploymentLabel,
  });
  failures.push(...isolation.failures);

  for (const name of [
    'CONFESSION_ANCHOR_CONTRACT_ID',
    'REPUTATION_BADGES_CONTRACT_ID',
    'TIPPING_SYSTEM_CONTRACT_ID',
  ]) {
    const configured = process.env[name];
    if (!configured) {
      if (stellarFeaturesEnabled) {
        failures.push(
          `${name} is required when STELLAR_FEATURES_ENABLED=true so it can be compared with ${path.relative(ROOT, deploymentFile)}.`,
        );
      }
      continue;
    }
    if (!CONTRACT_ID_REGEX.test(configured)) {
      failures.push(`${name} is not a valid Stellar contract ID.`);
    }
    if (expected[name] && expected[name] !== configured) {
      failures.push(`${name} does not match ${path.relative(ROOT, deploymentFile)}.`);
    }
  }

  const signerDiagnostics = await collectStellarSignerDiagnostics(rawData, isolation.network);
  failures.push(...signerDiagnostics.failures);

  // Re-run signer metadata isolation now that the public key is known so that
  // cross-network signer usage is reported alongside the other failures.
  if (signerDiagnostics.publicKey) {
    const signerIsolation = validateNetworkIsolation({
      deploymentData: rawData,
      env: process.env,
      deploymentLabel,
      derivedPublicKey: signerDiagnostics.publicKey,
    });
    for (const warning of signerIsolation.warnings) {
      if (!signerDiagnostics.warnings.includes(warning)) signerDiagnostics.warnings.push(warning);
    }
  }

  if (failures.length > 0) {
    console.error('Contract environment verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    if (signerDiagnostics.warnings.length > 0) {
      console.warn('Contract environment warnings:');
      for (const warning of signerDiagnostics.warnings) console.warn(`- ${warning}`);
    }
    process.exit(1);
  }

  if (signerDiagnostics.warnings.length > 0) {
    console.warn('Contract environment warnings:');
    for (const warning of signerDiagnostics.warnings) console.warn(`- ${warning}`);
  }

  console.log(`Contract deployment metadata & environment verification passed (${rawData.network}).`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Contract environment verification failed: ${message}`);
    process.exit(1);
  });
}

module.exports = {
  validateDeploymentMetadataSchema,
  readDeploymentIds,
  readDeploymentData,
  derivePublicKeyFromSecret,
  checkHorizonTestnetAccount,
  checkHorizonAccount,
  normalizeNetwork,
  networkForHorizonUrl,
  validateNetworkIsolation,
  NETWORK_PROFILES,
};
