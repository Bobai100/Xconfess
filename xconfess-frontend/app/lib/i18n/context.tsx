'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import {
  SupportedLocale,
  MessageKey,
  MessageCatalog,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from './types';
import { en } from './locales/en';
import { es } from './locales/es';

const CATALOGS: Record<SupportedLocale, MessageCatalog> = {
  en,
  es,
  fr: en, // Fallback to English for languages without full translations
  de: en,
};

export interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  locales: SupportedLocale[];
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = 'xconfess-locale';

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: SupportedLocale;
}) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(STORAGE_KEY) as SupportedLocale;
        if (stored && SUPPORTED_LOCALES.includes(stored)) {
          return stored;
        }
      } catch {
        // Storage access error fallback
      }
    }
    return initialLocale;
  });

  const setLocale = useCallback((newLocale: SupportedLocale) => {
    if (SUPPORTED_LOCALES.includes(newLocale)) {
      setLocaleState(newLocale);
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(STORAGE_KEY, newLocale);
          document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=31536000`;
        } catch {
          // Ignore storage errors
        }
      }
    }
  }, []);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>): string => {
      const activeCatalog = CATALOGS[locale] || CATALOGS[DEFAULT_LOCALE];
      let message = activeCatalog[key];

      // Fallback to base English catalogue if missing in current locale
      if (!message && locale !== DEFAULT_LOCALE) {
        message = CATALOGS[DEFAULT_LOCALE][key];
      }

      if (!message) {
        return key;
      }

      if (params) {
        return Object.entries(params).reduce(
          (acc, [paramKey, val]) =>
            acc.replaceAll(`{${paramKey}}`, String(val)),
          message,
        );
      }

      return message;
    },
    [locale],
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      locales: SUPPORTED_LOCALES,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Return graceful fallback if rendered outside provider
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (key: MessageKey, params?: Record<string, string | number>) => {
        const message = en[key] || key;
        if (params) {
          return Object.entries(params).reduce(
            (acc, [paramKey, val]) =>
              acc.replaceAll(`{${paramKey}}`, String(val)),
            message,
          );
        }
        return message;
      },
      locales: SUPPORTED_LOCALES,
    };
  }
  return ctx;
}

export const useTranslation = useI18n;
