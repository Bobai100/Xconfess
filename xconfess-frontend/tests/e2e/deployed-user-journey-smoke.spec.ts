import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * Post-deploy smoke: verifies the deployed user journey across frontend and
 * backend origins. A backend health response alone does not prove that browser
 * proxy routes, cookie credentials, and deployed CORS/origin settings work
 * together, so this spec drives the real browser against the deployed frontend
 * origin and asserts:
 *
 *   1. Sign-in succeeds through the deployed frontend origin and the session
 *      cookie is set with credentials (HttpOnly, SameSite, Secure in prod).
 *   2. A representative authenticated request succeeds via the frontend proxy
 *      route and returns the authenticated user's data (not a 401/403).
 *   3. Sign-out clears the session cookie and subsequent authenticated requests
 *      are rejected with an explicit authorization failure (401/403).
 *
 * Diagnostics are secret-free: we never log tokens, cookies, passwords, or
 * response bodies that could contain credentials. Only status codes, route
 * paths, and boolean cookie-presence flags are emitted.
 *
 * Run with: npm run post-deploy:verify:staging
 */

const FRONTEND_ORIGIN = process.env.DEPLOYED_FRONTEND_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? '';
const BACKEND_ORIGIN = process.env.DEPLOYED_BACKEND_ORIGIN ?? process.env.BACKEND_ORIGIN ?? '';

const SMOKE_EMAIL = process.env.POST_DEPLOY_SMOKE_EMAIL ?? '';
const SMOKE_PASSWORD = process.env.POST_DEPLOY_SMOKE_PASSWORD ?? '';

// Route paths are deployment-stable; origins are deployment-specific.
const SIGN_IN_PATH = process.env.POST_DEPLOY_SIGN_IN_PATH ?? '/login';
const SIGN_OUT_PATH = process.env.POST_DEPLOY_SIGN_OUT_PATH ?? '/api/auth/logout';
const SESSION_PATH = process.env.POST_DEPLOY_SESSION_PATH ?? '/api/auth/session';
const AUTHENTICATED_PATH = process.env.POST_DEPLOY_AUTHENTICATED_PATH ?? '/api/users/me';

const SESSION_COOKIE_NAME = process.env.POST_DEPLOY_SESSION_COOKIE ?? 'xconfess_session';

function requireEnv(name: string, value: string): string {
  if (!value) {
    throw new Error(
      `[post-deploy-smoke] Missing required environment variable: ${name}. ` +
        'Set deployment-specific URLs and smoke credentials before running ' +
        '`npm run post-deploy:verify:staging`.',
    );
  }
  return value;
}

function joinUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

async function findSessionCookie(context: BrowserContext) {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
}

async function signInThroughUi(page: Page, email: string, password: string): Promise<void> {
  const signInUrl = joinUrl(FRONTEND_ORIGIN, SIGN_IN_PATH);
  const response = await page.goto(signInUrl, { waitUntil: 'domcontentloaded' });
  expect(response, 'sign-in page navigation should return a response').not.toBeNull();
  expect(response!.status(), 'sign-in page should load successfully').toBeLessThan(400);

  const emailInput = page
    .locator('input[type="email"], input[name="email"], input[autocomplete="username"]')
    .first();
  const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
  const submitButton = page
    .locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")')
    .first();

  await expect(emailInput, 'sign-in email field should be visible').toBeVisible();
  await expect(passwordInput, 'sign-in password field should be visible').toBeVisible();

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const [signInResponse] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        /(sign[-_]?in|login|auth)/i.test(new URL(res.url()).pathname),
      { timeout: 30_000 },
    ),
    submitButton.click(),
  ]);

  expect(
    signInResponse.status(),
    `sign-in POST should succeed (got ${signInResponse.status()})`,
  ).toBeLessThan(400);
}

