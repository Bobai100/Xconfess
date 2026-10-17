import { test, expect, Page } from '@playwright/test';

const SEARCH_PATH = '/search';

const DEFAULT_FILTERS = {
  query: '',
  category: 'all',
  sort: 'relevance',
};

async function gotoSearch(page: Page, search = '') {
  await page.goto(`${SEARCH_PATH}${search}`);
  await expect(page.getByRole('search')).toBeVisible();
}

async function getLiveRegionText(page: Page): Promise<string> {
  const liveRegion = page.locator('[aria-live="polite"], [aria-live="assertive"]').first();
  await expect(liveRegion).toBeVisible();
  return (await liveRegion.textContent())?.trim() ?? '';
}

test.describe('SearchFilters accessibility and state', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSearch(page);
  });

  test('supports keyboard-only navigation through query, filters, sort, and reset', async ({ page }) => {
    const queryInput = page.getByRole('searchbox', { name: /search/i });
    await expect(queryInput).toBeVisible();

    // Focus the query input and type using only the keyboard.
    await queryInput.focus();
    await expect(queryInput).toBeFocused();
    await page.keyboard.type('widgets');
    await expect(queryInput).toHaveValue('widgets');

    // Tab to the category filter and change it via keyboard.
    await page.keyboard.press('Tab');
    const categoryFilter = page.getByRole('combobox', { name: /category/i });
    await expect(categoryFilter).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(categoryFilter).not.toHaveValue('all');

    // Tab to the sort control and change it via keyboard.
    await page.keyboard.press('Tab');
    const sortControl = page.getByRole('combobox', { name: /sort/i });
    await expect(sortControl).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(sortControl).not.toHaveValue('relevance');

    // Tab to the reset button and activate it via keyboard.
    await page.keyboard.press('Tab');
    const resetButton = page.getByRole('button', { name: /reset/i });
    await expect(resetButton).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(queryInput).toHaveValue(DEFAULT_FILTERS.query);
    await expect(categoryFilter).toHaveValue(DEFAULT_FILTERS.category);
    await expect(sortControl).toHaveValue(DEFAULT_FILTERS.sort);
  });

  test('announces result counts via aria-live region', async ({ page }) => {
    const queryInput = page.getByRole('searchbox', { name: /search/i });
    await queryInput.fill('widgets');

    await expect
      .poll(async () => getLiveRegionText(page), { timeout: 5000 })
      .toMatch(/\d+\s+results?/i);
  });

  test('announces empty results via aria-live region', async ({ page }) => {
    const queryInput = page.getByRole('searchbox', { name: /search/i });
    await queryInput.fill('zzzz-no-such-result-zzzz');

    await expect
      .poll(async () => getLiveRegionText(page), { timeout: 5000 })
      .toMatch(/no results|0 results/i);

    await expect(page.getByText(/no results/i).first()).toBeVisible();
  });

  test('reset restores defaults and updates the URL', async ({ page }) => {
    const queryInput = page.getByRole('searchbox', { name: /search/i });
    await queryInput.fill('widgets');

    const categoryFilter = page.getByRole('combobox', { name: /category/i });
    await categoryFilter.selectOption({ index: 1 });

    const sortControl = page.getByRole('combobox', { name: /sort/i });
    await sortControl.selectOption({ index: 1 });

    await expect(page).toHaveURL(/q=widgets/);

    const resetButton = page.getByRole('button', { name: /reset/i });
    await resetButton.click();

    await expect(queryInput).toHaveValue(DEFAULT_FILTERS.query);
    await expect(categoryFilter).toHaveValue(DEFAULT_FILTERS.category);
    await expect(sortControl).toHaveValue(DEFAULT_FILTERS.sort);

    await expect(page).not.toHaveURL(/q=widgets/);
    await expect(page).toHaveURL(new RegExp(`${SEARCH_PATH}(\\?.*)?$`));
  });

  test('shared URL with invalid filter values falls back to safe defaults', async ({ page }) => {
    await gotoSearch(page, '?q=widgets&category=__invalid__&sort=__invalid__');

    const queryInput = page.getByRole('searchbox', { name: /search/i });
    await expect(queryInput).toHaveValue('widgets');

    const categoryFilter = page.getByRole('combobox', { name: /category/i });
    await expect(categoryFilter).toHaveValue(DEFAULT_FILTERS.category);

    const sortControl = page.getByRole('combobox', { name: /sort/i });
    await expect(sortControl).toHaveValue(DEFAULT_FILTERS.sort);

    // The URL should be normalized to drop invalid values while preserving valid ones.
    await expect(page).toHaveURL(/q=widgets/);
    await expect(page).not.toHaveURL(/__invalid__/);
  });
});