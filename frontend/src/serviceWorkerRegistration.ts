// Service worker registration with update-consent support.
// Detects a waiting/new service worker version, exposes an update-available
// state to the UI, and only activates + reloads on explicit user consent.

export type ServiceWorkerUpdateState =
  | { status: 'idle' }
  | { status: 'available'; registration: ServiceWorkerRegistration }
  | { status: 'activating'; registration: ServiceWorkerRegistration }
  | { status: 'error'; registration: ServiceWorkerRegistration; error: Error };

type UpdateListener = (state: ServiceWorkerUpdateState) => void;

const listeners = new Set<UpdateListener>();
let currentState: ServiceWorkerUpdateState = { status: 'idle' };
let activeRegistration: ServiceWorkerRegistration | null = null;
let reloadRequested = false;

function setState(next: ServiceWorkerUpdateState): void {
  currentState = next;
  listeners.forEach((listener) => {
    try {
      listener(next);
    } catch {
      // A misbehaving listener must not break update propagation.
    }
  });
}

/**
 * Subscribe to service-worker update state changes. Returns an unsubscribe fn.
 */
export function subscribeToServiceWorkerUpdates(listener: UpdateListener): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export function getServiceWorkerUpdateState(): ServiceWorkerUpdateState {
  return currentState;
}

function markUpdateAvailable(registration: ServiceWorkerRegistration): void {
  if (currentState.status === 'activating') {
    return;
  }
  setState({ status: 'available', registration });
}

function watchInstallingWorker(registration: ServiceWorkerRegistration): void {
  const installing = registration.installing;
  if (!installing) {
    return;
  }
  installing.addEventListener('statechange', () => {
    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
      // A new version finished installing while an old one still controls the page.
      markUpdateAvailable(registration);
    }
  });
}

/**
 * User consent: activate the waiting worker and reload once it takes control.
 * Falls back to an error state (with retry path) if activation fails.
 */
export function applyServiceWorkerUpdate(): void {
  const registration = activeRegistration;
  if (!registration) {
    setState({
      status: 'error',
      registration: registration as unknown as ServiceWorkerRegistration,
      error: new Error('No active service worker registration'),
    });
    return;
  }

  const waiting = registration.waiting;
  if (!waiting) {
    // Nothing waiting (already activated elsewhere); reload to pick up new assets.
    reloadRequested = true;
    window.location.reload();
    return;
  }

  setState({ status: 'activating', registration });
  reloadRequested = true;

  const onControllerChange = () => {
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    if (reloadRequested) {
      reloadRequested = false;
      window.location.reload();
    }
  };
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  try {
    waiting.postMessage({ type: 'SKIP_WAITING' });
  } catch (err) {
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    reloadRequested = false;
    setState({
      status: 'error',
      registration,
      error: err instanceof Error ? err : new Error('Failed to activate update'),
    });
  }
}

/**
 * Dismiss the prompt without reloading. The waiting worker stays parked until
 * the user consents later or the page is fully reloaded.
 */
export function dismissServiceWorkerUpdate(): void {
  if (currentState.status === 'available') {
    setState({ status: 'idle' });
  }
}

/**
 * Clear user-scoped caches and persisted state so stale authenticated content
 * cannot survive a logout or account switch.
 */
export async function clearUserScopedState(): Promise<void> {
  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => /user|auth|account|session/i.test(name))
          .map((name) => caches.delete(name)),
      );
    }
  } catch {
    // Cache clearing is best-effort; never block logout on it.
  }

  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_USER_STATE' });
    }
  } catch {
    // Ignore messaging failures.
  }
}

function registerValidSW(swUrl: string): void {
  navigator.serviceWorker
    .register(swUrl)
    .then((registration) => {
      activeRegistration = registration;

      if (registration.waiting && navigator.serviceWorker.controller) {
        markUpdateAvailable(registration);
      }

      registration.addEventListener('updatefound', () => {
        watchInstallingWorker(registration);
      });

      // Periodically check for updates so long-lived tabs notice new versions.
      setInterval(() => {
        registration.update().catch(() => {
          // Network failures during update checks are non-fatal.
        });
      }, 60 * 60 * 1000);
    })
    .catch((error) => {
      console.error('Error during service worker registration:', error);
    });
}

function checkValidServiceWorker(swUrl: string): void {
  fetch(swUrl, { headers: { 'Service-Worker': 'script' } })
    .then((response) => {
      const contentType = response.headers.get('content-type');
      if (
        response.status === 404 ||
        (contentType != null && contentType.indexOf('javascript') === -1)
      ) {
        navigator.serviceWorker.ready.then((registration) => {
          registration.unregister().then(() => {
            window.location.reload();
          });
        });
      } else {
        registerValidSW(swUrl);
      }
    })
    .catch(() => {
      console.log('No internet connection found. App is running in offline mode.');
    });
}

export function register(): void {
  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      const swUrl = `${process.env.PUBLIC_URL}/service-worker.js`;
      checkValidServiceWorker(swUrl);
    });
  }
}

export function unregister(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((registration) => {
        registration.unregister();
      })
      .catch((error) => {
        console.error(error.message);
      });
  }
}
