#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCORECARD_SCHEMA_VERSION = 1;
const DEFAULT_REPORT_DIR = 'readiness-results';
const DEFAULT_DRIFT_CONTRACT_PATH = path.join(
  __dirname,
  '..',
  'config',
  'deployment-drift-contract.json',
);

const DEPLOYMENT_TARGETS = ['render', 'vercel'];

function parseOptions(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const reportDirArg = argv.find((arg) => arg.startsWith('--report-dir='));

  const driftContractArg = argv.find((arg) =>
    arg.startsWith('--drift-contract='),
  );

  return {
    mode: args.has('--production') ? 'production' : 'local',
    includeFullTests: args.has('--full'),
    includeSmoke: args.has('--smoke') || args.has('--production'),
    writeReport: !args.has('--no-report'),
    reportDir: reportDirArg
      ? reportDirArg.slice('--report-dir='.length)
      : DEFAULT_REPORT_DIR,
    driftContractPath: driftContractArg
      ? driftContractArg.slice('--drift-contract='.length)
      : DEFAULT_DRIFT_CONTRACT_PATH,
  };
}

function loadDriftContract(contractPath = DEFAULT_DRIFT_CONTRACT_PATH) {
  const resolved = path.resolve(process.cwd(), contractPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const contract = JSON.parse(raw);

  if (!contract || typeof contract !== 'object') {
    throw new Error(`Deployment drift contract at ${resolved} must be an object`);
  }

  if (!Array.isArray(contract.keys) || contract.keys.length === 0) {
    throw new Error(
      `Deployment drift contract at ${resolved} must declare a non-empty "keys" array`,
    );
  }

  const seen = new Set();
  for (const entry of contract.keys) {
    if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new Error(
        `Deployment drift contract at ${resolved} has an entry without a "key"`,
      );
    }
    if (seen.has(entry.key)) {
      throw new Error(
        `Deployment drift contract at ${resolved} declares duplicate key "${entry.key}"`,
      );
    }
    seen.add(entry.key);

    if (entry.secret === true) {
      throw new Error(
        `Deployment drift contract key "${entry.key}" is marked secret; only safe non-secret values may be compared`,
      );
    }

    if (!Array.isArray(entry.targets) || entry.targets.length === 0) {
      throw new Error(
        `Deployment drift contract key "${entry.key}" must declare at least one target`,
      );
    }

    for (const target of entry.targets) {
      if (!DEPLOYMENT_TARGETS.includes(target)) {
        throw new Error(
          `Deployment drift contract key "${entry.key}" references unknown target "${target}"`,
        );
      }
    }
  }

  return { path: resolved, keys: contract.keys };
}

function readTargetValue(entry, target, env) {
  const envName = `${target.toUpperCase()}_${entry.key}`;
  const value = env[envName];

  if (value === undefined || value === null || String(value).trim() === '') {
    return { envName, present: false, value: undefined };
  }

  return { envName, present: true, value: String(value).trim() };
}

function normalizeComparableValue(value) {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = String(value).trim();

  // Origins are compared without a trailing slash so that
  // "https://api.example.com" and "https://api.example.com/" match.
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }

  return trimmed.toLowerCase();
}

function buildRemediation(entry, target, envName) {
  const hint = entry.remediation ? ` ${entry.remediation}` : '';
  return `Set ${envName} on ${target} so it matches the other deployment target.${hint}`;
}

function compareDeploymentDrift(contract, env = process.env) {
  const findings = [];

  for (const entry of contract.keys) {
    const values = new Map();

    for (const target of entry.targets) {
      const read = readTargetValue(entry, target, env);
      values.set(target, read);

      if (!read.present) {
        findings.push({
          key: entry.key,
          category: entry.category || 'general',
          status: 'missing',
          target,
          envName: read.envName,
          expected: undefined,
          actual: undefined,
          remediation: buildRemediation(entry, target, read.envName),
        });
      }
    }

    const present = [...values.entries()].filter(([, read]) => read.present);
    if (present.length < 2) {
      continue;
    }

    const baseline = normalizeComparableValue(present[0][1].value);
    for (const [target, read] of present.slice(1)) {
      const actual = normalizeComparableValue(read.value);
      if (actual !== baseline) {
        findings.push({
          key: entry.key,
          category: entry.category || 'general',
          status: 'drift',
          target,
          envName: read.envName,
          expected: present[0][1].value,
          actual: read.value,
          remediation: buildRemediation(entry, target, read.envName),
        });
      }
    }
  }

  return {
    status: findings.length === 0 ? 'passed' : 'failed',
    findings,
  };
}

function renderDriftReport(drift) {
  if (drift.status === 'passed') {
    return 'Deployment configuration drift: none detected.';
  }

  const lines = ['Deployment configuration drift detected:'];
  for (const finding of drift.findings) {
    const detail =
      finding.status === 'missing'
        ? `${finding.envName} is not set`
        : `${finding.envName}="${finding.actual}" does not match expected "${finding.expected}"`;
    lines.push(`- [${finding.category}] ${finding.key}: ${detail}`);
    lines.push(`  Remediation: ${finding.remediation}`);
  }

  return lines.join('\n');
}

