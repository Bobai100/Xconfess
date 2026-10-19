#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, 'release-compatibility-report.json');

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--output') throw new Error(`Unknown argument: ${argv[index]}`);
    const output = argv[++index];
    if (!output || output.startsWith('--')) throw new Error('--output requires a file path.');
    options.output = path.resolve(ROOT, output);
  }
  return options;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJson(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  try {
    return { value: JSON.parse(fs.readFileSync(absolutePath, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: `${relativePath}: ${error.message}` };
  }
}

function addCheck(checks, name, passed, details = '') {
  checks.push({ name, status: passed ? 'passed' : 'blocked', ...(details ? { details } : {}) });
}

function compareContractManifests(abiContracts, wasmContracts) {
  const abiNames = Object.keys(abiContracts || {}).sort();
  const wasmNames = Object.keys(wasmContracts || {}).sort();
  const namesMatch = abiNames.length > 0 && JSON.stringify(abiNames) === JSON.stringify(wasmNames);
  const versionsMatch = namesMatch && abiNames.every((name) =>
    abiContracts[name].version && abiContracts[name].version === wasmContracts[name].version,
  );
  return { names: abiNames, namesMatch, versionsMatch };
}

function runDriftCheck(name, args, env = process.env) {
  const result = spawnSync('bash', args, { cwd: ROOT, encoding: 'utf8', env });
  const remediation = args[0] === 'scripts/check-openapi-drift.sh'
    ? 'Run npm run check:openapi-drift and update the generated API client/snapshot.'
    : 'Run npm run check:abi-drift and reconcile contract source, ABI, and manifests.';
  return {
    name,
    status: result.status === 0 ? 'passed' : 'blocked',
    exitCode: result.status ?? 1,
    ...(result.status === 0 ? {} : { remediation }),
  };
}

function buildReport({ output = DEFAULT_OUTPUT, now = new Date() } = {}) {
  const checks = [];
  const rootPackage = readJson('package.json');
  const backendPackage = readJson('xconfess-backend/package.json');
  const frontendPackage = readJson('xconfess-frontend/package.json');
  const apiSnapshot = readJson('scripts/.api-snapshot.json');
  const abiManifest = readJson('deployments/contract-abi-manifest.json');
  const wasmManifest = readJson('deployments/contract-wasm-manifest.json');

  const versions = {
    root: rootPackage.value?.version ?? null,
    backend: backendPackage.value?.version ?? null,
    frontend: frontendPackage.value?.version ?? null,
  };
  addCheck(checks, 'application versions recorded', Object.values(versions).every(Boolean));

  const snapshotPath = path.join(ROOT, 'scripts/.api-snapshot.json');
  const routeCount = apiSnapshot.value?.controllerRouteCount;
  addCheck(checks, 'OpenAPI snapshot available', !apiSnapshot.error && Number.isInteger(routeCount) && routeCount > 0,
    apiSnapshot.error || (Number.isInteger(routeCount) ? `${routeCount} controller routes` : 'invalid controller route count'));

  addCheck(checks, 'contract manifests available', !abiManifest.error && !wasmManifest.error,
    abiManifest.error || wasmManifest.error || 'ABI and WASM manifests parsed');

  const abiContracts = abiManifest.value?.contracts;
  const wasmContracts = wasmManifest.value?.contracts;
  const contractComparison = compareContractManifests(abiContracts, wasmContracts);
  addCheck(checks, 'ABI and WASM contract sets match', contractComparison.namesMatch);
  addCheck(checks, 'ABI and WASM contract versions match', contractComparison.versionsMatch);

  const artifactPaths = [
    'scripts/.api-snapshot.json',
    'deployments/contract-abi-manifest.json',
    'deployments/contract-wasm-manifest.json',
  ];
  const artifacts = artifactPaths.map((relativePath) => ({
    path: relativePath,
    sha256: fs.existsSync(path.join(ROOT, relativePath)) ? sha256(path.join(ROOT, relativePath)) : null,
  }));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xconfess-release-compat-'));
  let driftChecks;
  try {
    driftChecks = [
      runDriftCheck('OpenAPI source/client drift', ['scripts/check-openapi-drift.sh']),
      runDriftCheck('Contract ABI/source drift', ['xconfess-contracts/scripts/check-abi-drift.sh'], {
        ...process.env,
        ABI_REPORT_PATH: path.join(tempDir, 'abi-compat-report.json'),
      }),
    ];
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  checks.push(...driftChecks);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    candidate: { commit: commit.status === 0 ? commit.stdout.trim() : 'unknown', versions },
    api: {
      snapshot: 'scripts/.api-snapshot.json',
      routeCount: Number.isInteger(routeCount) ? routeCount : null,
      snapshotSha256: fs.existsSync(snapshotPath) ? sha256(snapshotPath) : null,
    },
    contracts: {
      names: contractComparison.names,
      abiManifestVersion: abiManifest.value?.manifest_version ?? null,
      wasmManifestVersion: wasmManifest.value?.schema_version ?? null,
      abiManifestSha256: artifacts[1].sha256,
      wasmManifestSha256: artifacts[2].sha256,
    },
    artifacts,
    checks,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    reportPath: path.relative(ROOT, output),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = buildReport(options);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Release compatibility report: ${path.relative(ROOT, options.output)}`);
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase()}: ${check.name}${check.details ? ` (${check.details})` : ''}`);
  }
  return report.status === 'passed' ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildReport, compareContractManifests, parseArgs };