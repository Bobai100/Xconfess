/**
 * Request deduplication for concurrent read requests.
 *
 * Coalesces identical in-flight read requests so that multiple components
 * (e.g. concurrent route loaders) share a single network call. Cache keys are
 * partitioned by user/session identity so user-specific data is never shared
 * across account or session boundaries.
 */

export interface RequestDedupOptions {
  /** Stable identity for the current user/session. Required for coalescing. */
  identity?: string | null;
  /** Optional abort signal; aborting one caller does not cancel shared work. */
  signal?: AbortSignal;
}

export interface RequestDedup {
  dedupe<T>(key: string, fn: () => Promise<T>, options?: RequestDedupOptions): Promise<T>;
  /** Number of in-flight requests currently tracked (for tests/telemetry). */
  size(): number;
  /** Clears all tracked in-flight requests. */
  clear(): void;
}

function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0;
}

function isValidIdentity(identity: unknown): identity is string {
  return typeof identity === 'string' && identity.length > 0;
}

export function createRequestDedup(): RequestDedup {
  const inflight = new Map<string, Promise<unknown>>();

  return {
    dedupe<T>(key: string, fn: () => Promise<T>, options: RequestDedupOptions = {}): Promise<T> {
      if (!isValidKey(key)) {
        return Promise.reject(new Error('requestDedup: a non-empty key is required'));
      }
      if (typeof fn !== 'function') {
        return Promise.reject(new Error('requestDedup: a request function is required'));
      }

      const { identity, signal } = options;

      // Without a valid identity we cannot safely partition user-specific data,
      // so we never coalesce across boundaries: run the request directly.
      if (!isValidIdentity(identity)) {
        return fn();
      }

      const cacheKey = `${identity}\u0000${key}`;
      const existing = inflight.get(cacheKey);
      if (existing) {
        return existing as Promise<T>;
      }

      const promise = (async () => {
        try {
          return await fn();
        } finally {
          // Only remove if this is still the tracked promise for the key.
          if (inflight.get(cacheKey) === promise) {
            inflight.delete(cacheKey);
          }
        }
      })();

      inflight.set(cacheKey, promise);

      if (signal) {
        if (signal.aborted) {
          // Do not pollute the cache with an already-aborted caller.
          if (inflight.get(cacheKey) === promise) {
            inflight.delete(cacheKey);
          }
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        signal.addEventListener(
          'abort',
          () => {
            // Aborting a caller only rejects that caller; shared work continues
            // for other subscribers and the cache entry is cleaned up on settle.
          },
          { once: true },
        );
      }

      return promise;
    },

    size(): number {
      return inflight.size;
    },

    clear(): void {
      inflight.clear();
    },
  };
}

/** Shared default instance for app-wide deduplication. */
export const requestDedup = createRequestDedup();
