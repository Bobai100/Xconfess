/**
 * Canonical Backend URL Resolution
 *
 * Server-side: Uses BACKEND_API_URL (private)
 * Client-side: Uses NEXT_PUBLIC_API_URL (public)
 */

const normalizeBackendApiUrl = (url: string): string => {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
};

export const getApiBaseUrl = (): string => {
  // Server-side
  if (typeof window === "undefined") {
    const serverUrl = process.env.BACKEND_API_URL;

    if (serverUrl) {
      return normalizeBackendApiUrl(serverUrl);
    }

    // Safe fallback during build/prerender.
    // Runtime API routes should handle an unavailable backend.
    return normalizeBackendApiUrl("http://localhost:5000");
  }

  // Client-side
  const clientUrl = process.env.NEXT_PUBLIC_API_URL;

  if (clientUrl) {
    return normalizeBackendApiUrl(clientUrl);
  }

  return normalizeBackendApiUrl("http://localhost:5000");
};

/**
 * Canonical WebSocket URL Resolution
 *
 * Client-side: Uses NEXT_PUBLIC_WS_URL (public)
 */
export const getWsUrl = (): string => {
  if (typeof window === "undefined") {
    return "ws://localhost:5000";
  }

  return process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:5000";
};

/**
 * Safe Non-Secret Configuration Contract
 *
 * Exposes only non-secret deployment configuration values so that
 * deployment targets (e.g. Render vs Vercel) can be compared for drift.
 * Never include secrets, tokens, or credentials here.
 */

const parseBooleanFlag = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return fallback;
};

const parseNetwork = (value: string | undefined): "mainnet" | "testnet" | "futurenet" => {
  const normalized = (value || "testnet").trim().toLowerCase();
  if (normalized === "mainnet" || normalized === "testnet" || normalized === "futurenet") {
    return normalized;
  }
  return "testnet";
};

const parseSameSite = (
  value: string | undefined,
): "strict" | "lax" | "none" => {
  const normalized = (value || "lax").trim().toLowerCase();
  if (normalized === "strict" || normalized === "lax" || normalized === "none") {
    return normalized;
  }
  return "lax";
};

export interface SafeConfigSnapshot {
  apiOrigin: string;
  wsOrigin: string;
  cookie: {
    secure: boolean;
    sameSite: "strict" | "lax" | "none";
    domain: string | null;
  };
  featureFlags: Record<string, boolean>;
  network: "mainnet" | "testnet" | "futurenet";
}

/**
 * Returns a snapshot of safe, non-secret configuration values used for
 * drift detection across deployment targets. Secrets are never included.
 */
export const getSafeConfigSnapshot = (): SafeConfigSnapshot => {
  return {
    apiOrigin: getApiBaseUrl(),
    wsOrigin: getWsUrl(),
    cookie: {
      secure: parseBooleanFlag(process.env.NEXT_PUBLIC_COOKIE_SECURE, true),
      sameSite: parseSameSite(process.env.NEXT_PUBLIC_COOKIE_SAME_SITE),
      domain: process.env.NEXT_PUBLIC_COOKIE_DOMAIN?.trim() || null,
    },
    featureFlags: {
      enableConfessions: parseBooleanFlag(
        process.env.NEXT_PUBLIC_FEATURE_CONFESSIONS,
        true,
      ),
      enableReactions: parseBooleanFlag(
        process.env.NEXT_PUBLIC_FEATURE_REACTIONS,
        true,
      ),
      enableNotifications: parseBooleanFlag(
        process.env.NEXT_PUBLIC_FEATURE_NOTIFICATIONS,
        true,
      ),
    },
    network: parseNetwork(process.env.NEXT_PUBLIC_NETWORK),
  };
};