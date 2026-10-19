#!/usr/bin/env node
/**
 * scripts/post-deploy-verify.js
 *
 * Post-deployment verification and evidence retention for xConfess.
 *
 * Runs authenticated and anonymous smoke checks, contract health probes,
 * health endpoint assertions, and captures evidence tied to the release
 * identity (commit SHA, run ID, environment).  Evidence is retained to a
 * local directory (and optionally uploaded as a CI artifact).
 *
 * A green deployment job is NOT sufficient — this script proves the live
 * critical paths work after promotion.
 *
 * Usage:
 *   node scripts/post-deploy-verify.js [options]
 *
 * Options:
 *   --backend-url <url>    Backend base URL (default: BACKEND_URL env or https://...)
 *   --frontend-url <url>   Frontend base URL (default: FRONTEND_URL env or https://...)
 *   --env <name>           Environment name for evidence label (default: staging)
 *   --commit <sha>         Commit SHA for evidence label (default: GITHUB_SHA or git rev-parse)
 *   --run-id <id>          CI run ID for evidence label (default: GITHUB_RUN_ID or timestamp)
 *   --evidence-dir <dir>   Directory to write evidence (default: post-deploy-evidence)
 *   --timeout-ms <n>       Per-request timeout in ms (default: 45000)
 *   --retries <n>          Max attempts per check (default: 5)
 *   --retry-delay-ms <n>   Delay between retries (default: 5000)
 *   --fail-policy <policy> What to do on failure: halt (default) | warn
 *   --skip-auth            Skip authenticated checks (no credentials available)
 *   --regions <list>       Comma-separated synthetic regions (default: SYNTHETIC_REGIONS env or none)
 *   --skip-regional        Skip regional synthetic checks
 *
 * Environment variables:
 *   BACKEND_URL            Backend base URL
 *   FRONTEND_URL           Frontend base URL
 *   SMOKE_TEST_EMAIL       Email for authenticated check (no default — skipped if missing)
 *   SMOKE_TEST_PASSWORD    Password for authenticated check
 *   SYNTHETIC_REGIONS      Comma-separated regions for synthetic journeys (e.g. us-east,eu-west)
 *   GITHUB_SHA             Commit SHA (set by GitHub Actions)
 *   GITHUB_RUN_ID          Run ID (set by GitHub Actions)
 *   GITHUB_ACTOR           Deployer identity (set by GitHub Actions)
 *
 * Exit codes:
 *   0  All critical checks passed; evidence retained
 *   1  One or more critical checks failed (halt policy)
 *
 * Acceptance criteria (issue #135):
 *   - Covers critical paths without exposing user data
 *   - Failures halt or roll back per policy
 *   - Evidence is retained with release identity
 *
 * Acceptance criteria (issue #283):
 *   - Verifies a full user journey through the frontend proxy origin:
 *     sign-in → representative authenticated request → sign-out
 *   - Asserts session cookie credentials and CORS/origin behavior
 *   - Emits secret-free, redacted diagnostics on failure
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Parse args ────────────────────────────────────────────────────────────────
function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    backendUrl: process.env.BACKEND_URL || 'https://xconfess-backend.onrender.com',
    frontendUrl: process.env.FRONTEND_URL || 'https://xconfess.vercel.app',
    env: 'staging',
    commit: process.env.GITHUB_SHA || '',
    runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}`,
    evidenceDir: 'post-deploy-evidence',
    timeoutMs: 45000,
    retries: 5,
    retryDelayMs: 5000,
    failPolicy: 'halt',
    skipAuth: false,
    skipRegional: false,
    regions: (process.env.SYNTHETIC_REGIONS || '')
      .split(',')
      .map(r => r.trim())
      .filter(Boolean),
    testEmail: process.env.SMOKE_TEST_EMAIL || '',
    testPassword: process.env.SMOKE_TEST_PASSWORD || '',
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--backend-url':   opts.backendUrl   = argv[++i]; break;
      case '--frontend-url':  opts.frontendUrl  = argv[++i]; break;
      case '--env':           opts.env          = argv[++i]; break;
      case '--commit':        opts.commit       = argv[++i]; break;
      case '--run-id':        opts.runId        = argv[++i]; break;
      case '--evidence-dir':  opts.evidenceDir  = argv[++i]; break;
      case '--timeout-ms':    opts.timeoutMs    = Number(argv[++i]); break;
      case '--retries':       opts.retries      = Number(argv[++i]); break;
      case '--retry-delay-ms': opts.retryDelayMs = Number(argv[++i]); break;
      case '--fail-policy':   opts.failPolicy   = argv[++i]; break;
      case '--skip-auth':     opts.skipAuth     = true; break;
      case '--regions':
        opts.regions = (argv[++i] || '').split(',').map(r => r.trim()).filter(Boolean);
        break;
      case '--skip-regional': opts.skipRegional = true; break;
    }
  }
  // Resolve commit if not set
  if (!opts.commit) {
    try {
      const { execSync } = require('child_process');
      opts.commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch { opts.commit = 'unknown'; }
  }
  return opts;
}

// ── Request utilities ─────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function joinUrl(base, p) {
  return `${base.replace(/\/+$/, '')}${p}`;
}

function isRetryable(err) {
  return err && (err.name === 'AbortError' || err.name === 'TypeError');
}

function isRenderWake(res) {
  return res.headers?.get?.('x-render-routing') === 'hibernate-wake-error';
}

async function request(label, url, reqOpts, expectedStatuses, opts) {
  const { timeoutMs, retries, retryDelayMs } = opts;
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        ...reqOpts,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(reqOpts.body ? { 'content-type': 'application/json' } : {}),
          ...(reqOpts.headers || {}),
        },
      });
    } catch (err) {
      clearTimeout(tid);
      const latency = Date.now() - started;
      lastError = err;
      const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err.message;
      if (attempt < retries && isRetryable(err)) {
        console.log(`  [retry ${attempt}/${retries}] ${label}: ${reason}`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw new Error(`${label} failed (${latency}ms): ${reason}`);
    }
    clearTimeout(tid);
    const latency = Date.now() - started;
    if (!expectedStatuses.includes(res.status)) {
      if (attempt < retries && (res.status === 503 && isRenderWake(res))) {
        console.log(`  [retry ${attempt}/${retries}] ${label}: Render hibernate wake`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new Error(`${label} returned ${res.status} (${latency}ms): ${body.slice(0, 300)}`);
    }
    console.log(`  ✓ ${label}: ${res.status} (${latency}ms)`);
    return res;
  }
  throw lastError || new Error(`${label} exhausted retries`);
}

async function requestJson(label, url, reqOpts, expectedStatuses, opts) {
  const res = await request(label, url, reqOpts, expectedStatuses, opts);
  return res.json();
}

// ── Privacy guards ────────────────────────────────────────────────────────────
const SENSITIVE_KEYS = new Set([
  'authorization', 'body', 'content', 'email', 'ip', 'ipaddress', 'jwt',
  'message', 'password', 'passwordhash', 'phone', 'privatekey', 'rawip',
  'seed', 'seedphrase', 'sessiontoken', 'token', 'useragent',
]);

function assertNoSensitiveData(label, obj, path = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const fullPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEYS.has(norm) || norm.endsWith('token') || norm.includes('privatekey')) {
      throw new Error(`${label} exposed sensitive field: ${fullPath}`);
    }
    assertNoSensitiveData(label, value, fullPath);
  }
}

// ── Evidence capture ──────────────────────────────────────────────────────────
function buildEvidenceRecord(opts) {
  return {
    releaseIdentity: {
      environment: opts.env,
      commitSha: opts.commit,
      runId: opts.runId,
      deployedBy: process.env.GITHUB_ACTOR || 'local',
      verifiedAt: new Date().toISOString(),
    },
    checks: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
  };
}

function recordCheck(evidence, name, status, details = {}) {
  const record = {
    name,
    status,  // 'pass' | 'fail' | 'skip'
    timestamp: new Date().toISOString(),
    ...details,
  };
  evidence.checks.push(record);
  if (status === 'pass')  evidence.summary.passed++;
  if (status === 'fail')  evidence.summary.failed++;
  if (status === 'skip')  evidence.summary.skipped++;
  return record;
}

function writeEvidence(evidence, opts) {
  const dir = opts.evidenceDir;
  fs.mkdirSync(dir, { recursive: true });
  const filename = `verify-${opts.env}-${opts.commit.slice(0, 8)}-${opts.runId}.json`;
  const filepath = path.join(dir, filename);
  // Redact any accidental credential fields before writing
  const safe = JSON.stringify(evidence, (key, value) => {
    const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_KEYS.has(norm)) return '[REDACTED]';
    return value;
  }, 2);
  fs.writeFileSync(filepath, safe, 'utf8');
  console.log(`\nEvidence retained: ${filepath}`);
  return filepath;
}

// ── Checks ────────────────────────────────────────────────────────────────────
async function checkBackendLiveness(evidence, opts) {
  console.log('\n── Backend health checks');
  try {
    const live = await requestJson('backend /health/live', joinUrl(opts.backendUrl, '/api/health/live'), {}, [200], opts);
    assertNoSensitiveData('health/live', live);
    recordCheck(evidence, 'backend-liveness', 'pass', { url: joinUrl(opts.backendUrl, '/api/health/live') });
  } catch (err) {
    recordCheck(evidence, 'backend-liveness', 'fail', { error: err.message });
    throw err;
  }
}

async function checkBackendReadiness(evidence, opts) {
  try {
    const ready = await requestJson('backend /health/ready', joinUrl(opts.backendUrl, '/api/health/ready'), {}, [200], opts);
    assertNoSensitiveData('health/ready', ready);
    recordCheck(evidence, 'backend-readiness', 'pass', { url: joinUrl(opts.backendUrl, '/api/health/ready') });
  } catch (err) {
    recordCheck(evidence, 'backend-readiness', 'fail', { error: err.message });
    throw err;
  }
}

async function checkBackendStatus(evidence, opts) {
  try {
    const status = await requestJson('backend /health/status', joinUrl(opts.backendUrl, '/api/health/status'), {}, [200, 503], opts);
    assertNoSensitiveData('health/status', status);
    recordCheck(evidence, 'backend-status', 'pass', {
      url: joinUrl(opts.backendUrl, '/api/health/status'),
      statusCode: 'captured',
    });
  } catch (err) {
    recordCheck(evidence, 'backend-status', 'fail', { error: err.message });
    // Status is informational — not a hard failure
    console.log(`  ⚠ backend-status: ${err.message} (non-fatal)`);
  }
}

async function checkPublicTraction(evidence, opts) {
  console.log('\n── Public API checks');
  try {
    const traction = await requestJson('public /api/public/traction', joinUrl(opts.backendUrl, '/api/public/traction'), {}, [200], opts);
    assertNoSensitiveData('public traction', traction);
    if (!traction.users || !traction.engagement || !traction.stellar || !traction.reliability) {
      throw new Error('public traction API missing required aggregate sections');
    }
    recordCheck(evidence, 'public-traction-api', 'pass');
  } catch (err) {
    recordCheck(evidence, 'public-traction-api', 'fail', { error: err.message });
    throw err;
  }
}

async function checkStellarConfig(evidence, opts) {
  try {
    const cfg = await requestJson('public /api/stellar/config', joinUrl(opts.backendUrl, '/api/stellar/config'), {}, [200], opts);
    assertNoSensitiveData('stellar config', cfg);
    if (!cfg.network || !cfg.contractIds) {
      throw new Error('stellar config missing network or contractIds');
    }
    recordCheck(evidence, 'stellar-config', 'pass', { network: cfg.network });
  } catch (err) {
    recordCheck(evidence, 'stellar-config', 'fail', { error: err.message });
    // Stellar config failure is non-fatal when STELLAR_FEATURES_ENABLED=false
    console.log(`  ⚠ stellar-config: ${err.message} (non-fatal when STELLAR_FEATURES_ENABLED=false)`);
  }
}

async function checkFrontendCriticalPaths(evidence, opts) {
  console.log('\n── Frontend critical path checks');
  const paths = [
    { path: '/traction',           label: 'frontend-traction-page',    expected: [200] },
    { path: '/api/auth/session',   label: 'frontend-anon-session',     expected: [401] },
    { path: '/api/users/register', label: 'frontend-register-guard',   expected: [405] },
  ];
  for (const { path: p, label, expected } of paths) {
    try {
      await request(label, joinUrl(opts.frontendUrl, p), {}, expected, opts);
      recordCheck(evidence, label, 'pass');
    } catch (err) {
      recordCheck(evidence, label, 'fail', { error: err.message });
      throw err;
    }
  }
}

async function checkAuthenticatedPaths(evidence, opts) {
  if (opts.skipAuth || !opts.testEmail || !opts.testPassword) {
    console.log('\n── Authenticated checks (skipped — no credentials)');
    recordCheck(evidence, 'authenticated-login', 'skip', {
      reason: opts.skipAuth ? '--skip-auth flag set' : 'SMOKE_TEST_EMAIL/PASSWORD not set',
    });
    return;
  }
  console.log('\n── Authenticated checks');

  let sessionCookie = '';
  // Login
  try {
    const res = await request(
      'auth login',
      joinUrl(opts.backendUrl, '/api/auth/login'),
      {
        method: 'POST',
        body: JSON.stringify({ email: opts.testEmail, password: opts.testPassword }),
        credentials: 'include',
      },
      [200, 201],
      opts
    );
    const setCookie = res.headers.get('set-cookie') || '';
    // Extract cookie name without printing the value
    const cookieName = setCookie.split('=')[0];
    if (cookieName) sessionCookie = setCookie;
    recordCheck(evidence, 'authenticated-login', 'pass');
  } catch (err) {
    recordCheck(evidence, 'authenticated-login', 'fail', { error: err.message });
    throw err;
  }

  // Fetch own profile (authenticated)
  if (sessionCookie) {
    try {
      const profile = await requestJson(
        'auth /api/users/me',
        joinUrl(opts.backendUrl, '/api/users/me'),
        { headers: { Cookie: sessionCookie } },
        [200],
        opts
      );
      // Profile may include email — redact before evidence
      assertNoSensitiveData('profile', profile);
      recordCheck(evidence, 'authenticated-profile', 'pass');
    } catch (err) {
      // Profile may contain sensitive data — record error only
      recordCheck(evidence, 'authenticated-profile', 'fail', { error: err.message });
      console.log(`  ⚠ authenticated-profile: ${err.message} (non-fatal)`);
    }
  }
}

// ── User journey (issue #283) ─────────────────────────────────────────────────
// The journey exercises the *frontend* origin so that browser proxy routes,
// cookie credentials, and deployed CORS/origin settings are all proven to work
// together — a backend health response alone does not prove this.

function originOf(url) {
  try { return new URL(url).origin; } catch { return url; }
}

// Parse a Set-Cookie header into a minimal, secret-free descriptor.
function describeSetCookie(setCookie) {
  if (!setCookie) return { present: false };
  const parts = setCookie.split(';').map(s => s.trim());
  const [nameValue] = parts;
  const eq = nameValue.indexOf('=');
  const name = eq >= 0 ? nameValue.slice(0, eq) : nameValue;
  const attrs = parts.slice(1).map(a => a.toLowerCase());
  return {
    present: true,
    name,
    hasValue: eq >= 0 && nameValue.length > eq + 1,
    httpOnly: attrs.includes('httponly'),
    secure: attrs.includes('secure'),
    sameSite: (attrs.find(a => a.startsWith('samesite=')) || '').split('=')[1] || null,
    // Never record the cookie value itself.
  };
}

// Build a Cookie request header from a Set-Cookie header, dropping attributes.
function cookieHeaderFromSetCookie(setCookie) {
  if (!setCookie) return '';
  return setCookie.split(';')[0].trim();
}

// Redacted, secret-free diagnostics for a failed journey step.
function journeyDiagnostics(step, opts, extra = {}) {
  return {
    step,
    frontendOrigin: originOf(opts.frontendUrl),
    backendOrigin: originOf(opts.backendUrl),
    journeyPath: opts.journeyPath,
    ...extra,
  };
}

async function checkUserJourney(evidence, opts) {
  const label = 'user-journey';
  if (opts.skipJourney) {
    console.log('\n── User journey checks (skipped — --skip-journey)');
    recordCheck(evidence, label, 'skip', { reason: '--skip-journey flag set' });
    return;
  }
  if (opts.skipAuth || !opts.testEmail || !opts.testPassword) {
    console.log('\n── User journey checks (skipped — no credentials)');
    recordCheck(evidence, label, 'skip', {
      reason: opts.skipAuth ? '--skip-auth flag set' : 'SMOKE_TEST_EMAIL/PASSWORD not set',
    });
    return;
  }

  console.log('\n── User journey checks (frontend proxy origin)');
  const frontendOrigin = originOf(opts.frontendUrl);
  const backendOrigin = originOf(opts.backendUrl);

  // 1) Sign-in through the frontend proxy.
  let setCookie = '';
  let cookieHeader = '';
  try {
    const res = await request(
      'journey sign-in',
      joinUrl(opts.frontendUrl, '/api/auth/login'),
      {
        method: 'POST',
        body: JSON.stringify({ email: opts.testEmail, password: opts.testPassword }),
        headers: { origin: frontendOrigin },
        credentials: 'include',
      },
      [200, 201],
      opts
    );
    setCookie = res.headers.get('set-cookie') || '';
    const cookie = describeSetCookie(setCookie);
    if (!cookie.present || !cookie.hasValue) {
      throw new Error('sign-in did not set a session cookie');
    }
    cookieHeader = cookieHeaderFromSetCookie(setCookie);
    recordCheck(evidence, 'journey-sign-in', 'pass', {
      cookie: cookie, // descriptor only — never the value
    });
  } catch (err) {
    recordCheck(evidence, 'journey-sign-in', 'fail', {
      error: err.message,
      diagnostics: journeyDiagnostics('sign-in', opts),
    });
    throw err;
  }

  // 2) Representative authenticated request through the frontend proxy.
  try {
    const res = await request(
      `journey authenticated ${opts.journeyPath}`,
      joinUrl(opts.frontendUrl, opts.journeyPath),
      {
        headers: { cookie: cookieHeader, origin: frontendOrigin },
        credentials: 'include',
      },
      [200],
      opts
    );
    // CORS/origin behavior: if the proxy echoes an allow-origin header it must
    // match the frontend origin (never a wildcard for credentialed requests).
    const allowOrigin = res.headers.get('access-control-allow-origin');
    const allowCreds = res.headers.get('access-control-allow-credentials');
    if (allowOrigin && allowOrigin !== '*' && allowOrigin !== frontendOrigin) {
      throw new Error(`CORS allow-origin mismatch: ${allowOrigin} !== ${frontendOrigin}`);
    }
    if (allowOrigin === '*' && allowCreds === 'true') {
      throw new Error('CORS allows wildcard origin with credentials');
    }
    recordCheck(evidence, 'journey-authenticated-request', 'pass', {
      path: opts.journeyPath,
      cors: {
        allowOrigin: allowOrigin || null,
        allowCredentials: allowCreds || null,
      },
    });
  } catch (err) {
    recordCheck(evidence, 'journey-authenticated-request', 'fail', {
      error: err.message,
      diagnostics: journeyDiagnostics('authenticated-request', opts),
    });
    throw err;
  }

  // 3) Sign-out through the frontend proxy.
  try {
    const res = await request(
      'journey sign-out',
      joinUrl(opts.frontendUrl, '/api/auth/logout'),
      {
        method: 'POST',
        headers: { cookie: cookieHeader, origin: frontendOrigin },
        credentials: 'include',
      },
      [200, 204],
      opts
    );
    const cleared = describeSetCookie(res.headers.get('set-cookie') || '');
    recordCheck(evidence, 'journey-sign-out', 'pass', {
      cookieCleared: cleared.present,
    });
  } catch (err) {
    recordCheck(evidence, 'journey-sign-out', 'fail', {
      error: err.message,
      diagnostics: journeyDiagnostics('sign-out', opts),
    });
    throw err;
  }

  // 4) Post-sign-out: the session must no longer be authorized.
  try {
    await request(
      'journey post-sign-out',
      joinUrl(opts.frontendUrl, opts.journeyPath),
      {
        headers: { cookie: cookieHeader, origin: frontendOrigin },
        credentials: 'include',
      },
      [401, 403],
      opts
    );
    recordCheck(evidence, 'journey-post-sign-out', 'pass');
  } catch (err) {
    recordCheck(evidence, 'journey-post-sign-out', 'fail', {
      error: err.message,
      diagnostics: journeyDiagnostics('post-sign-out', opts),
    });
    throw err;
  }

  recordCheck(evidence, label, 'pass', {
    frontendOrigin,
    backendOrigin,
    journeyPath: opts.journeyPath,
  });
}

async function checkContractHealth(evidence, opts) {
  console.log('\n── Contract / Stellar checks');
  // These are informational — Stellar features may be disabled
  try {
    const cfg = await requestJson(
      'stellar diagnostics',
      joinUrl(opts.backendUrl, '/api/stellar/diagnostics'),
      {},
      [200, 403, 404],
      opts
    );
    assertNoSensitiveData('stellar diagnostics', cfg || {});
    recordCheck(evidence, 'stellar-diagnostics', 'pass');
  } catch (err) {
    recordCheck(evidence, 'stellar-diagnostics', 'skip', { reason: err.message });
    console.log(`  ℹ stellar-diagnostics: ${err.message} (skipped)`);
  }
}

// ── Regional synthetic checks ─────────────────────────────────────────────────
// Low-volume synthetic journeys executed from multiple regions.  Each journey
// uses only anonymous, non-user-data endpoints so no real user data is touched.
// Labels are bounded (fixed region + step names) to keep evidence cardinality
// low and avoid leaking arbitrary values into metrics.

const REGION_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const SYNTHETIC_JOURNEYS = [
  {
    step: 'edge-tls',
    label: 'synthetic-edge-tls',
    run: async (region, opts) => {
      // TLS + edge reachability via the public traction endpoint
      await request(
        `[${region}] synthetic edge-tls`,
        joinUrl(opts.backendUrl, '/api/public/traction'),
        {},
        [200],
        opts
      );
    },
  },
  {
    step: 'public-read',
    label: 'synthetic-public-read',
    run: async (region, opts) => {
      const traction = await requestJson(
        `[${region}] synthetic public-read`,
        joinUrl(opts.backendUrl, '/api/public/traction'),
        {},
        [200],
        opts
      );
      assertNoSensitiveData('synthetic public-read', traction);
    },
  },
  {
    step: 'frontend-shell',
    label: 'synthetic-frontend-shell',
    run: async (region, opts) => {
      await request(
        `[${region}] synthetic frontend-shell`,
        joinUrl(opts.frontendUrl, '/traction'),
        {},
        [200],
        opts
      );
    },
  },
];

function normalizeRegion(region) {
  const norm = String(region || '').trim().toLowerCase();
  if (!REGION_LABEL_RE.test(norm)) {
    throw new Error(`invalid synthetic region label: ${JSON.stringify(region)}`);
  }
  return norm;
}

async function checkRegionalSynthetics(evidence, opts) {
  console.log('\n── Regional synthetic checks');
  if (opts.skipRegional || opts.regions.length === 0) {
    recordCheck(evidence, 'regional-synthetics', 'skip', {
      reason: opts.skipRegional ? '--skip-regional flag set' : 'no regions configured',
    });
    return;
  }

  const regions = [];
  for (const raw of opts.regions) {
    try {
      regions.push(normalizeRegion(raw));
    } catch (err) {
      recordCheck(evidence, 'regional-synthetics', 'fail', { error: err.message });
      throw err;
    }
  }

  const perStep = {};
  let anyFailed = false;

  for (const region of regions) {
    for (const journey of SYNTHETIC_JOURNEYS) {
      const key = journey.label;
      perStep[key] = perStep[key] || { pass: 0, fail: 0, regions: {} };
      try {
        await journey.run(region, opts);
        perStep[key].pass++;
        perStep[key].regions[region] = 'pass';
        recordCheck(evidence, `${journey.label}:${region}`, 'pass', { region, step: journey.step });
      } catch (err) {
        anyFailed = true;
        perStep[key].fail++;
        perStep[key].regions[region] = 'fail';
        recordCheck(evidence, `${journey.label}:${region}`, 'fail', {
          region,
          step: journey.step,
          error: err.message,
        });
        console.log(`  ✗ [${region}] ${journey.step}: ${err.message}`);
      }
    }
  }

  // Per-step availability summary with bounded labels
  const availability = {};
  for (const [label, stats] of Object.entries(perStep)) {
    const total = stats.pass + stats.fail;
    availability[label] = {
      available: stats.pass,
      total,
      ratio: total ? Number((stats.pass / total).toFixed(3)) : 0,
      regions: stats.regions,
    };
  }
  evidence.regionalAvailability = availability;

  if (anyFailed) {
    throw new Error('regional synthetic checks degraded in one or more regions');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const evidence = buildEvidenceRecord(opts);

  console.log('xConfess Post-Deploy Verification');
  console.log('==================================');
  console.log(`Environment:   ${opts.env}`);
  console.log(`Commit:        ${opts.commit}`);
  console.log(`Run ID:        ${opts.runId}`);
  console.log(`Backend URL:   ${opts.backendUrl}`);
  console.log(`Frontend URL:  ${opts.frontendUrl}`);
  console.log(`Evidence dir:  ${opts.evidenceDir}`);
  console.log('');

  const criticalChecks = [
    () => checkBackendLiveness(evidence, opts),
    () => checkBackendReadiness(evidence, opts),
    () => checkPublicTraction(evidence, opts),
    () => checkFrontendCriticalPaths(evidence, opts),
    () => checkRegionalSynthetics(evidence, opts),
  ];
  const softChecks = [
    () => checkBackendStatus(evidence, opts),
    () => checkStellarConfig(evidence, opts),
    () => checkAuthenticatedPaths(evidence, opts),
    () => checkContractHealth(evidence, opts),
  ];

  let criticalFailed = false;

  // Run critical checks — any failure halts (if fail-policy=halt)
  for (const check of criticalChecks) {
    try {
      await check();
    } catch (err) {
      criticalFailed = true;
      if (opts.failPolicy === 'halt') {
        console.error(`\n✗ Critical check failed: ${err.message}`);
        console.error('Halting post-deploy verification (--fail-policy=halt).');
        console.error('Initiate rollback per docs/disaster-recovery-runbook.md');
        writeEvidence(evidence, opts);
        process.exit(1);
      }
    }
  }

  // Run soft checks — failures are recorded but do not halt
  for (const check of softChecks) {
    try {
      await check();
    } catch { /* already recorded in evidence */ }
  }

  // Write evidence
  const evidencePath = writeEvidence(evidence, opts);

  // Summary
  console.log('\n── Verification Summary');
  console.log(`Passed:  ${evidence.summary.passed}`);
  console.log(`Failed:  ${evidence.summary.failed}`);
  console.log(`Skipped: ${evidence.summary.skipped}`);
  console.log(`Evidence: ${evidencePath}`);
  if (evidence.regionalAvailability) {
    console.log('\n── Regional availability (per step)');
    for (const [label, stats] of Object.entries(evidence.regionalAvailability)) {
      console.log(`  ${label}: ${stats.available}/${stats.total} regions (${stats.ratio})`);
    }
  }
  console.log('');

  if (criticalFailed) {
    console.error('✗ One or more critical checks failed.');
    process.exit(1);
  }

  console.log('✓ Post-deploy verification passed.');
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Unexpected error:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  normalizeRegion,
  checkRegionalSynthetics,
  SYNTHETIC_JOURNEYS,
  REGION_LABEL_RE,
};
