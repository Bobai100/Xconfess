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

async function verifyUserJourney() {
  if (!smokeUsername || !smokePassword) {
    throw new Error('SMOKE_USERNAME and SMOKE_PASSWORD are required to verify the deployed user journey');
  }

  const originHeaders = { origin: expectedOrigin };

  const preflight = await request(
    'journey CORS preflight',
    joinUrl(backendUrl, signInPath),
    { method: 'OPTIONS', headers: { ...originHeaders, 'access-control-request-method': 'POST' } },
    [200, 204],
  );
  assertCorsHeaders('journey CORS preflight', preflight);

  const anonymousJourney = await request(
    'journey anonymous authenticated request',
    joinUrl(backendUrl, journeyPath),
    { headers: originHeaders },
    [401, 403],
  );
  assertCorsHeaders('journey anonymous authenticated request', anonymousJourney);

  const signInResponse = await request(
    'journey sign-in',
    joinUrl(backendUrl, signInPath),
    {
      method: 'POST',
      headers: originHeaders,
      body: JSON.stringify({ username: smokeUsername, password: smokePassword }),
    },
    [200, 201],
  );
  assertCorsHeaders('journey sign-in', signInResponse);
  const sessionCookie = findSessionCookie(signInResponse);
  if (!sessionCookie) {
    throw new Error(`journey sign-in did not set the ${sessionCookieName} session cookie`);
  }
  assertSessionCookieAttributes('journey sign-in', sessionCookie.raw);

  const authenticated = await request(
    'journey authenticated request',
    joinUrl(backendUrl, journeyPath),
    { headers: { ...originHeaders, cookie: `${sessionCookie.name}=${sessionCookie.value}` } },
    [200],
  );
  assertCorsHeaders('journey authenticated request', authenticated);
  const authenticatedBody = await authenticated.json().catch(() => null);
  assertObject('journey authenticated request', authenticatedBody);
  assertNoSensitiveKeys('journey authenticated request', authenticatedBody);

  const signOutResponse = await request(
    'journey sign-out',
    joinUrl(backendUrl, signOutPath),
    {
      method: 'POST',
      headers: { ...originHeaders, cookie: `${sessionCookie.name}=${sessionCookie.value}` },
    },
    [200, 204],
  );
  assertCorsHeaders('journey sign-out', signOutResponse);
  const clearedCookie = findSessionCookie(signOutResponse);
  if (clearedCookie && clearedCookie.value) {
    throw new Error('journey sign-out did not clear the session cookie');
  }

  await request(
    'journey post-sign-out authenticated request',
    joinUrl(backendUrl, journeyPath),
    { headers: { ...originHeaders, cookie: `${sessionCookie.name}=${sessionCookie.value}` } },
    [401, 403],
  );

  console.log('user journey verified: sign-in, authenticated request, sign-out');
}

async function main() {
  await requestJson('backend liveness', joinUrl(backendUrl, '/api/health/live'));
  await requestJson('backend readiness', joinUrl(backendUrl, '/api/health/ready'));
  const healthStatus = await requestJson('backend health status', joinUrl(backendUrl, '/api/health/status'), {}, [200, 503]);
  assertObject('backend health status', healthStatus);

  const traction = await requestJson('public traction API', joinUrl(backendUrl, '/api/public/traction'));
  assertObject('public traction API', traction);
  assertNoSensitiveKeys('public traction API', traction);
  if (!traction.users || !traction.engagement || !traction.stellar || !traction.reliability) {
    throw new Error('public traction API is missing required aggregate sections');
  }

  const stellarConfig = await requestJson('public Stellar config', joinUrl(backendUrl, '/api/stellar/config'));
  assertObject('public Stellar config', stellarConfig);
  assertNoSensitiveKeys('public Stellar config', stellarConfig);
  if (!stellarConfig.network || !stellarConfig.contractIds) {
    throw new Error('public Stellar config is missing network or contractIds');
  }

  await request('frontend traction page', joinUrl(frontendUrl, '/traction'), {}, [200]);
  await request('frontend session anonymous', joinUrl(frontendUrl, '/api/auth/session'), {}, [401]);
  await request('frontend register method guard', joinUrl(frontendUrl, '/api/users/register'), {}, [405]);

  if (runJourney) {
    await verifyUserJourney();
  } else {
    console.log('user journey skipped; set SMOKE_RUN_JOURNEY=false only when credentials are unavailable');
  }

  if (runMutation) {
    const suffix = crypto.randomBytes(4).toString('hex');
    await request(
      'frontend registration mutation',
      joinUrl(frontendUrl, '/api/users/register'),
      {
        method: 'POST',
        body: JSON.stringify({
          username: `smoke_${suffix}`,
          email: `smoke_${suffix}@example.com`,
          password: `SmokePass!${suffix}A1`,
        }),
      },
      [200, 201, 409],
    );
  } else {
    console.log('registration mutation skipped; set SMOKE_RUN_MUTATION=true to create a disposable account');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
