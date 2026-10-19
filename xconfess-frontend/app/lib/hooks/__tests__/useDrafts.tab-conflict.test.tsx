import { act, renderHook } from '@testing-library/react';
import { useDrafts } from '@/app/lib/hooks/useDrafts';
import { Draft } from '@/app/lib/types/draft';

jest.mock('@/app/lib/hooks/useAuth', () => ({
  useAuth: () => ({ token: null, isAuthenticated: false }),
}));

const STORAGE_KEY = 'xconfess-drafts';

describe('useDrafts – cross-tab draft conflict handling (Issue #221)', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it('detects a stale write when another browser tab wrote a newer revision and preserves both versions', async () => {
    const initialDraft: Draft = {
      id: 'd-1',
      body: 'initial text from tab 1',
      version: 1,
      savedAt: 1000,
      characterCount: 24,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([initialDraft]));

    // Tab 1 mounts and loads the draft
    const { result } = renderHook(() => useDrafts());
    expect(result.current.drafts).toHaveLength(1);
    expect(result.current.drafts[0].version).toBe(1);

    // Simulate Tab 2 updating the draft in localStorage
    const tab2UpdatedDraft: Draft = {
      id: 'd-1',
      body: 'newer text written by tab 2',
      version: 2,
      savedAt: 2000,
      characterCount: 27,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([tab2UpdatedDraft]));

    // Now Tab 1 attempts to save a stale edit based on version 1
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.updateDraft('d-1', {
        body: 'tab 1 conflicting edit',
        version: 1,
      });
    });

    // Write should be rejected
    expect(ok).toBe(false);

    // localStorage must NOT have been overwritten with the stale text
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored[0].body).toBe('newer text written by tab 2');
    expect(stored[0].version).toBe(2);

    // Conflict must be recorded with both versions preserved
    expect(result.current.conflicts).toHaveLength(1);
    const conflict = result.current.conflicts[0];
    expect(conflict.reason).toBe('tab_conflict');
    expect(conflict.local.body).toBe('tab 1 conflicting edit'); // Local edit recoverable
    expect(conflict.remote?.body).toBe('newer text written by tab 2'); // Tab 2 content preserved
    expect(result.current.error).toMatch(/changed in another browser tab/i);
  });

  it('resolves tab conflict with "keep-local" by rebasing and updating localStorage', async () => {
    const initialDraft: Draft = {
      id: 'd-1',
      body: 'initial text',
      version: 1,
      savedAt: 1000,
      characterCount: 12,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([initialDraft]));

    const { result } = renderHook(() => useDrafts());

    // Tab 2 writes version 2
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { ...initialDraft, body: 'tab 2 text', version: 2, savedAt: 2000 },
      ]),
    );

    // Tab 1 attempts to save version 1
    await act(async () => {
      await result.current.updateDraft('d-1', {
        body: 'tab 1 text',
        version: 1,
      });
    });
    expect(result.current.conflicts).toHaveLength(1);

    // Resolve with keep-local
    let resolved: boolean | undefined;
    await act(async () => {
      resolved = await result.current.resolveConflict('d-1', 'keep-local');
    });

    expect(resolved).toBe(true);
    expect(result.current.conflicts).toHaveLength(0);

    // localStorage should now have tab 1 text with rebased version 3
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored[0].body).toBe('tab 1 text');
    expect(stored[0].version).toBe(3);
  });

  it('resolves tab conflict with "save-as-copy" preserving both drafts', async () => {
    const initialDraft: Draft = {
      id: 'd-1',
      title: 'My Story',
      body: 'initial text',
      version: 1,
      savedAt: 1000,
      characterCount: 12,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([initialDraft]));

    const { result } = renderHook(() => useDrafts());

    // Tab 2 updates d-1
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { ...initialDraft, body: 'tab 2 text', version: 2, savedAt: 2000 },
      ]),
    );

    // Tab 1 attempts to save
    await act(async () => {
      await result.current.updateDraft('d-1', {
        body: 'tab 1 text',
        title: 'My Story',
        version: 1,
      });
    });
    expect(result.current.conflicts).toHaveLength(1);

    // User chooses to save as separate draft
    await act(async () => {
      await result.current.resolveConflict('d-1', 'save-as-copy');
    });

    expect(result.current.conflicts).toHaveLength(0);

    // Both drafts must now exist in storage!
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    expect(stored).toHaveLength(2);
    expect(stored.some((d: Draft) => d.id === 'd-1' && d.body === 'tab 2 text')).toBe(true);
    expect(
      stored.some(
        (d: Draft) => d.id !== 'd-1' && d.body === 'tab 1 text' && d.title?.includes('(Copy)'),
      ),
    ).toBe(true);
  });
});
