export interface SyncedPreferenceItem {
  key: string;
  value: any;
  version: number;
  clientUpdatedAt: string;
  deviceId: string;
}

export interface SyncPreferencesDto {
  deviceId: string;
  items: SyncedPreferenceItem[];
}

export interface PreferenceSyncResponse {
  userId: string;
  lastSyncedAt: string;
  items: SyncedPreferenceItem[];
  rejectedKeys: string[];
}

// Allowlist of synchronizable non-sensitive preferences
export const ALLOWED_SYNC_PREFERENCE_KEYS = new Set([
  'theme',
  'contentLanguage',
  'nsfwBlur',
  'emailDigestFrequency',
  'soundEffectsEnabled',
  'reducedMotion',
  'displayCompactMode',
]);

// Prohibited device-local secrets and identifiers
export const PROHIBITED_DEVICE_KEYS = new Set([
  'pushNotificationToken',
  'deviceBiometricKey',
  'localEncryptionKey',
  'sessionCookie',
  'hardwareId',
  'privateKeystore',
  'authToken',
  'clientSecret',
]);
