import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ReactionType = 'like' | 'love' | 'laugh' | 'insight' | 'support';

export interface ReactionCounts {
  [key: string]: number | undefined;
}

export interface ReactionsProps {
  counts?: ReactionCounts | null;
  onReact?: (type: ReactionType) => void | Promise<void>;
  disabled?: boolean;
  loading?: boolean;
  error?: boolean;
}

const REACTION_LABELS: Record<ReactionType, string> = {
  like: 'Like',
  love: 'Love',
  laugh: 'Laugh',
  insight: 'Insight',
  support: 'Support',
};

const REACTION_ORDER: ReactionType[] = ['like', 'love', 'laugh', 'insight', 'support'];

function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function formatCountLabel(count: number): string {
  return count === 1 ? '1 reaction' : `${count} reactions`;
}

function buildSummaryLabel(counts: ReactionCounts | null | undefined): string {
  const total = REACTION_ORDER.reduce((sum, type) => sum + normalizeCount(counts?.[type]), 0);
  if (total === 0) {
    return 'No reactions yet';
  }
  const parts = REACTION_ORDER.filter((type) => normalizeCount(counts?.[type]) > 0).map(
    (type) => `${REACTION_LABELS[type]}: ${normalizeCount(counts?.[type])}`,
  );
  return `${formatCountLabel(total)}. ${parts.join(', ')}`;
}

export default function Reactions({ counts, onReact, disabled = false, loading = false, error = false }: ReactionsProps) {
  const [pending, setPending] = useState<ReactionType | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const previousTotal = useRef<number | null>(null);

  const total = useMemo(
    () => REACTION_ORDER.reduce((sum, type) => sum + normalizeCount(counts?.[type]), 0),
    [counts],
  );

  useEffect(() => {
    if (previousTotal.current === null) {
      previousTotal.current = total;
      return;
    }
    if (previousTotal.current !== total) {
      const delta = total - previousTotal.current;
      previousTotal.current = total;
      const direction = delta > 0 ? 'increased' : 'decreased';
      setAnnouncement(`Reaction count ${direction} to ${formatCountLabel(total)}`);
    }
  }, [total]);

  const handleReact = useCallback(
    async (type: ReactionType) => {
      if (disabled || loading || pending || !onReact) {
        return;
      }
      setPending(type);
      try {
        await onReact(type);
      } catch {
        setAnnouncement(`Could not add ${REACTION_LABELS[type].toLowerCase()} reaction. Please try again.`);
      } finally {
        setPending(null);
      }
    },
    [disabled, loading, onReact, pending],
  );

  const summaryLabel = error ? 'Reactions unavailable' : buildSummaryLabel(counts);
  const isBusy = loading || pending !== null;

  return (
    <div className="reactions" role="group" aria-label="Reactions" aria-busy={isBusy}>
      <p className="reactions__summary" aria-live="polite" aria-atomic="true">
        {summaryLabel}
      </p>
      <ul className="reactions__list">
        {REACTION_ORDER.map((type) => {
          const count = normalizeCount(counts?.[type]);
          const label = REACTION_LABELS[type];
          return (
            <li key={type} className="reactions__item">
              <button
                type="button"
                className="reactions__button"
                onClick={() => handleReact(type)}
                disabled={disabled || isBusy}
                aria-label={`${label}, ${formatCountLabel(count)}`}
                aria-pressed={false}
              >
                <span className="reactions__emoji" aria-hidden="true">
                  {label}
                </span>
                <span className="reactions__count" aria-hidden="true">
                  {count}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <span className="reactions__announcer" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}
