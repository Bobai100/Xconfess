import {
  REQUIRED_MESSAGE_KEYS,
  assertCompleteCatalog,
  MessageKey,
} from '../types';
import { en } from '../locales/en';
import { es } from '../locales/es';

describe('i18n Message Catalogues and Typed Coverage', () => {
  it('en catalogue has 100% coverage of all required message keys', () => {
    expect(() => assertCompleteCatalog('en', en)).not.toThrow();

    for (const key of REQUIRED_MESSAGE_KEYS) {
      expect(en[key]).toBeDefined();
      expect(typeof en[key]).toBe('string');
      expect(en[key].trim().length).toBeGreaterThan(0);
    }
  });

  it('es catalogue has 100% coverage of all required message keys', () => {
    expect(() => assertCompleteCatalog('es', es)).not.toThrow();

    for (const key of REQUIRED_MESSAGE_KEYS) {
      expect(es[key]).toBeDefined();
      expect(typeof es[key]).toBe('string');
      expect(es[key].trim().length).toBeGreaterThan(0);
    }
  });

  it('assertCompleteCatalog fails check with explicit error when required keys are missing', () => {
    const incompleteCatalog: Partial<Record<MessageKey, string>> = {
      'auth.login.title': 'Welcome Back',
    };

    expect(() => assertCompleteCatalog('test-locale', incompleteCatalog)).toThrow(
      /missing \d+ required message keys/i,
    );
  });

  it('contains expected critical auth, composer, moderation, and notification keys', () => {
    const criticalPrefixes = ['auth.', 'composer.', 'moderation.', 'notifications.'];
    for (const prefix of criticalPrefixes) {
      const keysWithPrefix = REQUIRED_MESSAGE_KEYS.filter((k) => k.startsWith(prefix));
      expect(keysWithPrefix.length).toBeGreaterThan(0);
    }
  });
});
