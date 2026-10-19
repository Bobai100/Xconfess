import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DraftManager } from '../DraftManager';
import { useDrafts } from '@/app/lib/hooks/useDrafts';

jest.mock('@/app/lib/hooks/useDrafts', () => ({
  useDrafts: jest.fn(),
}));

jest.mock('@/app/components/common/Toast', () => ({
  useGlobalToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockUseDrafts = useDrafts as jest.MockedFunction<typeof useDrafts>;

describe('DraftManager – Conflict UI and Decision Flow (Issue #221)', () => {
  const mockResolveConflict = jest.fn().mockResolvedValue(true);
  const mockOnLoadDraft = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders accessible alert and decision buttons when a tab conflict occurs', async () => {
    mockUseDrafts.mockReturnValue({
      drafts: [{ id: 'd-1', body: 'saved', savedAt: 1000, characterCount: 5 }],
      isLoading: false,
      error: null,
      isRemote: false,
      conflicts: [
        {
          draftId: 'd-1',
          reason: 'tab_conflict',
          detectedAt: 1000,
          local: { body: 'local edit' },
          remote: { id: 'd-1', body: 'other tab edit', savedAt: 2000, characterCount: 14, version: 2 },
        },
      ],
      resolveConflict: mockResolveConflict,
      saveDraft: jest.fn(),
      updateDraft: jest.fn(),
      deleteDraft: jest.fn(),
      clearDrafts: jest.fn(),
      loadDraft: jest.fn().mockReturnValue({ id: 'd-1', body: 'saved' }),
    });

    const user = userEvent.setup();
    render(
      <DraftManager
        currentDraft={{ body: 'local edit' }}
        onLoadDraft={mockOnLoadDraft}
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/edited in another browser tab/i);

    const keepLocalBtn = screen.getByRole('button', { name: /keep my version/i });
    const useOtherTabBtn = screen.getByRole('button', { name: /use other tab's version/i });
    const saveCopyBtn = screen.getByRole('button', { name: /save as separate draft/i });
    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });

    expect(keepLocalBtn).toBeInTheDocument();
    expect(useOtherTabBtn).toBeInTheDocument();
    expect(saveCopyBtn).toBeInTheDocument();
    expect(dismissBtn).toBeInTheDocument();

    // Click "Save as separate draft"
    await user.click(saveCopyBtn);
    expect(mockResolveConflict).toHaveBeenCalledWith('d-1', 'save-as-copy');
  });
});
