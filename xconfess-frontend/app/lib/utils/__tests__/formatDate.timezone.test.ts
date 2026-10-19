import { formatDate } from '../formatDate';

describe('formatDate timezone and daylight-saving boundaries', () => {
  const originalTimezone = process.env.TZ;

  afterEach(() => {
    jest.useRealTimers();
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  });

  it.each([
    {
      timezone: 'America/New_York',
      now: '2025-03-09T07:30:00.000Z',
      date: '2025-03-09T06:30:00.000Z',
    },
    {
      timezone: 'America/New_York',
      now: '2025-11-02T06:30:00.000Z',
      date: '2025-11-02T05:30:00.000Z',
    },
    {
      timezone: 'Europe/Berlin',
      now: '2025-03-30T01:30:00.000Z',
      date: '2025-03-30T00:30:00.000Z',
    },
  ])(
    'uses elapsed instants across the DST transition in $timezone',
    ({ timezone, now, date }) => {
      process.env.TZ = timezone;
      jest.useFakeTimers();
      jest.setSystemTime(new Date(now));

      expect(formatDate(new Date(date))).toBe('1h ago');
    },
  );

  it('renders older timestamps in the viewer timezone', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-03-10T12:00:00.000Z'));

    process.env.TZ = 'UTC';
    expect(formatDate(new Date('2025-03-01T00:30:00.000Z'))).toBe('Mar 1');

    process.env.TZ = 'America/Los_Angeles';
    expect(formatDate(new Date('2025-03-01T00:30:00.000Z'))).toBe('Feb 28');
  });
});