function runDeploymentDriftCheck(options = {}) {
  const contractPath = options.contractPath || DEFAULT_DRIFT_CONTRACT_PATH;
  const env = options.env || process.env;

  console.log('\n==> deployment configuration drift');

  let contract;
  try {
    contract = loadDriftContract(contractPath);
  } catch (error) {
    console.error(`Deployment drift contract error: ${error.message}`);
    return {
      name: 'deployment configuration drift',
      status: 'failed',
      code: 1,
      drift: { status: 'failed', findings: [] },
    };
  }

  const drift = compareDeploymentDrift(contract, env);
  console.log(renderDriftReport(drift));

  return {
    name: 'deployment configuration drift',
    status: drift.status === 'passed' ? 'passed' : 'failed',
    code: drift.status === 'passed' ? 0 : 1,
    drift,
  };
}

function buildChecks({ mode, includeFullTests, includeSmoke }) {
  const checks = [
    ['backend build', 'npm', ['run', 'backend:build']],
    ['backend lint', 'npm', ['run', 'backend:lint']],
    [
      'backend focused readiness tests',
      'npm',
      [
        'test',
        '--workspace=xconfess-backend',
        '--',
        'analytics-event.service',
        'traction-metrics',
        'public-traction.controller',
        'chain-reconciliation',
        'soroban-event-checkpoint',
        'stellar-diagnostics.service',
        'stellar-config.service',
        'health.controller',
        '--runInBand',
      ],
    ],
    ['frontend lint', 'npm', ['run', 'frontend:lint']],
    ['frontend typecheck', 'npm', ['run', 'frontend:typecheck']],
    [
      'frontend focused readiness tests',
      'npm',
      [
        'test',
        '--workspace=xconfess-frontend',
        '--',
        'traction',
        'api/public/traction',
        '--runInBand',
      ],
    ],
    ['frontend build', 'npm', ['run', 'frontend:build']],
    ['contract env verification', 'npm', ['run', 'contracts:verify-env']],
    [
      'network isolation verification',
      'npm',
      ['run', 'contracts:verify-network-isolation'],
    ],
    ['secret scanner self-test', 'npm', ['run', 'secret-scan:self-test']],
  ];

  if (mode === 'production') {
    checks.splice(0, 0, [
      'deploy preflight',
      'npm',
      ['run', 'deploy:preflight'],
    ]);
  }

  if (includeFullTests) {
    checks.push(['backend full tests', 'npm', ['run', 'backend:test']]);
    checks.push(['frontend full tests', 'npm', ['run', 'frontend:test']]);
    checks.push(['contract tests', 'npm', ['run', 'contract:test']]);
  }

  if (includeSmoke) {
    checks.push(['deployed smoke', 'npm', ['run', 'deploy:smoke']]);
  }

  return checks;
}

function runCheck([name, command, commandArgs]) {
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  return {
    name,
    status: result.status === 0 ? 'passed' : 'failed',
    code: result.status,
  };
}

function createScorecard({ mode, startedAt, durationMs, results }) {
  const failed = results.filter((result) => result.status !== 'passed');

  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    mode,
    status: failed.length === 0 ? 'passed' : 'failed',
    durationMs,
    checks: results.map((result) => ({
      name: result.name,
      status: result.status === 'passed' ? 'PASS' : 'FAIL',
      exitCode: result.code,
    })),
  };
}

function renderMarkdownReport(scorecard) {
  const lines = [
    '# Production Readiness Scorecard',
    '',
    `Generated: ${scorecard.generatedAt}`,
    `Mode: ${scorecard.mode}`,
    `Status: ${scorecard.status.toUpperCase()}`,
    `Duration: ${scorecard.durationMs}ms`,
    '',
    '| Check | Result | Exit code |',
    '| --- | --- | --- |',
  ];

  for (const check of scorecard.checks) {
    lines.push(`| ${check.name} | ${check.status} | ${check.exitCode} |`);
  }

  lines.push('');
  return lines.join('\n');
}

function writeScorecardReports(scorecard, reportDir) {
  const outputDir = path.resolve(process.cwd(), reportDir || DEFAULT_REPORT_DIR);
  fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, 'production-readiness-scorecard.json');
  const markdownPath = path.join(outputDir, 'production-readiness-scorecard.md');

  fs.writeFileSync(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderMarkdownReport(scorecard));

  return { jsonPath, markdownPath };
}

function main() {
  const options = parseOptions();
  const checks = buildChecks(options);
  const started = Date.now();
  const results = checks.map(runCheck);

  if (options.mode === 'production') {
    results.push(
      runDeploymentDriftCheck({
        contractPath: options.driftContractPath,
      }),
    );
  }
  const durationMs = Math.max(1, Date.now() - started);
  const scorecard = createScorecard({
    mode: options.mode,
    startedAt: started,
    durationMs,
    results,
  });

  console.log('\nProduction readiness summary');
  for (const result of results) {
    console.log(`- ${result.status.toUpperCase()}: ${result.name}`);
  }
  console.log(`Duration: ${durationMs}ms`);

  if (options.writeReport) {
    const written = writeScorecardReports(scorecard, options.reportDir);
    console.log(`Scorecard JSON: ${written.jsonPath}`);
    console.log(`Scorecard Markdown: ${written.markdownPath}`);
  }

  if (scorecard.status !== 'passed') {
    const failed = results.filter((result) => result.status !== 'passed');
    console.error(
      `\nReadiness failed: ${failed.map((result) => result.name).join(', ')}`,
    );
    process.exit(1);
  }

  console.log('\nReadiness passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  buildChecks,
  compareDeploymentDrift,
  createScorecard,
  loadDriftContract,
  parseOptions,
  renderDriftReport,
  renderMarkdownReport,
  runDeploymentDriftCheck,
  writeScorecardReports,
};
