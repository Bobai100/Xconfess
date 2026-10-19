#!/usr/bin/env node
/**
 * scripts/diagnose.js — reproducible environment diagnostics
 *
 * Reports Node, npm, OS, Docker/container state, service reachability,
 * database schema status, and git state in a copyable, secret-safe format.
 *
 * Usage:
 *   npm run diagnose
 *   node scripts/diagnose.js [--json]
 *
 * Secrets are NEVER included in output. Environment variables are shown
 * by key name only, with a redacted placeholder for their values.
 * See docs/OWNERSHIP.md for interpretation guidance.
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..');
const JSON_MODE = process.argv.includes('--json');

/** Run a shell command, return trimmed stdout or null on error. */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd || REPO_ROOT,
      timeout: opts.timeout || 8000,
    }).trim();
  } catch {
    return null;
  }
}

/** Attempt a TCP connection; resolves true if reachable within timeoutMs. */
function canConnect(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Read an env file and return key names only (never values).
 * This is intentionally value-free so no secrets leak into output.
 */
function envKeys(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());
}

/**
 * Read an env file and return a map of key → "<set>" | "<empty>" | "<missing>".
 * Values are never returned — only presence/emptiness is reported.
 */
function envPresence(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .forEach((l) => {
      const idx = l.indexOf('=');
      const key = l.slice(0, idx).trim();
      const val = l.slice(idx + 1).trim();
      out[key] = val.length > 0 ? '<set>' : '<empty>';
    });
  return out;
}

// ── Section collectors ────────────────────────────────────────────────────────

function collectRuntime() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const npmVersion = run('npm --version');
  return {
    node: process.version,
    node_major: nodeMajor,
    node_expected: 22,
    node_ok: nodeMajor === 22,
    npm: npmVersion || 'unknown',
    platform: process.platform,
    arch: process.arch,
    os_release: `${os.type()} ${os.release()}`,
    cpu_cores: os.cpus().length,
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
  };
}

function collectGit() {
  const branch = run('git rev-parse --abbrev-ref HEAD');
  const commit = run('git rev-parse --short HEAD');
  const status = run('git status --porcelain');
  const remotes = run('git remote -v');
  const lastCommit = run('git log -1 --format="%s (%an, %ar)"');
  return {
    branch: branch || 'unknown',
    commit: commit || 'unknown',
    dirty: status !== null && status.length > 0,
    uncommitted_files: status ? status.split('\n').filter(Boolean).length : 0,
    last_commit: lastCommit || 'unknown',
    remotes: remotes
      ? remotes
          .split('\n')
          .filter(Boolean)
          .map((l) => l.replace(/\s+/g, ' '))
      : [],
  };
}

function collectDocker() {
  const dockerVersion = run('docker --version');
  const composeVersion = run('docker compose version');

  let containersRaw = null;
  if (dockerVersion) {
    containersRaw = run(
      'docker compose -f compose.yaml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"',
    );
  }

  return {
    docker_available: !!dockerVersion,
    docker_version: dockerVersion || 'not found',
    compose_version: composeVersion || 'not found',
    containers: containersRaw
      ? containersRaw
          .split('\n')
          .slice(1)
          .filter(Boolean)
          .map((l) => l.trim())
      : [],
  };
}

async function collectServices() {
  // Read hosts/ports from backend .env if available; fall back to defaults.
  const backendEnvPath = path.join(REPO_ROOT, 'xconfess-backend', '.env');
  const envMap = envPresence(backendEnvPath);

  // We read the raw file only to extract host/port — not secret values.
  let dbHost = 'localhost';
  let dbPort = 55432;
  let redisHost = 'localhost';
  let redisPort = 6379;

  if (fs.existsSync(backendEnvPath)) {
    const raw = Object.fromEntries(
      fs
        .readFileSync(backendEnvPath, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const idx = l.indexOf('=');
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        }),
    );
    if (raw.DB_HOST) dbHost = raw.DB_HOST;
    if (raw.DB_PORT) dbPort = Number(raw.DB_PORT);
    if (raw.REDIS_HOST) redisHost = raw.REDIS_HOST;
    if (raw.REDIS_PORT) redisPort = Number(raw.REDIS_PORT);
  }

  const [pgOk, redisOk] = await Promise.all([
    canConnect(dbHost, dbPort),
    canConnect(redisHost, redisPort),
  ]);

  return {
    postgres: {
      host: dbHost,
      port: dbPort,
      reachable: pgOk,
    },
    redis: {
      host: redisHost,
      port: redisPort,
      reachable: redisOk,
    },
  };
}

