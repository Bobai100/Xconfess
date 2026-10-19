import {
  formatRelativeTime,
  formatAbsoluteDate,
  formatNumber,
  formatCount,
  RelativeTimeOptions,
  AbsoluteDateOptions,
} from '../i18n/formatters';

export {
  formatRelativeTime,
  formatAbsoluteDate,
  formatNumber,
  formatCount,
};

/**
 * Format date consistently across the application with locale awareness
 * and safe handling of missing, null, or invalid dates.
 */
export function formatDate(
  date: Date | string | number | null | undefined,
  options?: RelativeTimeOptions,
): string {
  if (!date) {
    return '—';
  }
  return formatRelativeTime(date, options);
}
