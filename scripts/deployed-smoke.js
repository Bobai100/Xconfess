#!/usr/bin/env node

const crypto = require('crypto');

const frontendUrl = process.env.SMOKE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://xconfess.vercel.app';
const backendUrl = process.env.SMOKE_BACKEND_URL || process.env.BACKEND_URL || 'https://xconfess-backend.onrender.com';
const runMutation = process.env.SMOKE_RUN_MUTATION === 'true';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 45000);
const maxAttempts = Math.max(1, Number(process.env.SMOKE_MAX_ATTEMPTS || process.env.SMOKE_RETRIES || 5));
const retryDelayMs = Math.max(0, Number(process.env.SMOKE_RETRY_DELAY_MS || 5000));
const smokeUsername = process.env.SMOKE_USERNAME || '';
const smokePassword = process.env.SMOKE_PASSWORD || '';
const runJourney = process.env.SMOKE_RUN_JOURNEY !== 'false';
const sessionCookieName = process.env.SMOKE_SESSION_COOKIE_NAME || 'xconfess_session';
const journeyPath = process.env.SMOKE_JOURNEY_PATH || '/api/auth/me';
const signInPath = process.env.SMOKE_SIGN_IN_PATH || '/api/auth/login';
const signOutPath = process.env.SMOKE_SIGN_OUT_PATH || '/api/auth/logout';
const expectedOrigin = process.env.SMOKE_EXPECTED_ORIGIN || frontendUrl;
=======

// Regional synthetic checks. Each region label is bounded to a small allowlist so
// metrics stay low-cardinality and never carry user data or free-form input.
const REGION_LABEL_PATTERN = /^[a-z]{2,3}-[a-z]{2,4}-\d{1,2}$/;
const MAX_REGIONS = 8;
const DEFAULT_REGION = 'local-xx-1';
const rawRegions = (process.env.SMOKE_REGIONS || process.env.SMOKE_REGION || '')
  .split(',')
  .map((region) => region.trim().toLowerCase())
  .filter(Boolean);
const regions = (rawRegions.length ? rawRegions : [DEFAULT_REGION]).slice(0, MAX_REGIONS);
const regionFailOnError = process.env.SMOKE_REGION_FAIL_ON_ERROR !== 'false';

// Bounded step labels for per-step availability reporting.
const STEP_LABELS = Object.freeze({
  backendLiveness: 'backend_liveness',
  backendReadiness: 'backend_readiness',
  backendHealthStatus: 'backend_health_status',
  publicTraction: 'public_traction',
  stellarConfig: 'stellar_config',
  frontendTractionPage: 'frontend_traction_page',
  frontendSessionAnonymous: 'frontend_session_anonymous',
  frontendRegisterGuard: 'frontend_register_guard',
  frontendRegistrationMutation: 'frontend_registration_mutation',
});

function validateRegion(region) {
  if (!REGION_LABEL_PATTERN.test(region)) {
    throw new Error(
      `invalid SMOKE_REGIONS entry "${region}"; expected bounded label like "us-east-1"`,
    );
  }
  return region;
}

function resolveRegionBaseUrls(region) {
  const suffix = region.toUpperCase().replace(/-/g, '_');
  const regionFrontend =
    process.env[`SMOKE_FRONTEND_URL_${suffix}`] || process.env.SMOKE_FRONTEND_URL || process.env.FRONTEND_URL || frontendUrl;
  const regionBackend =
    process.env[`SMOKE_BACKEND_URL_${suffix}`] || process.env.SMOKE_BACKEND_URL || process.env.BACKEND_URL || backendUrl;
  return { frontendUrl: regionFrontend, backendUrl: regionBackend };
}

function createStepReporter(region) {
  const steps = [];
  return {
    steps,
    async run(stepLabel, fn) {
      if (!Object.values(STEP_LABELS).includes(stepLabel)) {
        throw new Error(`unbounded synthetic step label: ${stepLabel}`);
      }
      const started = Date.now();
      try {
        const result = await fn();
        const latencyMs = Date.now() - started;
        steps.push({ region, step: stepLabel, ok: true, latencyMs });
        console.log(`synthetic step region=${region} step=${stepLabel} status=ok latency_ms=${latencyMs}`);
        return result;
      } catch (error) {
        const latencyMs = Date.now() - started;
        steps.push({ region, step: stepLabel, ok: false, latencyMs, error: error.message || String(error) });
        console.log(`synthetic step region=${region} step=${stepLabel} status=fail latency_ms=${latencyMs}`);
        throw error;
      }
    },
  };
}