function collectEnvFiles() {
  const backendEnv = path.join(REPO_ROOT, 'xconfess-backend', '.env');
  const frontendEnv = path.join(REPO_ROOT, 'xconfess-frontend', '.env.local');
  const backendExample = path.join(REPO_ROOT, 'xconfess-backend', '.env.example');

  // Required keys per the README / bootstrap docs
  const requiredBackend = [
    'JWT_SECRET',
    'APP_SECRET',
    'CONFESSION_ENCRYPTION_KEY',
    'ENCRYPTION_CURRENT_KEY_VERSION',
    'ENCRYPTION_MASTER_KEY_v1',
    'DB_HOST',
    'DB_PORT',
    'DB_USERNAME',
    'DB_PASSWORD',
    'DB_NAME',
    'REDIS_HOST',
    'REDIS_PORT',
  ];

  const backendPresence = envPresence(backendEnv);
  const missingRequired = requiredBackend.filter(
    (k) => backendPresence[k] === undefined || backendPresence[k] === '<empty>',
  );

  // Count keys in example file to highlight drift
  const exampleKeys = envKeys(backendExample);

  return {
    'xconfess-backend/.env': {
      exists: fs.existsSync(backendEnv),
      key_count: Object.keys(backendPresence).length,
      example_key_count: exampleKeys.length,
      missing_required_keys: missingRequired,
      // Show all keys (names only) for diagnostics without exposing values
      keys_present: Object.keys(backendPresence),
    },
    'xconfess-frontend/.env.local': {
      exists: fs.existsSync(frontendEnv),
      key_count: Object.keys(envPresence(frontendEnv)).length,
      keys_present: Object.keys(envPresence(frontendEnv)),
    },
  };
}

function collectDependencies() {
  const lockExists = fs.existsSync(path.join(REPO_ROOT, 'package-lock.json'));
  const nmExists = fs.existsSync(path.join(REPO_ROOT, 'node_modules'));
  const rustVersion = run('rustc --version');
  const cargoVersion = run('cargo --version');

  return {
    node_modules_present: nmExists,
    lock_file_present: lockExists,
    rust: rustVersion || 'not installed',
    cargo: cargoVersion || 'not installed',
  };
}

function collectSchema() {
  // Run migration:show without connecting to DB if we can; errors are caught.
  const show = run('npm run backend:migration:show 2>&1 | tail -20', {
    timeout: 15000,
  });
  return {
    migration_show_output: show
      ? show.split('\n').filter(Boolean).slice(-10)
      : ['(could not run - database may be down)'],
  };
}