test.describe('deployed user journey smoke', () => {
  test.beforeAll(() => {
    requireEnv('DEPLOYED_FRONTEND_ORIGIN', FRONTEND_ORIGIN);
    requireEnv('DEPLOYED_BACKEND_ORIGIN', BACKEND_ORIGIN);
    requireEnv('POST_DEPLOY_SMOKE_EMAIL', SMOKE_EMAIL);
    requireEnv('POST_DEPLOY_SMOKE_PASSWORD', SMOKE_PASSWORD);
  });

  test('sign-in, authenticated request, and sign-out work across origins', async ({
    page,
    context,
    request,
  }) => {
    // --- 1. Sign in through the deployed frontend origin -------------------
    await signInThroughUi(page, SMOKE_EMAIL, SMOKE_PASSWORD);

    const sessionCookie = await findSessionCookie(context);
    expect(sessionCookie, 'session cookie should be set after sign-in').toBeDefined();
    expect(sessionCookie!.httpOnly, 'session cookie should be HttpOnly').toBe(true);
    // SameSite must be set so cross-origin credentialed requests are governed
    // by an explicit policy rather than the browser default.
    expect(['Lax', 'Strict', 'None']).toContain(sessionCookie!.sameSite);
    if (sessionCookie!.sameSite === 'None') {
      expect(sessionCookie!.secure, 'SameSite=None requires Secure').toBe(true);
    }

    // --- 2. Representative authenticated request via frontend proxy --------
    const sessionUrl = joinUrl(FRONTEND_ORIGIN, SESSION_PATH);
    const sessionResponse = await page.request.get(sessionUrl, { failOnStatusCode: false });
    expect(
      sessionResponse.status(),
      `authenticated session request should succeed (got ${sessionResponse.status()})`,
    ).toBe(200);

    const authenticatedUrl = joinUrl(FRONTEND_ORIGIN, AUTHENTICATED_PATH);
    const authenticatedResponse = await page.request.get(authenticatedUrl, {
      failOnStatusCode: false,
    });
    expect(
      authenticatedResponse.status(),
      `authenticated request should succeed (got ${authenticatedResponse.status()})`,
    ).toBe(200);

    // The frontend proxy must forward to the backend origin; a successful
    // authenticated response proves proxy routing + cookie forwarding work.
    const authenticatedBody = await authenticatedResponse.json().catch(() => null);
    expect(authenticatedBody, 'authenticated response should be valid JSON').not.toBeNull();

    // --- 3. Sign out and verify authorization is revoked -------------------
    const signOutUrl = joinUrl(FRONTEND_ORIGIN, SIGN_OUT_PATH);
    const signOutResponse = await page.request.post(signOutUrl, { failOnStatusCode: false });
    expect(
      signOutResponse.status(),
      `sign-out should succeed (got ${signOutResponse.status()})`,
    ).toBeLessThan(400);

    const cookieAfterSignOut = await findSessionCookie(context);
    expect(
      cookieAfterSignOut,
      'session cookie should be cleared after sign-out',
    ).toBeUndefined();

    const postSignOutResponse = await page.request.get(authenticatedUrl, {
      failOnStatusCode: false,
    });
    expect(
      isAuthFailure(postSignOutResponse.status()),
      `authenticated request after sign-out should be rejected with 401/403 (got ${postSignOutResponse.status()})`,
    ).toBe(true);
  });

  test('unauthenticated request to protected route is rejected', async ({ request }) => {
    // Fresh request context with no cookies: proves the protected route enforces
    // authorization rather than relying on client-side gating.
    const anonymousContext: APIRequestContext = request;
    const authenticatedUrl = joinUrl(FRONTEND_ORIGIN, AUTHENTICATED_PATH);
    const response = await anonymousContext.get(authenticatedUrl, { failOnStatusCode: false });
    expect(
      isAuthFailure(response.status()),
      `unauthenticated request should be rejected with 401/403 (got ${response.status()})`,
    ).toBe(true);
  });

  test('backend CORS preflight allows the deployed frontend origin', async ({ request }) => {
    // Verifies deployed CORS settings accept credentialed requests from the
    // frontend origin, which browser proxy routes depend on.
    const preflightUrl = joinUrl(BACKEND_ORIGIN, AUTHENTICATED_PATH);
    const response = await request.fetch(preflightUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: FRONTEND_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      },
      failOnStatusCode: false,
    });

    expect(
      response.status(),
      `CORS preflight should succeed (got ${response.status()})`,
    ).toBeLessThan(400);

    const allowOrigin = response.headers()['access-control-allow-origin'];
    expect(
      allowOrigin,
      'backend should allow the deployed frontend origin',
    ).toBe(FRONTEND_ORIGIN);

    const allowCredentials = response.headers()['access-control-allow-credentials'];
    expect(
      allowCredentials,
      'backend should allow credentialed requests from the frontend origin',
    ).toBe('true');
  });
});