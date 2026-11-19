import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Privacy-respecting first-run product tour state.
 *
 * Persists only the minimum completion state: a single versioned boolean flag.
 * No analytics, identifiers, or step-level telemetry are stored.
 *
 * Storage semantics:
 * - Missing, invalid, or unavailable storage is treated as "not completed".
 * - Storage read/write failures never throw and never block the UI.
 * - Dismiss, skip, and complete all mark the tour as completed.
 */

export const FIRST_RUN_TOUR_STORAGE_KEY = 'handsoff.firstRunTour.completed';

/** Bump when the tour content changes enough to warrant re-showing it. */
export const FIRST_RUN_TOUR_VERSION = 1;

interface StoredTourState {
  version: number;
  completed: boolean;
}

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    // Access can throw in privacy modes / sandboxed iframes.
    return null;
  }
}

function readCompleted(): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    const raw = storage.getItem(FIRST_RUN_TOUR_STORAGE_KEY);
    if (!raw) {
      return false;
    }
    const parsed = JSON.parse(raw) as Partial<StoredTourState> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== FIRST_RUN_TOUR_VERSION ||
      parsed.completed !== true
    ) {
      return false;
    }
    return true;
  } catch {
    // Corrupt or unreadable value: treat as not completed.
    return false;
  }
}

function writeCompleted(): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    const value: StoredTourState = {
      version: FIRST_RUN_TOUR_VERSION,
      completed: true,
    };
    storage.setItem(FIRST_RUN_TOUR_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled: do not block the UI.
  }
}

export interface UseFirstRunTourResult {
  /** True when the tour should be shown to the user. */
  isOpen: boolean;
  /** Marks the tour completed and closes it (dismiss, skip, or finish). */
  complete: () => void;
  /** Explicit close control / Escape key handler. */
  dismiss: () => void;
}

export function useFirstRunTour(): UseFirstRunTourResult {
  const [isOpen, setIsOpen] = useState<boolean>(() => !readCompleted());
  const completedRef = useRef(false);

  const complete = useCallback(() => {
    if (!completedRef.current) {
      completedRef.current = true;
      writeCompleted();
    }
    setIsOpen(false);
  }, []);

  // Keep multiple tabs consistent without polling or storing extra data.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== FIRST_RUN_TOUR_STORAGE_KEY) {
        return;
      }
      if (readCompleted()) {
        completedRef.current = true;
        setIsOpen(false);
      }
    };
    if (typeof window === 'undefined') {
      return;
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return { isOpen, complete, dismiss: complete };
}