function readApplicationVersion(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function createReproductionBundle({ runtime, appVersions, serviceHealth, configKeys, generatedAt }) {
  return {
    schemaVersion: 1,
    generatedAt,
    runtime: {
      node: runtime.node,
      npm: runtime.npm,
      platform: runtime.platform,
      arch: runtime.arch,
    },
    applicationVersions: appVersions,
    serviceHealth,
    configKeys,
  };
}

function scanReproductionBundle(bundle) {
  const findings = [];
  const exactKeys = (value, expected) =>
    value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected.slice().sort().join(',');

  if (!exactKeys(bundle, ['schemaVersion', 'generatedAt', 'runtime', 'applicationVersions', 'serviceHealth', 'configKeys'])) {
    findings.push('unexpected-or-missing-fields');
    return findings;
  }
  if (bundle.schemaVersion !== 1 || !/^\d{4}-\d\d-\d\dT/.test(bundle.generatedAt)) {
    findings.push('invalid-metadata');
  }
  if (!exactKeys(bundle.runtime, ['node', 'npm', 'platform', 'arch']) ||
      !/^v?\d+\.\d+\.\d+/.test(bundle.runtime.node) ||
      !/^\d+\.\d+\.\d+/.test(bundle.runtime.npm) ||
      !/^[a-z]+$/.test(bundle.runtime.platform) ||
      !/^[A-Za-z0-9_-]+$/.test(bundle.runtime.arch)) {
    findings.push('invalid-runtime-metadata');
  }
  if (!exactKeys(bundle.applicationVersions, ['root', 'backend', 'frontend']) ||
      Object.values(bundle.applicationVersions).some((version) => typeof version !== 'string' || !/^[\w.+-]+$/.test(version))) {
    findings.push('invalid-application-versions');
  }
  if (!exactKeys(bundle.serviceHealth, ['postgres', 'redis']) ||
      Object.values(bundle.serviceHealth).some((status) => !['reachable', 'unreachable'].includes(status))) {
    findings.push('invalid-health-data');
  }
  if (!exactKeys(bundle.configKeys, ['backend', 'frontend']) ||
      Object.values(bundle.configKeys).some((keys) => !Array.isArray(keys) || keys.some((key) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key)))) {
    findings.push('invalid-config-names');
  }

  const serialized = JSON.stringify(bundle);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i.test(serialized)) {
    findings.push('credential-pattern');
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(serialized)) {
    findings.push('personal-identifier-pattern');
  }
  return findings;
}

async function collectReproductionBundle() {
  const [runtime, services] = await Promise.all([collectRuntime(), collectServices()]);
  const backendEnv = path.join(REPO_ROOT, 'xconfess-backend', '.env');
  const frontendEnv = path.join(REPO_ROOT, 'xconfess-frontend', '.env.local');
  return createReproductionBundle({
    runtime,
    appVersions: {
      root: readApplicationVersion('package.json'),
      backend: readApplicationVersion('xconfess-backend/package.json'),
      frontend: readApplicationVersion('xconfess-frontend/package.json'),
    },
    serviceHealth: {
      postgres: services.postgres.reachable ? 'reachable' : 'unreachable',
      redis: services.redis.reachable ? 'reachable' : 'unreachable',
    },
    configKeys: {
      backend: envKeys(backendEnv),
      frontend: envKeys(frontendEnv),
    },
    generatedAt: new Date().toISOString(),
  });
}

