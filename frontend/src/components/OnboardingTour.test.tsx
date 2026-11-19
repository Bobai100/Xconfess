import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import OnboardingTour, {
  ONBOARDING_STORAGE_KEY,
  isTourCompleted,
  markTourCompleted,
} from './OnboardingTour';

describe('OnboardingTour', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders the first step covering anonymous posting and privacy', () => {
    render(<OnboardingTour />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/anonymous posting/i)).toBeInTheDocument();
    expect(screen.getByText(/privacy/i)).toBeInTheDocument();
  });

  it('advances through moderation and Stellar steps', () => {
    render(<OnboardingTour />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText(/moderation/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText(/stellar/i)).toBeInTheDocument();
  });

  it('marks completion and hides after finishing the tour', () => {
    render(<OnboardingTour />);
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /finish/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(isTourCompleted()).toBe(true);
  });

  it('does not render when completion state is already stored', () => {
    markTourCompleted();
    render(<OnboardingTour />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('dismisses via the explicit close control and records completion', () => {
    render(<OnboardingTour />);
    fireEvent.click(screen.getByRole('button', { name: /close tour/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(isTourCompleted()).toBe(true);
  });

  it('dismisses via the Escape key and records completion', () => {
    render(<OnboardingTour />);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(isTourCompleted()).toBe(true);
  });

  it('treats invalid stored values as not completed', () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, 'not-a-valid-value');
    expect(isTourCompleted()).toBe(false);
    render(<OnboardingTour />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('treats unavailable storage as not completed without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(() => isTourCompleted()).not.toThrow();
    expect(isTourCompleted()).toBe(false);
  });

  it('does not block the UI when the completion write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    render(<OnboardingTour />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /close tour/i })),
    ).not.toThrow();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
