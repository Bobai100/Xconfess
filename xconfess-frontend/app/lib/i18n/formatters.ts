import { DEFAULT_LOCALE, SupportedLocale } from './types';

export interface RelativeTimeOptions {
  locale?: string;
  now?: Date;
  fallback?: string;
  style?: 'long' | 'short' | 'narrow';
  maxRelativeDays?: number;
}

export interface AbsoluteDateOptions {
  locale?: string;
  timeZone?: string;
  dateStyle?: 'full' | 'long' | 'medium' | 'short';
  timeStyle?: 'full' | 'long' | 'medium' | 'short';
  fallback?: string;
  includeYear?: boolean;
}

export interface NumberFormatOptions {
  locale?: string;
  notation?: 'standard' | 'compact' | 'scientific' | 'engineering';
  compactDisplay?: 'short' | 'long';
  style?: 'decimal' | 'currency' | 'percent';
  currency?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  fallback?: string;
}

/**
 * Safely parses any input into a valid Date, or null if missing/invalid.
 */
export function parseDateSafe(input: unknown): Date | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }
  const date = input instanceof Date ? input : new Date(input as string | number);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

/**
 * Formats a timestamp into localized relative time (e.g. "5m ago", "hace 2 horas").
 * Accurately accounts for Daylight Saving Time boundaries using monotonic UTC millisecond differences.
 */
export function formatRelativeTime(
  input: Date | string | number | null | undefined,
  options: RelativeTimeOptions = {},
): string {
  const date = parseDateSafe(input);
  if (!date) {
    return options.fallback ?? '—';
  }

  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    return options.fallback ?? '—';
  }

  const diffMs = date.getTime() - now.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);

  const locale = options.locale || DEFAULT_LOCALE;

  // Threshold: less than 60 seconds is "just now"
  if (absSec < 60) {
    if (locale.startsWith('es')) return 'hace un momento';
    if (locale.startsWith('fr')) return "à l'instant";
    if (locale.startsWith('de')) return 'gerade eben';
    return 'just now';
  }

  // If beyond maxRelativeDays, switch to absolute date
  const maxRelativeDays = options.maxRelativeDays ?? 7;
  const absDays = absSec / 86400;
  if (absDays > maxRelativeDays) {
    return formatAbsoluteDate(date, {
      locale,
      dateStyle: 'medium',
    });
  }

  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, {
      numeric: 'auto',
      style: options.style ?? 'short',
    });
  } catch {
    rtf = new Intl.RelativeTimeFormat(DEFAULT_LOCALE, {
      numeric: 'auto',
      style: options.style ?? 'short',
    });
  }

  if (absSec < 3600) {
    const minutes = Math.round(diffSec / 60);
    return rtf.format(minutes, 'minute');
  }

  if (absSec < 86400) {
    const hours = Math.round(diffSec / 3600);
    return rtf.format(hours, 'hour');
  }

  const days = Math.round(diffSec / 86400);
  return rtf.format(days, 'day');
}

/**
 * Formats a timestamp into a localized absolute date and/or time.
 */
export function formatAbsoluteDate(
  input: Date | string | number | null | undefined,
  options: AbsoluteDateOptions = {},
): string {
  const date = parseDateSafe(input);
  if (!date) {
    return options.fallback ?? '—';
  }

  const locale = options.locale || DEFAULT_LOCALE;

  const intlOptions: Intl.DateTimeFormatOptions = {
    dateStyle: options.dateStyle ?? 'medium',
    timeStyle: options.timeStyle,
    timeZone: options.timeZone,
  };

  try {
    return new Intl.DateTimeFormat(locale, intlOptions).format(date);
  } catch {
    return date.toLocaleDateString(DEFAULT_LOCALE);
  }
}

/**
 * Formats numbers, counts, and currency amounts with locale sensitivity and compact formatting.
 */
export function formatNumber(
  value: number | string | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (value === null || value === undefined || value === '') {
    return options.fallback ?? '0';
  }

  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) {
    return options.fallback ?? '0';
  }

  const locale = options.locale || DEFAULT_LOCALE;

  const intlOptions: Intl.NumberFormatOptions = {
    notation: options.notation,
    compactDisplay: options.compactDisplay ?? 'short',
    style: options.style ?? 'decimal',
    currency: options.currency,
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
  };

  try {
    return new Intl.NumberFormat(locale, intlOptions).format(num);
  } catch {
    return num.toLocaleString(DEFAULT_LOCALE);
  }
}

/**
 * Formats counts with locale-aware plural rules (e.g. "1 confession", "5 confessions").
 */
export function formatCount(
  count: number | null | undefined,
  singular: string,
  plural?: string,
  options: NumberFormatOptions = {},
): string {
  const num = count === null || count === undefined || Number.isNaN(count) ? 0 : Number(count);
  const locale = options.locale || DEFAULT_LOCALE;

  const formattedNum = formatNumber(num, options);

  let pr: Intl.PluralRules;
  try {
    pr = new Intl.PluralRules(locale);
  } catch {
    pr = new Intl.PluralRules(DEFAULT_LOCALE);
  }

  const rule = pr.select(num);
  const pluralWord = plural || `${singular}s`;
  const word = rule === 'one' ? singular : pluralWord;

  return `${formattedNum} ${word}`;
}
