import { useCallback, useEffect, useRef, useState } from 'react';

const USER_SCOPED_CACHE_PREFIXES = ['user-', 'auth-', 'api-user-'];

async function clearUserScopedCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => USER_SCOPED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .map((key) => caches.delete(key)),
    );
  } catch {
    // Cache clearing is best-effort; never block logout on it.
  }
}

/**
 * Clears user-scoped caches and persisted state so stale authenticated content
 * cannot survive an account change. Safe to call on logout or account switch.
 */
export async function clearUserScopedState(): Promise<void> {
  await clearUserScopedCaches();
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.clear();
  } catch {
    // Ignore storage access errors (e.g. privacy mode).
  }
}

export default function PwaUpdatePrompt() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    let cancelled = false;

    const trackWaiting = (registration: ServiceWorkerRegistration) => {
      if (cancelled) return;
      if (registration.waiting) {
        setWaitingWorker(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setWaitingWorker(registration.waiting ?? installing);
          }
        });
      });
    };

    const onControllerChange = () => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        if (registration) trackWaiting(registration);
      })
      .catch(() => {
        // Registration lookup failure is non-fatal; no prompt is shown.
      });

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  const handleReload = useCallback(() => {
    if (!waitingWorker) return;
    setError(null);
    setActivating(true);
    try {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } catch {
      setActivating(false);
      setError('Could not activate the update. Please try again.');
    }
  }, [waitingWorker]);

  const handleDismiss = useCallback(() => {
    setWaitingWorker(null);
    setError(null);
  }, []);

  if (!waitingWorker) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 border-t border-gray-200 bg-white p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-gray-800">
        {error ?? 'A new version is available. Reload to get the latest updates.'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleReload}
          disabled={activating}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {activating ? 'Reloading…' : error ? 'Retry' : 'Reload'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Later
        </button>
      </div>
    </div>
  );
}
