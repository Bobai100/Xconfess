import {
  mergePrivacySettingsAfterConflict,
  type PrivacySettings,
} from '@/app/lib/utils/privacySettings';

describe('mergePrivacySettingsAfterConflict', () => {
  it('preserves user-edited fields and adopts untouched authoritative fields', () => {
    const baseline: PrivacySettings = {
      isDiscoverable: true,
      canReceiveReplies: true,
      showReactions: true,
      dataProcessingConsent: false,
    };
    const submitted: PrivacySettings = {
      ...baseline,
      isDiscoverable: false,
    };
    const server: PrivacySettings = {
      ...baseline,
      canReceiveReplies: false,
      showReactions: false,
    };

    expect(mergePrivacySettingsAfterConflict(submitted, baseline, server)).toEqual({
      isDiscoverable: false,
      canReceiveReplies: false,
      showReactions: false,
      dataProcessingConsent: false,
    });
  });
});