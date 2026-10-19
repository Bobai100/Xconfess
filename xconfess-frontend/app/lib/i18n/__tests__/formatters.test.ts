import {
  formatRelativeTime,
  formatAbsoluteDate,
  formatNumber,
  formatCount,
  parseDateSafe,
} from '../formatters';

describe('i18n formatters (Issue #220)', () => {
  describe('parseDateSafe', () => {
    it('returns Date for valid inputs', () => {
      const now = new Date();
      expect(parseDateSafe(now)).toEqual(now);
      expect(parseDateSafe('2026-10-18T12:00:00Z')?.toISOString()).toBe(
        '2026-10-18T12:00:00.000Z',
      );
      expect(parseDateSafe(1700000000000)?.getTime()).toBe(1700000000000);
    });

    it('returns null for invalid or missing inputs without throwing', () => {
      expect(parseDateSafe(null)).toBeNull();
      expect(parseDateSafe(undefined)).toBeNull();
      expect(parseDateSafe('')).toBeNull();
      expect(parseDateSafe('not-a-date')).toBeNull();
      expect(parseDateSafe(NaN)).toBeNull();
    });
  });

  describe('formatRelativeTime', () => {
    const fixedNow = new Date('2026-10-18T12:00:00.000Z');

    it('returns "just now" for times within 60 seconds', () => {
      const thirtySecAgo = new Date('2026-10-18T11:59:30.000Z');
      expect(formatRelativeTime(thirtySecAgo, { now: fixedNow, locale: 'en' })).toBe(
        'just now',
      );
      expect(formatRelativeTime(thirtySecAgo, { now: fixedNow, locale: 'es' })).toBe(
        'hace un momento',
      );
    });

    it('formats minutes and hours accurately', () => {
      const tenMinsAgo = new Date('2026-10-18T11:50:00.000Z');
      const formattedMins = formatRelativeTime(tenMinsAgo, { now: fixedNow, locale: 'en' });
      expect(formattedMins).toMatch(/10\s?m/i);

      const threeHoursAgo = new Date('2026-10-18T09:00:00.000Z');
      const formattedHours = formatRelativeTime(threeHoursAgo, { now: fixedNow, locale: 'en' });
      expect(formattedHours).toMatch(/3\s?h/i);
    });

    it('distinguishes relative time from absolute time and falls back to absolute past threshold', () => {
      const twoWeeksAgo = new Date('2026-10-01T12:00:00.000Z');
      const result = formatRelativeTime(twoWeeksAgo, {
        now: fixedNow,
        locale: 'en',
        maxRelativeDays: 7,
      });

      // Should be an absolute date string (e.g. Oct 1, 2026) rather than relative
      expect(result).toMatch(/Oct/i);
    });

    it('gracefully handles missing or invalid date inputs without throwing', () => {
      expect(formatRelativeTime(null)).toBe('—');
      expect(formatRelativeTime(undefined)).toBe('—');
      expect(formatRelativeTime('invalid-string', { fallback: 'N/A' })).toBe('N/A');
    });

    it('handles daylight-saving (DST) boundary values accurately', () => {
      // Spring forward boundary: 23 hours elapsed between UTC timestamps
      const springStart = new Date('2026-03-29T01:00:00.000Z');
      const springEnd = new Date('2026-03-30T00:00:00.000Z'); // 23h later
      const springResult = formatRelativeTime(springStart, { now: springEnd, locale: 'en' });
      expect(springResult).toMatch(/23\s?h/i);

      // Fall back boundary: 25 hours elapsed between UTC timestamps
      const fallStart = new Date('2026-10-25T01:00:00.000Z');
      const fallEnd = new Date('2026-10-26T02:00:00.000Z'); // 25h later
      const fallResult = formatRelativeTime(fallStart, { now: fallEnd, locale: 'en' });
      expect(fallResult).toMatch(/1\s?d/i);
    });
  });

  describe('formatAbsoluteDate', () => {
    it('formats dates with locale and timezone options', () => {
      const date = new Date('2026-10-18T12:30:00.000Z');
      const formattedUtc = formatAbsoluteDate(date, {
        locale: 'en-US',
        timeZone: 'UTC',
        dateStyle: 'medium',
      });
      expect(formattedUtc).toContain('Oct');
      expect(formattedUtc).toContain('18');
      expect(formattedUtc).toContain('2026');
    });

    it('returns fallback for invalid dates', () => {
      expect(formatAbsoluteDate(null)).toBe('—');
      expect(formatAbsoluteDate('invalid')).toBe('—');
    });
  });

  describe('formatNumber and formatCount', () => {
    it('formats counts with compact notation', () => {
      expect(formatNumber(1200, { notation: 'compact', locale: 'en' })).toBe('1.2K');
      expect(formatNumber(1500000, { notation: 'compact', locale: 'en' })).toBe('1.5M');
    });

    it('returns fallback for non-numbers', () => {
      expect(formatNumber(null)).toBe('0');
      expect(formatNumber(NaN, { fallback: 'None' })).toBe('None');
    });

    it('formats plural counts consistently', () => {
      expect(formatCount(1, 'confession', 'confessions', { locale: 'en' })).toBe(
        '1 confession',
      );
      expect(formatCount(5, 'confession', 'confessions', { locale: 'en' })).toBe(
        '5 confessions',
      );
      expect(formatCount(0, 'confession', 'confessions', { locale: 'en' })).toBe(
        '0 confessions',
      );
    });
  });
});
