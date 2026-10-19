'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from '@/app/lib/i18n';

interface RequestIdNoticeProps {
  requestId?: string | null;
  className?: string;
}

/**
 * Compact, mobile-friendly display of the failed request's correlation id so
 * users and maintainers can trace it in backend logs (issue #1729).
 * Renders nothing when no id is available.
 */
export function RequestIdNotice({ requestId, className }: RequestIdNoticeProps) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  if (!requestId) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the value stays
      // selectable so it can still be copied manually.
    }
  };

  return (
    <div
      className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--secondary)] ${className ?? ''}`}
    >
      <span className="shrink-0">{t('auth.requestIdNotice.prefix')}</span>
      <code
        data-testid="auth-request-id"
        className="max-w-full select-all break-all rounded bg-[var(--surface-strong)] px-1.5 py-0.5 font-mono text-[var(--foreground)]"
      >
        {requestId}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--primary-deep)] hover:bg-[var(--surface-strong)] hover:text-[var(--primary)]"
        aria-label={t('auth.requestIdNotice.copyButton')}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {copied ? t('auth.requestIdNotice.copied') : t('auth.requestIdNotice.copyButton')}
      </button>
    </div>
  );
}
