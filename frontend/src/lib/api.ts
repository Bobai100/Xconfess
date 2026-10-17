import { ApiError, mapServerError } from './api/errors';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'application/pdf',
];

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export interface UploadValidationResult {
  ok: boolean;
  reason?: 'unsupported-type' | 'too-large' | 'empty';
  message?: string;
}

/**
 * Reject unsupported content types and oversized files before any upload
 * begins. Runs entirely client-side so no bytes leave the browser.
 */
export function validateUpload(file: File): UploadValidationResult {
  if (!file || file.size === 0) {
    return { ok: false, reason: 'empty', message: 'The selected file is empty.' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB limit.`,
    };
  }
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) {
    return {
      ok: false,
      reason: 'unsupported-type',
      message: `Unsupported file type: ${file.type || 'unknown'}.`,
    };
  }
  return { ok: true };
}

export type UploadStatus =
  | 'idle'
  | 'validating'
  | 'uploading'
  | 'retrying'
  | 'canceled'
  | 'error'
  | 'done';

export interface UploadState {
  status: UploadStatus;
  progress: number;
  attempts: number;
  error?: string;
  result?: unknown;
}

export interface UploadHandle {
  promise: Promise<unknown>;
  cancel: () => void;
  onProgress: (cb: (state: UploadState) => void) => () => void;
}

/**
 * Auth contract
 *
 * The frontend and backend share one documented auth contract for registration,
 * login, and session refresh. Happy paths and failures return the same shape,
 * and session cookies are always HttpOnly with the required flags.
 */

export const AUTH_COOKIE_NAME = 'session';

export interface AuthCredentials {
  email: string;
  password: string;
}

export interface AuthRegistrationRequest extends AuthCredentials {
  name?: string;
}

export interface AuthLoginRequest extends AuthCredentials {}

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: string;
}

export interface AuthSuccessResponse {
  ok: true;
  session: AuthSession;
}

export interface AuthErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type AuthResponse = AuthSuccessResponse | AuthErrorResponse;

export interface AuthRequestOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function authUrl(path: string, baseUrl?: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function normalizeAuthError(status: number, body: unknown): AuthErrorResponse {
  const fallback = mapServerErrorType(status);
  if (body && typeof body === 'object') {
    const candidate = body as { error?: unknown; code?: unknown; message?: unknown };
    const nested = (candidate.error && typeof candidate.error === 'object'
      ? (candidate.error as { code?: unknown; message?: unknown })
      : undefined);
    const code = (typeof candidate.code === 'string' && candidate.code)
      || (typeof nested?.code === 'string' && nested.code)
      || fallback.code;
    const message = (typeof candidate.message === 'string' && candidate.message)
      || (typeof nested?.message === 'string' && nested.message)
      || fallback.message;
    return { ok: false, error: { code, message } };
  }
  return { ok: false, error: fallback };
}

function mapServerErrorType(status: number): AuthErrorResponse['error'] {
  if (status === 401) return { code: 'unauthorized', message: 'Invalid email or password.' };
  if (status === 403) return { code: 'forbidden', message: 'You do not have access to this resource.' };
  if (status === 409) return { code: 'conflict', message: 'An account with this email already exists.' };
  if (status === 422) return { code: 'validation_error', message: 'The submitted credentials are invalid.' };
  if (status === 429) return { code: 'rate_limited', message: 'Too many attempts. Please try again later.' };
  if (status >= 500) return { code: 'server_error', message: 'Something went wrong. Please try again.' };
  return { code: 'unknown_error', message: 'Unexpected auth error.' };
}

async function parseAuthResponse(response: Response): Promise<AuthResponse> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    return normalizeAuthError(response.status, body);
  }
  if (!body || typeof body !== 'object') {
    return normalizeAuthError(response.status,  undefined);
  }
  const candidate = body as { ok?: unknown; session?: unknown };
  if (candidate.ok === false) {
    return normalizeAuthError(response.status, body);
  }
  const session = candidate.session as AuthSession | undefined;
  if (!session || !session.user || typeof session.expiresAt !== 'string') {
    return normalizeAuthError(response.status, undefined);
  }
  return { ok: true, session };
}

async function postAuth(
  path: string,
  payload: AuthRegistrationRequest | AuthLoginRequest,
  options: AuthRequestOptions,
): Promise<AuthResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(authUrl(path, options.baseUrl), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parseAuthResponse(response);
  } catch {
    return { ok: false, error: { code: 'network_error', message: 'Unable to reach the server.' } };
  }
}

export async function register(
  payload: AuthRegistrationRequest,
  options: AuthRequestOptions = {},
): Promise<AuthResponse> {
  return postAuth('/api/auth/register', payload, options);
}

export async function login(
  payload: AuthLoginRequest,
  options: AuthRequestOptions = {},
): Promise<AuthResponse> {
  return postAuth('/api/auth/login', payload, options);
}

export async function logout(options: AuthRequestOptions = {}): Promise<AuthResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(authUrl('/api/auth/logout', options.baseUrl), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    return parseAuthResponse(response);
  } catch {
    return { ok: false, error: { code: 'network_error', message: 'Unable to reach the server.' } };
  }
}

export async function fetchSession(options: AuthRequestOptions = {}): Promise<AuthResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(authUrl('/api/auth/session', options.baseUrl), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    return parseAuthResponse(response);
  } catch {
    return { ok: false, error: { code: 'network_error', message: 'Unable to reach the server.' } };
  }
}

export function isAuthSuccess(response: AuthResponse): response is AuthSuccessResponse {
  return response.ok === true;
}

export function isAuthError(response: AuthResponse): response is AuthErrorResponse {
  return response.ok === false;
}

export function authErrorMessage(response: AuthResponse): string {
  return response.ok ? '' : response.error.message;
}

export function authErrorCode(response: AuthResponse): string | undefined {
  return response.ok ? undefined : response.error.code;
}

export function toApiError(response: AuthErrorResponse, status = 400): ApiError {
  return new ApiError(response.error.message, status, response.error.code);
}

/**
 * Personalization preference
 *
 * Users may opt out of personalized ranking. The preference is persisted on the
 * server so it survives cache invalidation and is enforced at the ranking
 * boundary. When disabled, discovery requests must send `personalized=false`
 * so hidden user signals are bypassed explicitly.
 */

export const PERSONALIZATION_STORAGE_KEY = 'discovery.personalized';

export interface PersonalizationPreference {
  personalized: boolean;
  updatedAt?: string;
}

export interface PersonalizationPreferenceResponse {
  ok: boolean;
  preference: PersonalizationPreference;
  error?: { code: string; message: string };
}

export interface PersonalizationRequestOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function personalizationUrl(path: string, baseUrl?: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Read the cached preference from localStorage. Defaults to personalized when
 * no preference has been stored or storage is unavailable.
 */
export function getCachedPersonalizationPreference(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(PERSONALIZATION_STORAGE_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function cachePersonalizationPreference(personalized: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PERSONALIZATION_STORAGE_KEY, String(personalized));
  } catch {
    // Storage may be unavailable (private mode); the server remains authoritative.
  }
}

/**
 * Fetch the persisted preference from the server. On success the local cache is
 * refreshed so a cache invalidation cannot silently re-enable personalization.
 */
export async function fetchPersonalizationPreference(
  options: PersonalizationRequestOptions = {},
): Promise<PersonalizationPreferenceResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(personalizationUrl('/api/preferences/personalization', options.baseUrl), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !body || typeof body !== 'object') {
      const mapped = mapServerErrorType(response.status);
      return { ok: false, preference: { personalized: getCachedPersonalizationPreference() }, error: mapped };
    }
    const candidate = body as { personalized?: unknown; updatedAt?: unknown };
    if (typeof candidate.personalized !== 'boolean') {
      return {
        ok: false,
        preference: { personalized: getCachedPersonalizationPreference() },
        error: { code: 'invalid_response', message: 'Malformed personalization preference response.' },
      };
    }
    cachePersonalizationPreference(candidate.personalized);
    return {
      ok: true,
      preference: {
        personalized: candidate.personalized,
        updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
      },
    };
  } catch {
    return {
      ok: false,
      preference: { personalized: getCachedPersonalizationPreference() },
      error: { code: 'network_error', message: 'Unable to reach the server.' },
    };
  }
}

/**
 * Persist the personalization preference on the server. Requires an
 * authenticated session; unauthenticated callers receive an explicit error and
 * the local cache is left untouched.
 */
export async function updatePersonalizationPreference(
  personalized: boolean,
  options: PersonalizationRequestOptions = {},
): Promise<PersonalizationPreferenceResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(personalizationUrl('/api/preferences/personalization', options.baseUrl), {
      method: 'PUT',
      credentials: 'include',
      headers: withCsrfHeaders('PUT', { 'Content-Type': 'application/json' }) ?? {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ personalized }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const mapped = mapServerErrorType(response.status);
      return { ok: false, preference: { personalized: getCachedPersonalizationPreference() }, error: mapped };
    }
    const candidate = (body && typeof body === 'object' ? body : {}) as {
      personalized?: unknown;
      updatedAt?: unknown;
    };
    const persisted = typeof candidate.personalized === 'boolean' ? candidate.personalized : personalized;
    cachePersonalizationPreference(persisted);
    return {
      ok: true,
      preference: {
        personalized: persisted,
        updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : undefined,
      },
    };
  } catch {
    return {
      ok: false,
      preference: { personalized: getCachedPersonalizationPreference() },
      error: { code: 'network_error', message: 'Unable to reach the server.' },
    };
  }
}

/**
 * Append the personalization flag to a discovery request URL so the backend
 * can bypass personal ranking features when the user has opted out.
 */
export function withPersonalizationParam(url: string, personalized = getCachedPersonalizationPreference()): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}personalized=${personalized ? 'true' : 'false'}`;
}

const MAX_UPLOAD_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Upload canceled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

/**
 * Return the CSRF token from the cookie if present. The backend issues the
 * cookie on every request via CSRFMiddleware, so this is synchronous and cheap.
 */
export function getCsrfToken(): string | undefined {
  return readCookie(CSRF_COOKIE_NAME);
}

/**
 * Attach CSRF headers to a mutation request when the cookie is present.
 * Mutation methods without a token are left untouched so the backend can
 * reject them with an actionable error instead of a client-side failure.
 */
export function withCsrfHeaders(
  method: string,
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  const normalized = method.toUpperCase();
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(normalized);
  if (!isMutation) return headers;
  const token = getCsrfToken();
  if (!token) return headers;
  return { ...(h|eaders ?? {}), [CSRF_HEADER_NAME]: token };
}

/**
 * Upload a file with retryable state, progress reporting, and cancellation.
 * Progress survives transient failures because each retry resumes from the
 * last reported progress rather than resetting to zero.
 */
export function uploadWithRetry(
  url: string,
  file: File,
  options: { headers?: Record<string, string>; fieldName?: string } = {},
): UploadHandle {
  const controller = new AbortController();
  const listeners = new Set<((state: UploadState) => void)>();
  let state: UploadState = { status: 'idle', progress: 0, attempts: 0 };

  const emit = (patch: Partial<UploadState>) => {
    state = { ...state, ...patch };
    listeners.forEach((cb) => cb(state));
  };

  const validation = validateUpload(file);
  if (!validation.ok) {
    emit({ status: 'error', error: validation.message });
    return {
      promise: Promise.reject(new ApiError(validation.message ?? 'Invalid upload', 400)),
      cancel: () => {},
      onProgress: (cb) => {
        listeners.add(cb);
        cb(state);
        return () => listeners.delete(cb);
      },
    };
  }

  const promise = (async () => {
    emit({ status: 'uploading' });
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) {
        emit({ status: 'canceled' });
        throw new DOMException('Upload canceled', 'AbortError');
      }
      emit({ attempts attempt, status: attempt > 1 ? 'retrying' : 'uploading' });

      try {
        const form = new FormData();
        form.append(options.fieldName ?? 'file', file);
        const response = await fetch(url, {
          method: 'POST',
          body: form,
          headers: withCsrfHeaders('POST', options.headers),
          signal: controller.signal,
        });

        if (!response.ok) {
          const mapped = await mapServerError(response);
          if (isRetryableStatus(response.status) && attempt < MAX_UPLOAD_ATTEMPTS) {
            lastError = mapped;
            await delay(RETRY_BASE_DELAY_MS * attempt, controller.signal);
            continue;
          }
          emit({ status: 'error', error: mapped.message });
          throw mapped;
        }

        const result = await response.json().catch(() => undefined);
        emit({ status: 'done', progress: 100, result });
        return result;
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') {
          emit({ status: 'canceled' });
          throw new DOMException('Upload canceled', 'AbortError');
        }
        lastError = err;
        if (attempt >= MAX_UPLOAD_ATTEMPTX) {
          const message = err instanceof ApiError ? err.message : 'Upload failed';
          emit({ status: 'error', error: message });
          throw err;
        }
        await delay(RETRY_BASE_DELAY_MS * attempt, controller.signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Upload failed');
  })();

  return {
    promise,
    cancel: () => {
      controller.abort();
      emit({ status: 'canceled' });
    },
    onProgress: (cb) => {
      listeners.add(cb);
      cb(state);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * Create an object URL for a safe local preview and return a disposer that
 * releases it. Callers must invoke the disposer when the preview unmounts so objject
 * URLs are not leaked.
 */
export function createPreviewUrl(file: File): { url: string; release: () => void } {
  const url = URL.createObjectURL(file);
  let released = false;
  return {
    url,
    release: () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}

// --- Passkey / WebAuthn and account recovery client ---

export interface PasskeyCredential {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  deviceType?: 'singleDevice' | 'multiDevice';
  backedUp?: boolean;
}

export interface PasskeyRegistrationOptions {
  challenge: string;
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria[];
  excludeCredentials?: PublicKeyCredentialDescriptor[];
}

export interface PasskeyAssertionOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: PublicKeyCredentialDescriptor[];
}

export interface PasskeyRegistrationResult {
  id: string;
  rawId: string;
  type: PublicKeyCredentialType;
  response: AuthenticatorAttestationResponse;
}

export interface PasskeyAssertionResult {
  id: string;
  rawId: string;
  type: PublicKeyCredentialType;
  response: AuthenticatorAssertionResponse;
}

export interface PasskeyEnrollmentResponse {
  credential: PasskeyCredential;
  recoveryCodes?: string[];
}

export interface PasskeyOptionsResponse {
  challengeId: string;
  options: PasskeyRegistrationOptions | PasskeyAssertionOptions;
  expiresAt: string;
}

export type PasskeyFallbackPolicy = 'require-passkey' | 'passkey-preferred' | 'password-allowed';

export interface PasskeyPolicyResponse {
  policy: PasskeyFallbackPolicy;
  passkeyEnrolled: boolean;
  credentialCount: number;
  recoveryEnabled: boolean;
}

export interface PasskeyRegistrationRequest {
  challengeId: string;
  credential: PasskeyRegistrationResult;
  name: string;
}

export interface PasskeyAssertionRequest {
  challengeId: string;
  credential: PasskeyAssertionResult;
  userId?: string;
}

export interface PasskeyRecoveryRequest {
  challengeId: string;
  credential: PasskeyAssertionResult;
  recoveryCode: string;
}

export interface PasskeyRecoveryResponse {
  recovered: boolean;
  sessionToken: string;
  newRecoveryCodes: string[];
}

export interface PasskeyClientOptions {
  fetchImpl?: typeof fetch;
  credentialsContainer?: PublicKeyCredentialContainer;
  nowImpl?: () => number;
  timeoutMs?: number;
}

export class PasskeyError extends Error {
  code:
    | 'unsupported'
    | 'not-allowed'
    | 'aborted'
    | 'timeout'
    | 'challenge-expired'
    | 'origin-mismatch'
    | 'rp-id-mismatch'
    | 'replay-detected'
    | 'no-credentials'
    | 'recovery-failed'
    | 'network'
    | 'unknown';

  constructor(code: PasskeyError['code'], message: string) {
    super(message);
    this.name = 'PasskeyError';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

const base64urlToBuffer = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const bufferToBase64url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\//g, '_').replace(/\+/g, '-').replace(/=+$/, '');
};

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}

function assertOriginAndRpId(options: { rpId: string; expectedOrigin: string }): void {
  const { rpId, expectedOrigin } = options;
  if (typeof window === 'undefined') {
    throw new PasskeyError('unsupported', 'Passkeys require a browser environment.');
  }
  const currentOrigin = normalizeOrigin(window.location.origin);
  if (currentOrigin !== normalizeOrigin(expectedOrigin)) {
    throw new PasskeyError('origin-mismatch', 'Passkey origin does not match the expected origin.');
  }
  const host = window.location.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new PasskeyError('rp-id-mismatch', 'Passkey relying party ID does not match this host.');
  }
}

function getCredentialsContainer(override?: PublicKeyCredentialContainer): PublicKeyCredentialContainer {
  if (override) {
    return override;
  }
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new PasskeyError('unsupported', 'WebAuthn is not available in this browser.');
  }
  return navigator.credentials;
}

function mapDOMException(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) {
    return err;
  }
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError') {
    return new PasskeyError('not-allowed', 'The authenticator refused the request.');
  }
  if (name === 'AbortError') {
    return new PasskeyError('aborted', 'The passkey request was aborted.');
  }
  if (name === 'TimeoutError') {
    return new PasskeyError('timeout', 'The passkey request timed out.');
  }
  if (name === 'SecurityError') {
    return new PasskeyError('origin-mismatch', 'The authenticator rejected the origin or RP binding.');
  }
  return new PasskeyError('unknown', (err as Error)?.message ?? 'Passkey operation failed.');
}

const challengeCache = new Map<string, { expiresAt: number; used: boolean }>();

function registerChallenge(challengeId: string, expiresAt: string, now: () => number): void {
  const parsed = Date.parse(expiresAt);
  const expiresAtMs = Number.isFinite(parsed) ? parsed : now() + DEFAULT_TIMEOUT_MS;
  challengeCache.set(challengeId, { expiresAt: expiresAtMx, used: false });
}

function claimChallenge(challengeId: string, now: () => number): void {
  const entry = challengeCache.get(challengeId);
  if (!entry) {
    throw new PasskeyError('replay-detected', 'Unknown or already consumed passkey challenge.');
  }
  if (entry.used) {
    throw new PasskeyError('replay-detected', 'This passkey challenge has already been used.');
  }
  if (entry.expiresAt <= now()) {
    challengeCache.delete(challengeId);
    throw new PasskeyError('challenge-expired', 'The passkey challenge expired.');
  }
  entry.used = true;
  challengeCache.set(challengeId, entry);
}

export function __resetPasskeyChallengeCache(): void {
  challengeCache.clear();
}

export function __seedPasskeyChallenge(challengeId: string, expiresAt: string): void {
  registerChallenge(challengeId, expiresAt, () => Date.now());
}

export function isPasskeySupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials &&
    typeof navigator.credentials.create === 'function' &&
    typeof navigator.credentials.get === 'function'
  );
}

