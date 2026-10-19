import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { I18nProvider, useI18n, useTranslation } from '../context';

describe('I18nProvider and useTranslation hook', () => {
  it('provides default English translations and interpolates parameters', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider initialLocale="en">{children}</I18nProvider>
    );

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.locale).toBe('en');
    expect(result.current.t('auth.login.title')).toBe('Welcome Back');
    expect(
      result.current.t('composer.charactersCount', { count: 42 }),
    ).toBe('42 characters');
  });

  it('switches locale and returns localized strings', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <I18nProvider initialLocale="en">{children}</I18nProvider>
    );

    const { result } = renderHook(() => useI18n(), { wrapper });

    act(() => {
      result.current.setLocale('es');
    });

    expect(result.current.locale).toBe('es');
    expect(result.current.t('auth.login.title')).toBe('Bienvenido de nuevo');
  });

  it('gracefully falls back to English when rendered outside provider', () => {
    const { result } = renderHook(() => useTranslation());

    expect(result.current.locale).toBe('en');
    expect(result.current.t('auth.login.submitButton')).toBe('Log In');
  });
});