function writeReproductionBundle(outputPath, bundle) {
  const target = path.resolve(outputPath);
  const findings = scanReproductionBundle(bundle);
  if (findings.length > 0) {
    throw new Error(`Reproduction bundle rejected by privacy scan: ${findings.join(', ')}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporaryPath = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    const written = JSON.parse(fs.readFileSync(temporaryPath, 'utf8'));
    const outputFindings = scanReproductionBundle(written);
    if (outputFindings.length > 0) {
      throw new Error(`Reproduction bundle output rejected by privacy scan: ${outputFindings.join(', ')}`);
    }
    fs.renameSync(temporaryPath, target);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  return target;
}

function parseBundlePath(argv) {
  const optionIndex = argv.indexOf('--bundle');
  if (optionIndex === -1) return null;
  const outputPath = argv[optionIndex + 1];
  if (!outputPath || outputPath.startsWith('--')) {
    throw new Error('Usage: node scripts/diagnose.js --bundle <output-file>');
  }
  return outputPath;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function badge(ok) {
  return ok ? '✓' : '✗';
}

function printSection(title, data) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
  for (const [key, val] of Object.entries(data)) {
    const display = Array.isArray(val)
      ? val.length === 0
        ? '[]'
        : '\n    ' + val.join('\n    ')
      : typeof val === 'object' && val !== null
        ? '\n    ' + JSON.stringify(val, null, 2).replace(/\n/g, '\n    ')
        : String(val);
    console.log(`  ${key.padEnd(30)} ${display}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const bundlePath = parseBundlePath(process.argv.slice(2));
  if (bundlePath) {
    const bundle = await collectReproductionBundle();
    const writtenPath = writeReproductionBundle(bundlePath, bundle);
    console.log(`Safe reproduction bundle written: ${path.relative(process.cwd(), writtenPath)}`);
    console.log('Privacy scan passed; no tokens, user content, or identifiers are included.');
    return;
  }

  if (!JSON_MODE) {
    console.log('xConfess environment diagnostics');
    console.log(`Generated: ${new Date().toISOString()}`);
    console.log('SECRETS ARE NEVER INCLUDED IN THIS OUTPUT');
    console.log(
      'Share this output freely in issues and PRs. See docs/OWNERSHIP.md for interpretation.',
    );
  }

  const [runtime, git, docker, services, envFiles, deps] = await Promise.all([
    Promise.resolve(collectRuntime()),
    Promise.resolve(collectGit()),
    Promise.resolve(collectDocker()),
    collectServices(),
    Promise.resolve(collectEnvFiles()),
    Promise.resolve(collectDependencies()),
  ]);

  // Schema check is slower; run after services are known
  const schema = collectSchema();

  const report = {
    generated_at: new Date().toISOString(),
    runtime,
    git,
    docker,
    services,
    env_files: envFiles,
    dependencies: deps,
    schema,
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSection('Runtime', {
    [`${badge(runtime.node_ok)} Node`]: `${runtime.node} (expected 22.x)`,
    'npm': runtime.npm,
    'platform / arch': `${runtime.platform} / ${runtime.arch}`,
    'OS': runtime.os_release,
    'CPU cores': runtime.cpu_cores,
    'Memory (total / free)': `${runtime.total_memory_mb} MB / ${runtime.free_memory_mb} MB`,
  });

  printSection('Git', {
    'branch': git.branch,
    'commit': git.commit,
    [`${badge(!git.dirty)} working tree`]: git.dirty
      ? `${git.uncommitted_files} uncommitted file(s)`
      : 'clean',
    'last commit': git.last_commit,
    'remotes': git.remotes,
  });

  printSection('Docker', {
    [`${badge(docker.docker_available)} docker`]: docker.docker_version,
    'docker compose': docker.compose_version,
    'containers': docker.containers.length > 0 ? docker.containers : ['(none running or compose not available)'],
  });

  printSection('Services', {
    [`${badge(services.postgres.reachable)} Postgres`]: `${services.postgres.host}:${services.postgres.port}`,
    [`${badge(services.redis.reachable)} Redis`]: `${services.redis.host}:${services.redis.port}`,
  });

  for (const [file, info] of Object.entries(envFiles)) {
    const missing = info.missing_required_keys ?? [];
    printSection(`Env: ${file}`, {
      [`${badge(info.exists)} file exists`]: info.exists ? 'yes' : 'no — run: npm run env:bootstrap',
      'keys present': info.key_count,
      ...(info.example_key_count !== undefined
        ? { 'keys in .env.example': info.example_key_count }
        : {}),
      ...(missing.length > 0
        ? { [`${badge(false)} missing required keys`]: missing }
        : { [`${badge(true)} required keys`]: 'all set' }),
    });
  }

  printSection('Dependencies', {
    [`${badge(deps.node_modules_present)} node_modules`]: deps.node_modules_present
      ? 'present'
      : 'missing — run: npm install',
    [`${badge(deps.lock_file_present)} package-lock.json`]: deps.lock_file_present
      ? 'present'
      : 'missing',
    'rust': deps.rust,
    'cargo': deps.cargo,
  });

  printSection('Schema (last 10 lines of migration:show)', {
    output: schema.migration_show_output,
  });

  // Summary
  const allOk =
    runtime.node_ok &&
    docker.docker_available &&
    services.postgres.reachable &&
    services.redis.reachable &&
    Object.values(envFiles).every((f) => f.exists && (f.missing_required_keys ?? []).length === 0) &&
    deps.node_modules_present;

  console.log(`\n${'═'.repeat(60)}`);
  if (allOk) {
    console.log('  ✓ Diagnostics: all checks passed');
  } else {
    console.log('  ✗ Diagnostics: one or more checks need attention');
    console.log('  Review the sections marked ✗ above.');
    console.log('  See docs/CONTRIBUTOR_GUIDE.md for setup instructions.');
  }
  console.log('═'.repeat(60));

  process.exit(allOk ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Diagnostics failed unexpectedly:', err.message);
    process.exit(1);
  });
}

module.exports = {
  createReproductionBundle,
  envKeys,
  envPresence,
  scanReproductionBundle,
  writeReproductionBundle,
};
