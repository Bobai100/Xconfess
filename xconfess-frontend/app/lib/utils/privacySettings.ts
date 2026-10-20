export interface PrivacySettings {
  isDiscoverable: boolean;
  canReceiveReplies: boolean;
  showReactions: boolean;
  dataProcessingConsent: boolean;
}

export const PRIVACY_SETTING_KEYS: (keyof PrivacySettings)[] = [
  'isDiscoverable',
  'canReceiveReplies',
  'showReactions',
  'dataProcessingConsent',
];

export function mergePrivacySettingsAfterConflict(
  submitted: PrivacySettings,
  baseline: PrivacySettings,
  server: PrivacySettings,
): PrivacySettings {
  return Object.fromEntries(
    PRIVACY_SETTING_KEYS.map((key) => [
      key,
      submitted[key] !== baseline[key] ? submitted[key] : server[key],
    ]),
  ) as PrivacySettings;
}