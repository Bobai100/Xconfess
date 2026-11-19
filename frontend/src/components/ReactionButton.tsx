import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Aggregate reaction button.
 *
 * Reactions are anonymous: we only ever track aggregate counts, never who
 * reacted. Accessibility notes for #356:
 * - The button exposes a meaningful label ("N reactions" / "No reactions yet")
 *   instead of a bare number so screen readers get context.
 * - Count changes are announced through a polite live region so assistive
 *   tech is informed without interrupting the user.
 * - Invalid or failed operations fall back to a graceful label and never
 *   surface raw errors or negative counts.
 */

export interface ReactionButtonProps {
  /** Aggregate reaction count for this reaction type. */
  count?: number | null;
  /** Human-readable reaction type, e.g. "heart" or "thumbs up". */
  reactionType?: string;
  /** Called when the user toggles the reaction. May reject on failure. */
  onToggle?: () => void | Promise<void>;
  /** Whether the current (anonymous) viewer has reacted. */
  reacted?: boolean;
  disabled?: boolean;
}

function normalizeCount(count: number | null | undefined): number {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return 0;
  }
  return Math.floor(count);
}

function buildLabel(count: number, reactionType: string): string {
  const type = reactionType.trim() || 'reaction';
  if (count === 0) {
    return `No ${type} reactions yet`;
  }
  if (count === 1) {
    return `1 ${type} reaction`;
  }
  return `${count} ${type} reactions`;
}

function buildAnnouncement(count: number, reactionType: string): string {
  const type = reactionType.trim() || 'reaction';
  if (count === 0) {
    return `No ${type} reactions`;
  }
  if (count === 1) {
    return `1 ${type} reaction`;
  }
  return `${count} ${type} reactions`;
}

export const ReactionButton: React.FC<ReactionButtonProps> = ({
  count,
  reactionType = 'reaction',
  onToggle,
  reacted = false,
  disabled = false,
}) => {
  const safeCount = normalizeCount(count);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const previousCount = useRef(safeCount);

  // Announce aggregate count changes politely, without interrupting the user.
  useEffect(() => {
    if (previousCount.current !== safeCount) {
      setAnnouncement(buildAnnouncement(safeCount, reactionType));
      previousCount.current = safeCount;
    }
  }, [safeCount, reactionType]);

  const handleClick = useCallback(async () => {
    if (disabled || pending || !onToggle) {
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      await onToggle();
    } catch {
      // Failed operations fall back gracefully: keep the last known count and
      // surface a non-disruptive status instead of a raw error.
      setFailed(true);
      setAnnouncement('Reaction could not be updated. Please try again.');
    } finally {
      setPending(false);
    }
  }, [disabled, pending, onToggle]);

  const label = buildLabel(safeCount, reactionType);
  const isDisabled = disabled || pending;

  return (
    <span className="reaction-button">
      <button
        type="button"
        className={`reaction-button__control${reacted ? ' reaction-button__control--active' : ''}`}
        aria-label={label}
        aria-pressed={reacted}
        aria-busy={pending}
        disabled={isDisabled}
        onClick={handleClick}
      >
        <span className="reaction-button__icon" aria-hidden="true">
          {reactionType === 'heart' ? '\u2764' : '\u{1F44D}'}
        </span>
        <span className="reaction-button__count" aria-hidden="true">
          {safeCount}
        </span>
      </button>
      <span
        className="reaction-button__status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>
      {failed ? (
        <span className="reaction-button__error" role="alert">
          Reaction could not be updated.
        </span>
      ) : null}
    </span>
  );
};

export default ReactionButton;
