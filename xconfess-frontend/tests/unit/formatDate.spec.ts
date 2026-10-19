import { formatDate, formatRelativeTime, formatAbsoluteDate } from '@/app/lib/utils/formatDate';

describe('formatDate utility and formatters', () => {
  it('formats recent timestamps as relative time', () => {
    const recent = new Date(Date.now() - 1000 * 30); // 30s ago
    expect(formatDate(recent)).toBe('just now');
  });

  it('formats dates safely when null or undefined are passed', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('formats absolute dates accurately', () => {
    const date = new Date('2026-10-18T12:00:00Z');
    expect(formatAbsoluteDate(date, { locale: 'en-US', timeZone: 'UTC' })).toContain('Oct 18, 2026');
  });
});
