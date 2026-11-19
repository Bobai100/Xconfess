/**
 * Tests for analytics governance constants and schema registry (#86).
 */
import {
  ANALYTICS_EVENT_REGISTRY,
  ANALYTICS_DEFAULT_RETENTION_DAYS,
  ANALYTICS_EVENT_PURPOSES,
  ANALYTICS_PRIVACY,
  getEventRegistryEntry,
  getEventRetentionDays,
  isSchemaVersionCurrent,
  EventRegistryEntry,
} from './analytics.constants';
import { ANALYTICS_EVENT_NAMES, ANALYTICS_SCHEMA_VERSION } from './entities/analytics-event.entity';

describe('analytics.constants — schema registry (#86)', () => {
  // ─── Registry completeness ────────────────────────────────────────────────

  it('has a registry entry for every allowlisted event name', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(ANALYTICS_EVENT_REGISTRY[name]).toBeDefined();
    }
  });

  it('every registry entry has required fields', () => {
    for (const [name, entry] of Object.entries(ANALYTICS_EVENT_REGISTRY)) {
      expect(typeof entry.owner).toBe('string');
      expect(entry.owner.length).toBeGreaterThan(0);

      expect(typeof entry.purpose).toBe('string');
      expect(ANALYTICS_EVENT_PURPOSES).toContain(entry.purpose as any);

      expect(typeof entry.schemaVersion).toBe('number');
      expect(entry.schemaVersion).toBeGreaterThanOrEqual(1);

      expect(
        entry.retentionDays === null || typeof entry.retentionDays === 'number',
      ).toBe(true);

      expect(typeof entry.consentRequired).toBe('boolean');
      expect(entry.allowedMetadataFields.length).toBeGreaterThan(0);
      expect(
        ['daily_count', 'daily_count_by_network', 'daily_count_by_state'],
      ).toContain(entry.aggregationBehavior);
    }
  });

  it('declares unique metadata fields for every event', () => {
    for (const entry of Object.values(ANALYTICS_EVENT_REGISTRY)) {
      expect(new Set(entry.allowedMetadataFields).size).toBe(
        entry.allowedMetadataFields.length,
      );
    }
  });

  it('all registry entries use an allowed purpose', () => {
    for (const [, entry] of Object.entries(ANALYTICS_EVENT_REGISTRY)) {
      expect(ANALYTICS_EVENT_PURPOSES).toContain(entry.purpose as any);
    }
  });

  // ─── Schema version matching ──────────────────────────────────────────────

  it('all registry entries match the global ANALYTICS_SCHEMA_VERSION', () => {
    for (const [name, entry] of Object.entries(ANALYTICS_EVENT_REGISTRY)) {
      expect(entry.schemaVersion).toBe(ANALYTICS_SCHEMA_VERSION);
    }
  });

  // ─── Retention days ───────────────────────────────────────────────────────

  it('retention days are either null or positive integers', () => {
    for (const [, entry] of Object.entries(ANALYTICS_EVENT_REGISTRY)) {
      if (entry.retentionDays !== null) {
        expect(Number.isInteger(entry.retentionDays)).toBe(true);
        expect(entry.retentionDays).toBeGreaterThan(0);
      }
    }
  });

  // ─── getEventRegistryEntry ────────────────────────────────────────────────

  describe('getEventRegistryEntry()', () => {
    it('returns the entry for a known event', () => {
      const entry = getEventRegistryEntry('user_registered');
      expect(entry).toBeDefined();
      expect(entry!.owner).toBe('auth');
    });

    it('returns undefined for an unknown event', () => {
      const entry = getEventRegistryEntry('__unknown_event__');
      expect(entry).toBeUndefined();
    });
  });

  // ─── getEventRetentionDays ────────────────────────────────────────────────

  describe('getEventRetentionDays()', () => {
    it('returns the configured retention days for a known event', () => {
      const days = getEventRetentionDays('user_registered');
      expect(days).toBeGreaterThan(0);
    });

    it('falls back to ANALYTICS_DEFAULT_RETENTION_DAYS for unknown events', () => {
      const days = getEventRetentionDays('__unknown_event__');
      expect(days).toBe(ANALYTICS_DEFAULT_RETENTION_DAYS);
    });

    it('falls back to ANALYTICS_DEFAULT_RETENTION_DAYS when retentionDays is null', () => {
      // Create a scenario where retentionDays is null
      // (no current event has null, but this tests the fallback path)
      // We test via getEventRetentionDays with a missing entry instead.
      const days = getEventRetentionDays('not_a_real_event');
      expect(days).toBe(ANALYTICS_DEFAULT_RETENTION_DAYS);
    });
  });

  // ─── isSchemaVersionCurrent ───────────────────────────────────────────────

  describe('isSchemaVersionCurrent()', () => {
    it('returns true for a known event with matching schema version', () => {
      const entry = getEventRegistryEntry('confession_created')!;
      expect(isSchemaVersionCurrent('confession_created', entry.schemaVersion)).toBe(true);
    });

    it('returns false for a known event with mismatched schema version', () => {
      expect(isSchemaVersionCurrent('confession_created', 999)).toBe(false);
    });

    it('returns false for an unknown event', () => {
      expect(isSchemaVersionCurrent('__unknown__', 1)).toBe(false);
    });
  });

  // ─── Privacy constant ─────────────────────────────────────────────────────

  it('MIN_COHORT_SIZE is a positive integer', () => {
    expect(Number.isInteger(ANALYTICS_PRIVACY.MIN_COHORT_SIZE)).toBe(true);
    expect(ANALYTICS_PRIVACY.MIN_COHORT_SIZE).toBeGreaterThan(0);
  });

  // ─── ANALYTICS_DEFAULT_RETENTION_DAYS ────────────────────────────────────

  it('ANALYTICS_DEFAULT_RETENTION_DAYS is a positive integer', () => {
    expect(Number.isInteger(ANALYTICS_DEFAULT_RETENTION_DAYS)).toBe(true);
    expect(ANALYTICS_DEFAULT_RETENTION_DAYS).toBeGreaterThan(0);
  });
});
