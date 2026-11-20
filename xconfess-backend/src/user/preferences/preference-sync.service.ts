import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  SyncedPreferenceItem,
  SyncPreferencesDto,
  PreferenceSyncResponse,
  ALLOWED_SYNC_PREFERENCE_KEYS,
  PROHIBITED_DEVICE_KEYS,
} from './preference-sync.types';

@Injectable()
export class PreferenceSyncService {
  // Map of userId -> Map<preferenceKey, SyncedPreferenceItem>
  private readonly store = new Map<string, Map<string, SyncedPreferenceItem>>();

  /**
   * Retrieves all synchronized preferences for a given user
   */
  async getPreferences(userId: string): Promise<PreferenceSyncResponse> {
    if (!userId) {
      throw new BadRequestException('User ID required');
    }

    const userPrefs = this.store.get(userId) || new Map<string, SyncedPreferenceItem>();
    return {
      userId,
      lastSyncedAt: new Date().toISOString(),
      items: Array.from(userPrefs.values()),
      rejectedKeys: [],
    };
  }

  /**
   * Synchronizes preferences from a device with deterministic conflict resolution
   * Rule:
   * 1. Check allowlist; exclude prohibited keys and device-local secrets.
   * 2. Compare incoming item with existing item:
   *    a. Higher `version` wins.
   *    b. If versions match, later `clientUpdatedAt` wins.
   *    c. If timestamps match, tie-break deterministically using `deviceId > existing.deviceId`.
   */
  async syncPreferences(
    userId: string,
    dto: SyncPreferencesDto,
  ): Promise<PreferenceSyncResponse> {
    if (!userId) {
      throw new BadRequestException('User ID required');
    }
    if (!dto.deviceId || dto.deviceId.trim() === '') {
      throw new BadRequestException('deviceId is required for cross-device sync');
    }

    if (!this.store.has(userId)) {
      this.store.set(userId, new Map<string, SyncedPreferenceItem>());
    }

    const currentMap = this.store.get(userId)!;
    const rejectedKeys: string[] = [];

    for (const incoming of dto.items || []) {
      const key = incoming.key;

      // Reject prohibited device-local secrets
      if (PROHIBITED_DEVICE_KEYS.has(key) || !ALLOWED_SYNC_PREFERENCE_KEYS.has(key)) {
        rejectedKeys.push(key);
        continue;
      }

      const existing = currentMap.get(key);
      if (!existing) {
        currentMap.set(key, { ...incoming, deviceId: dto.deviceId });
        continue;
      }

      // Conflict resolution: deterministic LWW rule
      if (this.shouldIncomingWin(incoming, existing)) {
        currentMap.set(key, { ...incoming, deviceId: dto.deviceId });
      }
    }

    return {
      userId,
      lastSyncedAt: new Date().toISOString(),
      items: Array.from(currentMap.values()),
      rejectedKeys,
    };
  }

  /**
   * Evaluates deterministic tie-breaking:
   * 1. Higher version wins
   * 2. Later timestamp wins
   * 3. Lexicographical deviceId comparison wins
   */
  private shouldIncomingWin(
    incoming: SyncedPreferenceItem,
    existing: SyncedPreferenceItem,
  ): boolean {
    if (incoming.version > existing.version) {
      return true;
    }
    if (incoming.version < existing.version) {
      return false;
    }

    // Version tie: compare clientUpdatedAt
    const incomingTime = new Date(incoming.clientUpdatedAt).getTime();
    const existingTime = new Date(existing.clientUpdatedAt).getTime();

    if (incomingTime > existingTime) {
      return true;
    }
    if (incomingTime < existingTime) {
      return false;
    }

    // Timestamp tie: deterministic string comparison of deviceId
    return incoming.deviceId.localeCompare(existing.deviceId) > 0;
  }
}