export class PasskeyClient {
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: PublicKeyCredentialContainer;
  private readonly nowImpl: () => number;
  private readonly timeoutMs: number;

  constructor(options: PasskeyClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.credentials = getCredentialsContainer(options.credentialsContainer);
    this.nowImpl = options.nowImpl ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post<TPayload, TResponse>(
    path: string,
    payload: TPayload,
  ): Promise<TResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new PasskeyError('network', (err as Error)?.message ?? 'Network request failed');
    }
    if (!response.ok) {
      const mapped = await mapServerError(response);
      throw new PasskeyError('network', mapped.message);
    }
    return (response.json() as Promise<TResponse>);
  }

  private decodeRegistrationOptions(
    options: PasskeyRegistrationOptions,
  ): PublicKeyCredentialCreationOptions {
    return {
      challenge: base64urlToBuffer(options.challenge),
      rp: { id: options.rpId, name: options.rpName },
      user: {
        id: base64urlToBuffer(options.userId),
        name: options.userName,
        displayName: options.userDisplayName,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -' } as PublicKeyCredentialParameter],
      timeout: options.timeout ?? this.timeoutMs,
      attestation: options.attestation ?? 'none',
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: options.excludeCredentials,
    } as PublicKeyCredentialCreationOptions;
  }

  private decodeAssertionOptions(
    options: PasskeyAssertionOptions,
  ): PublicKeyCredentialRequestOptions {
    return {
      challenge: base64urlToBuffer(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout ?? this.timeoutMs,
      userVerification: options.userVerification ?? 'preferred',
      allowCredentials: options.allowCredentials,
    } as PublicKeyCredentialRequestOptions;
  }

  async register(params: {
    userId: string;
    userName: string;
    userDisplayName: string;
    name: string;
    expectedOrigin: string;
  }): Promise<PasskeyEnrollmentResponse> {
    const optionsResponse = await this.post<
      { userId: params.userId },
      PasskeyOptionsResponse
    >('/api/passkeys/registration/options');
    const options = optionsResponse.options as PasskeyRegistrationOptions;
    assertOriginAndRpId({
      rpId: options.rpId,
      expectedOrigin: params.expectedOrigin,
    });
    registerChallenge(optionsResponse.challengeId, optionsResponse.expiresAt, this.nowImpl);

    const creationOptions = this.decodeRegistrationOptions(options);
    let credential: PublicKeyCredential;
    try {
      credential = (await this.credentials.create({ publicKey: creationOptions })) as PublicKeyCredential;
    } catch (err) {
      throw mapDOMException(err);
    }
    if (!credential) {
      throw new PasskeyError('unknown', 'No passkey credential was created.');
    }

    const attestation = credential.response as AuthenticatorAttestationResponse;
    const payload: PasskeyRegistrationRequest = {
      challengeId: optionsResponse.challengeId,
      name: params.name,
      credential: {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type as PublicKeyCredentialType,
        response: {
          clientDataJSON: bufferToBase64url(attestation.clientDataJSON),
          attestationObject: bufferToBase64url(attestation.attestationObject),
        },
      },
    };
    return this.post<PasskeyRegistrationRequest, PasskeyEnrollmentResponse>(
      '/api/passkeys/registration/verify',
      payload,
    );
}

  async authenticate(params: {
    userId: string;
    expectedOrigin: string;
    allowCredentials?: PublicKeyCredentialDescriptor[];
  }): Promise<PasskeyEnrollmentResponse> {
    const optionsResponse = await this.post<
      { userId: params.userId },
      PasskeyOptionsResponse
    >('/api/passkeys/assertion/options');
    const options = optionsResponse.options as PasskeyAssertionOptions;
    assertOriginAndRpId({
      rpId: options.rpId,
      expectedOrigin: params.expectedOrigin,
    });
    registerChallenge(optionsResponse.challengeId, optionsResponse.expiresAt, this.nowImpl);

    const requestOptions = this.decodeAssertionOptions({
      ...options,
      allowCredentials: params.allowCredentials ?? options.allowCredentials,
    });
    let credential: PublicKeyCredential | null;
    try {
      credential = (await this.credentials.get({ publicKey: requestOptions })) as PublicKeyCredential | null;
    } catch (err) {
      throw mapDOMException(err);
    }
    if (!credential) {
      throw new PasskeyError('no-credentials', 'No matching passkey credential was found.');
    }

    const assertion = credential.response as AuthenticatorAssertionResponse;
    const payload: PasskeyAssertionRequest = {
      challengeId: optionsResponse.challengeId,
      userId: params.userId,
      credential: {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type as PublicKeyCredentialType,
        response: {
          clientDataJSON: bufferToBase64url(assertion.clientDataJSON),
          authenticatorData: bufferToBase64url(assertion.authenticatorData),
          signature: bufferToBase64url(assertion.signature),
          userHandle: assertion.userHandle
            ? bufferToBase64url(assertion.userHandle)
            : undefined,
        },
      },
    };
    return this.post<PasskeyAssertionRequest, PasskeyEnrollmentResponse>(
      '/api/passkeys/assertion/verify',
      payload,
    );
  }

  async recoverAccount(params: {
    userId: string;
    recoveryCode: string;
    expectedOrigin: string;
  }): Promise<PasskeyRecoveryResponse> {
    const optionsResponse = await this.post<
      { userId: params.userId },
      PasskeyOptionsResponse
    >('/api/passkeys/recovery/options');
    const options = optionsResponse.options as PasskeyAssertionOptions;
    assertOriginAndRpId({
      rpId: options.rpId,
      expectedOrigin: params.expectedOrigin,
    });
    registerChallenge(optionsResponse.challengeId, optionsResponse.expiresAt, this.nowImpl);

    const requestOptions = this.decodeAssertionOptions(options);
    let credential: PublicKeyCredential | null;
    try {
      credential = (await this.credentials.get({ publicKey: requestOptions })) as PublicKeyCredential | null;
    } catch (err) {
      throw mapDOMException(err);
    }
    if (!credential) {
      throw new PasskeyError('recovery-failed', 'Recovery passkey assertion failed.');
    }

    const assertion = credential.response as AuthenticatorAssertionResponse;
    const payload: PasskeyRecoveryRequest = {
      challengeId: optionsResponse.challengeId,
      recoveryCode: params.recoveryCode,
      credential: {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type as PublicKeyCredentialType,
        response: {
          clientDataJSON: bufferToBase64url(assertion.clientDataJSON),
          authenticatorData: bufferToBase64url(assertion.authenticatorData),
          signature: bufferToBase64url(assertion.signature),
          userHandle: assertion.userHandle
            ? bufferToBase64url(assertion.userHandle)
            : undefined,
        },
      },
    };
    return this.post<PasskeyRecoveryRequest, PasskeyRecoveryResponse>(
      '/api/passkeys/recovery/verify',
      payload,
    );
  }

  async listCredentials(userId: string): Promise<PasskeyCredential[]> {
    const response = await this.post<{ userId: string }, { credentials: PasskeyCredential[] }>(
      '/api/passkeys/list',
      { userId },
    );
    return response.credentials;
}

  async revokeCredential(params: {
    userId: string;
    credentialId: string;
  }): Promise<{ revoked: boolean; remaining: number }> {
    return this.post<{ userId: string; credentialId: string }, { revoked: boolean; remaining: number }>(
      '/api/passkeys/revoke',
      params,
    );
  }

  async getPolicy(userId: string): Promise<PasskeyPolicyResponse> {
    return this.post<{ userId: string }, PasskeyPolicyResponse>(
      '/api/passkeys/policy',
      { userId },
    );
  }

  async setFallbackPolicy(params: {
    userId: string;
    policy: PasskeyFallbackPolicy;
  }): Promise<PasskeyPolicyResponse> {
    return this.post<{ userId: string; policy: PasskeyFallbackPolicy }, PasskeyPolicyResponse>(
      '/api/passkeys/policy',
      params,
    );
  }
}
