// E2E (real Chromium): a signed-in user edits their own display name (§12), and
// the company name shows at the top of the sidebar.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('edit my account display name; company name shows in the sidebar', async ({ page }) => {
  await loginAs(page, DEV_OWNER);

  // Company name appears at the top of the sidebar (above the workspace selector).
  await expect(page.getByTestId('sidebar-company')).toBeVisible();
  await expect(page.getByTestId('sidebar-company')).not.toBeEmpty();

  // The footer user block opens My account.
  await page.getByTestId('account-link').click();
  await page.getByTestId('account-settings').waitFor();

  // Email is shown read-only; the role too.
  await expect(page.getByTestId('account-email')).toContainText('@');

  // Set a display name → saved, and reflected in the sidebar footer.
  const unique = 'Test User ' + Date.now();
  await page.getByTestId('account-name').fill(unique);
  await page.getByTestId('account-save').click();
  await expect(page.getByTestId('account-link')).toContainText(unique);

  // Persists across reload.
  await page.reload();
  await page.getByTestId('account-link').click();
  await page.getByTestId('account-settings').waitFor();
  await expect(page.getByTestId('account-name')).toHaveValue(unique);
});
