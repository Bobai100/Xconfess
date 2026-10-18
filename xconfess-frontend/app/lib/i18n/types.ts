export type SupportedLocale = 'en' | 'es' | 'fr' | 'de';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'es', 'fr', 'de'];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const REQUIRED_MESSAGE_KEYS = [
  // Auth
  'auth.login.title',
  'auth.login.subtitle',
  'auth.login.emailLabel',
  'auth.login.passwordLabel',
  'auth.login.submitButton',
  'auth.login.submitting',
  'auth.login.forgotPasswordLink',
  'auth.login.noAccount',
  'auth.login.signUpLink',
  'auth.register.title',
  'auth.register.subtitle',
  'auth.register.usernameLabel',
  'auth.register.emailLabel',
  'auth.register.passwordLabel',
  'auth.register.confirmPasswordLabel',
  'auth.register.submitButton',
  'auth.register.submitting',
  'auth.register.hasAccount',
  'auth.register.loginLink',
  'auth.forgotPassword.title',
  'auth.forgotPassword.subtitle',
  'auth.forgotPassword.emailLabel',
  'auth.forgotPassword.submitButton',
  'auth.forgotPassword.submitting',
  'auth.forgotPassword.backToLogin',
  'auth.forgotPassword.successMessage',
  'auth.requestIdNotice.prefix',
  'auth.requestIdNotice.copyButton',
  'auth.requestIdNotice.copied',

  // Composer
  'composer.placeholder',
  'composer.titlePlaceholder',
  'composer.charactersCount',
  'composer.charactersRemaining',
  'composer.submitButton',
  'composer.submitting',
  'composer.anonymousNotice',
  'composer.draftSaved',
  'composer.draftSaving',
  'composer.discardDraft',
  'composer.genderLabel',
  'composer.genderAll',
  'composer.genderMale',
  'composer.genderFemale',
  'composer.genderOther',
  'composer.previewTab',
  'composer.writeTab',

  // Moderation
  'moderation.reportButton',
  'moderation.reporting',
  'moderation.reported',
  'moderation.reportSuccess',
  'moderation.reportFailed',
  'moderation.reportReasonPlaceholder',
  'moderation.reportTypeSpam',
  'moderation.reportTypeHarassment',
  'moderation.reportTypeHateSpeech',
  'moderation.reportTypeInappropriate',
  'moderation.reportTypeCopyright',
  'moderation.reportTypeOther',
  'moderation.reportsTitle',
  'moderation.reportStatusPending',
  'moderation.reportStatusReviewing',
  'moderation.reportStatusResolved',
  'moderation.reportStatusDismissed',
  'moderation.resolveButton',
  'moderation.dismissButton',

  // Notifications
  'notifications.title',
  'notifications.empty',
  'notifications.markAllAsRead',
  'notifications.preferencesTitle',
  'notifications.emailNotifications',
  'notifications.pushNotifications',
  'notifications.inAppNotifications',
  'notifications.savePreferences',
  'notifications.preferencesSaved',

  // Common
  'common.loading',
  'common.error',
  'common.cancel',
  'common.save',
  'common.delete',
  'common.confirm',
  'common.retry',
  'common.dismiss',
  'common.networkError',
] as const;

export type MessageKey = (typeof REQUIRED_MESSAGE_KEYS)[number];

export type MessageCatalog = Record<MessageKey, string>;

/**
 * Asserts that a catalog implements all required message keys.
 * Throws an explicit error listing any missing keys to fail CI / checks.
 */
export function assertCompleteCatalog(
  locale: string,
  catalog: Partial<Record<MessageKey, string>>,
): asserts catalog is MessageCatalog {
  const missingKeys = REQUIRED_MESSAGE_KEYS.filter((key) => !catalog[key]);
  if (missingKeys.length > 0) {
    throw new Error(
      `Locale "${locale}" is missing ${missingKeys.length} required message keys: ${missingKeys.join(', ')}`,
    );
  }
}
