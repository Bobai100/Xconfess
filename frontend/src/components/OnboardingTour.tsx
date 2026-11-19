import { useCallback, useEffect, useId, useRef, useState } from 'react';

const STORAGE_KEY = 'handsoff.onboarding.tour';
const STORAGE_VERSION = 1;

interface TourStep {
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    title: 'Post anonymously',
    body: 'Share updates without attaching your identity. Your account is never linked to anonymous posts.',
  },
  {
    title: 'Your privacy comes first',
    body: 'We store only what is needed to run the app. No tracking pixels, no third-party analytics on your content.',
  },
  {
    title: 'Community moderation',
    body: 'Reports are reviewed by moderators. You can flag content and block accounts at any time.',
  },
  {
    title: 'Powered by Stellar',
    body: 'Posts and reactions settle on the Stellar network. Your keys stay on your device.',
  },
];

function readCompleted(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { version?: unknown; completed?: unknown };
    return parsed?.version === STORAGE_VERSION && parsed?.completed === true;
  } catch {
    return false;
  }
}

function writeCompleted(): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, completed: true }),
    );
  } catch {
    // Storage may be unavailable (private mode, quota). Never block the UI.
  }
}

interface OnboardingTourProps {
  onComplete?: () => void;
}

export function OnboardingTour({ onComplete }: OnboardingTourProps) {
  const [open, setOpen] = useState<boolean>(() => !readCompleted());
  const [index, setIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const finish = useCallback(() => {
    writeCompleted();
    setOpen(false);
    onComplete?.();
  }, [onComplete]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, finish]);

  if (!open) return null;

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={finish}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {step.title}
          </h2>
          <button
            type="button"
            onClick={finish}
            aria-label="Dismiss tour"
            className="rounded p-1 text-gray-500 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            ×
          </button>
        </div>
        <p id={bodyId} className="mt-2 text-sm text-gray-700">
          {step.body}
        </p>
        <p className="mt-4 text-xs text-gray-500" aria-live="polite">
          Step {index + 1} of {STEPS.length}
        </p>
        <div className="mt-6 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={finish}
            className="text-sm text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Skip
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="rounded border px-3 py-1.5 text-sm disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => (isLast ? finish() : setIndex((i) => i + 1))}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OnboardingTour;
