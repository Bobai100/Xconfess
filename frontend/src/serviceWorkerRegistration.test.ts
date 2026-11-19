import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerServiceWorker,
  applyUpdate,
  clearUserScopedState,
} from './serviceWorkerRegistration';

type Listener = (event?: unknown) => void;

class MockServiceWorker {
  state = 'installing';
  private listeners: Record<string, Listener[]> = {};
  postMessage = vi.fn();
  addEventListener = vi.fn((type: string, cb: Listener) => {
    (this.listeners[type] ||= []).push(cb);
  });
  removeEventListener = vi.fn();
  emit(type: string, event?: unknown) {
    (this.listeners[type] || []).forEach((cb) => cb(event));
  }
}

class MockRegistration {
  waiting: MockServiceWorker | null = null;
  installing: MockServiceWorker | null = null;
  active: MockServiceWorker | null = null;
  private listeners: Record<string, Listener[]> = {};
  addEventListener = vi.fn((type: string, cb: Listener) => {
    (this.listeners[type] ||= []).push(cb);
  });
  removeEventListener = vi.fn();
  update = vi.fn().mockResolvedValue(undefined);
  emit(type: string, event?: unknown) {
    (this.listeners[type] || []).forEach((cb) => cb(event));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('serviceWorkerRegistration', () => {
  let registration: MockRegistration;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registration = new MockRegistration();
    reload = vi.fn();

    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
        controller: { postMessage: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    vi.stubGlobal('window', {
      location: { reload },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['user-scoped-v1', 'static-v1']),
      delete: vi.fn().mockResolvedValue(true),
    });
    vi.stubGlobal('localStorage', {
      length: 2,
      key: vi.fn((i: number) => ['auth_token', 'theme'][i] ?? null),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports an update when a waiting worker exists at registration', async () => {
    registration.waiting = new MockServiceWorker();
    const onUpdateAvailable = vi.fn();

    await registerServiceWorker({ onUpdateAvailable });
    await flush();

    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it('reports an update when a new worker becomes installed', async () => {
    const onUpdateAvailable = vi.fn();
    await registerServiceWorker({ onUpdateAvailable });

    const installing = new MockServiceWorker();
    registration.installing = installing;
    registration.emit('updatefound');

    installing.state = 'installed';
    installing.emit('statechange');
    await flush();

    expect(onUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it('does not report an update when there is no controller (first install)', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
        controller: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const onUpdateAvailable = vi.fn();
    await registerServiceWorker({ onUpdateAvailable });

    const installing = new MockServiceWorker();
    registration.installing = installing;
    registration.emit('updatefound');
    installing.state = 'installed';
    installing.emit('statechange');
    await flush();

    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });

  it('activates the waiting worker and reloads on consent', async () => {
    const waiting = new MockServiceWorker();
    registration.waiting = waiting;

    await applyUpdate(registration as unknown as ServiceWorkerRegistration);
    await flush();

    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('surfaces a retry path when activation fails', async () => {
    const waiting = new MockServiceWorker();
    waiting.postMessage.mockImplementation(() => {
      throw new Error('activation failed');
    });
    registration.waiting = waiting;

    await expect(
      applyUpdate(registration as unknown as ServiceWorkerRegistration),
    ).rejects.toThrow('activation failed');
    expect(reload).not.toHaveBeenCalled();
  });

  it('clears user-scoped caches and persisted auth state on account change', async () => {
    await clearUserScopedState();

    expect(caches.delete).toHaveBeenCalledWith('user-scoped-v1');
    expect(caches.delete).not.toHaveBeenCalledWith('static-v1');
    expect(localStorage.removeItem).toHaveBeenCalledWith('auth_token');
    expect(localStorage.removeItem).not.toHaveBeenCalledWith('theme');
  });
});