function summarizeRegion(region, reporter) {
  const total = reporter.steps.length;
  const failed = reporter.steps.filter((step) => !step.ok).length;
  const availability = total === 0 ? 0 : ((total - failed) / total) * 100;
  return {
    region,
    total,
    failed,
    availability: Number(availability.toFixed(2)),
    steps: reporter.steps.map((step) => ({
      region: step.region,
      step: step.step,
      ok: step.ok,
      latencyMs: step.latencyMs,
    })),
  };
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayForAttempt(attempt) {
  return retryDelayMs * attempt;
}

function isRenderHibernateWake(response) {
  return response.headers.get('x-render-routing') === 'hibernate-wake-error';
}

function isRetryableFetchError(error) {
  return error && (error.name === 'AbortError' || error.name === 'TypeError');
}

async function request(name, url, options = {}, expectedStatuses = [200]) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      const latencyMs = Date.now() - started;
      const reason =
        error && error.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : error && error.message
            ? error.message
            : String(error);
      if (attempt < maxAttempts && isRetryableFetchError(error)) {
        console.log(`${name}: retrying after ${reason} (attempt ${attempt}/${maxAttempts})`);
        await sleep(retryDelayForAttempt(attempt));
        continue;
      }
      throw new Error(`${name} request to ${url} failed in ${latencyMs}ms: ${reason}`);
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = Date.now() - started;
    if (!expectedStatuses.includes(response.status)) {
      const body = await response.text().catch(() => '');
      if (attempt < maxAttempts && response.status === 503 && isRenderHibernateWake(response)) {
        console.log(`${name}: retrying Render hibernate wake response (attempt ${attempt}/${maxAttempts})`);
        await sleep(retryDelayForAttempt(attempt));
        continue;
      }
      throw new Error(`${name} returned ${response.status} in ${latencyMs}ms: ${body.slice(0, 500)}`);
    }
    console.log(`${name}: ${response.status} (${latencyMs}ms)`);
    return response;
  }
}

async function requestJson(name, url, options = {}, expectedStatuses = [200]) {
  const response = await request(name, url, options, expectedStatuses);
  return response.json();
}

function assertObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} did not return a JSON object`);
  }
}

function parseSetCookieHeaders(response) {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (raw.length > 0) return raw;
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function findSessionCookie(response) {
  const cookies = parseSetCookieHeaders(response);
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const name = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (name === sessionCookieName && value) {
      return { name, value, raw: cookie };
    }
  }
  return null;
}

function assertSessionCookieAttributes(name, cookie) {
  const lower = cookie.toLowerCase();
  if (!/httponly/.test(lower)) {
    throw new Error(`${name} session cookie is missing HttpOnly`);
  }
  if (!/samesite=(lax|strict|none)/.test(lower)) {
    throw new Error(`${name} session cookie is missing SameSite`);
  }
  if (frontendUrl.startsWith('https://') && !/;\s*secure/.test(lower)) {
    throw new Error(`${name} session cookie is missing Secure on an https deployment`);
  }
}

function assertCorsHeaders(name, response) {
  const allowOrigin = response.headers.get('access-control-allow-origin');
  if (!allowOrigin) {
    throw new Error(`${name} response is missing Access-Control-Allow-Origin`);
  }
  if (allowOrigin !== '*' && allowOrigin !== expectedOrigin) {
    throw new Error(`${name} Access-Control-Allow-Origin ${allowOrigin} does not match expected origin ${expectedOrigin}`);
  }
  if (allowOrigin !== '*') {
    const allowCredentials = response.headers.get('access-control-allow-credentials');
    if (allowCredentials !== 'true') {
      throw new Error(`${name} response is missing Access-Control-Allow-Credentials for a credentialed origin`);
    }
  }
}

function assertNoSensitiveKeys(name, value, path = '') {
=======
  if (!value || typeof value !== 'object') return;

  const sensitiveKeys = new Set([
    'authorization',
    'body',
    'content',
    'email',
    'ip',
    'ipaddress',
    'jwt',
    'message',
    'password',
    'passwordhash',
    'phone',
    'privatekey',
    'rawip',
    'seed',
    'seedphrase',
    'sessiontoken',
    'token',
    'useragent',
  ]);
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      sensitiveKeys.has(normalized) ||
      normalized.endsWith('token') ||
      normalized.includes('privatekey') ||
      normalized.includes('seedphrase')
    ) {
      throw new Error(`${name} exposed sensitive key: ${nextPath}`);
    }
    assertNoSensitiveKeys(name, child, nextPath);
  }
}

async function runRegionJourney(region) {
  const bases = resolveRegionBaseUrls(region);
  const reporter = createStepReporter(region);

  await reporter.run(STEP_LABELS.backendLiveness, () =>
    requestJson('backend liveness', joinUrl(bases.backendUrl, '/api/health/live')),
  );
  await reporter.run(STEP_LABELS.backendReadiness, () =>
    requestJson('backend readiness', joinUrl(bases.backendUrl, '/api/health/ready')),
  );
  const healthStatus = await reporter.run(STEP_LABELS.backendHealthStatus, () =>
    requestJson('backend health status', joinUrl(bases.backendUrl, '/api/health/status'), {}, [200, 503]),
  );
  assertObject('backend health status', healthStatus);

  const traction = await reporter.run(STEP_LABELS.publicTraction, () =>
    requestJson('public traction API', joinUrl(bases.backendUrl, '/api/public/traction')),
  );
  assertObject('public traction API', traction);
  assertNoSensitiveKeys('public traction API', traction);
  if (!traction.users || !traction.engagement || !traction.stellar || !traction.reliability) {
    throw new Error('public traction API is missing required aggregate sections');
  }

  const stellarConfig = await reporter.run(STEP_LABELS.stellarConfig, () =>
    requestJson('public Stellar config', joinUrl(bases.backendUrl, '/api/stellar/config')),
  );
  assertObject('public Stellar config', stellarConfig);
  assertNoSensitiveKeys('public Stellar config', stellarConfig);
  if (!stellarConfig.network || !stellarConfig.contractIds) {
    throw new Error('public Stellar config is missing network or contractIds');
  }

  await reporter.run(STEP_LABELS.frontendTractionPage, () =>
    request('frontend traction page', joinUrl(bases.frontendUrl, '/traction'), {}, [200]),
  );
  await reporter.run(STEP_LABELS.frontendSessionAnonymous, () =>
    request('frontend session anonymous', joinUrl(bases.frontendUrl, '/api/auth/session'), {}, [401]),
  );
  await reporter.run(STEP_LABELS.frontendRegisterGuard, () =>
    request('frontend register method guard', joinUrl(bases.frontendUrl, '/api/users/register'), {}, [405]),
  );

  if (runJourney) {
    await verifyUserJourney();
  } else {
    console.log('user journey skipped; set SMOKE_RUN_JOURNEY=false only when credentials are unavailable');
  }

  if (runMutation) {
    // Synthetic-only identity: disposable, non-routable example.com address and
    // random suffix. No real user data is ever sent by these journeys.
    const suffix = crypto.randomBytes(4).toString('hex');
    await reporter.run(STEP_LABELS.frontendRegistrationMutation, () =>
      request(
        'frontend registration mutation',
        joinUrl(bases.frontendUrl, '/api/users/register'),
        {
          method: 'POST',
          body: JSON.stringify({
            username: `smoke_${suffix}`,
            email: `smoke_${suffix}@example.com`,
            password: `SmokePass!${suffix}A1`,
          }),
        },
        [200, 201, 409],
      ),
    );
  } else {
    console.log('registration mutation skipped; set SMOKE_RUN_MUTATION=true to create a disposable account');
  }

  return summarizeRegion(region, reporter);
}

async function main() {
  const validatedRegions = regions.map(validateRegion);
  const summaries = [];
  const failures = [];

  for (const region of validatedRegions) {
    try {
      summaries.push(await runRegionJourney(region));
    } catch (error) {
      const message = error.message || String(error);
      console.error(`synthetic region=${region} status=fail reason=${message}`);
      failures.push({ region, message });
    }
  }

  const report = {
    regions: summaries,
    failedRegions: failures.map((failure) => failure.region),
  };
  console.log(`synthetic report ${JSON.stringify(report)}`);

  if (failures.length > 0 && regionFailOnError) {
    const detail = failures.map((failure) => `${failure.region}: ${failure.message}`).join('; ');
    throw new Error(`regional synthetic checks failed for ${failures.length} region(s): ${detail}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
