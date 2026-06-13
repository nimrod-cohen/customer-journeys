// E2E (real Chromium): a company sets its own Amazon SES credentials (§10) in
// Company settings. The secret is write-only (placeholder after save). Cleans up
// (Remove) so it doesn't affect other domain tests that rely on the local mock.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('company SES credentials: save (secret write-only) then remove', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-company').click();
  await page.getByTestId('company-settings').waitFor();
  await page.getByTestId('ses-config').waitFor();

  // Starts unconfigured; can't save without a secret.
  await expect(page.getByTestId('ses-status')).toHaveText('not configured');

  await page.getByTestId('ses-region').fill('il-central-1');
  await page.getByTestId('ses-access-key').fill('AKIAEXAMPLE');
  await page.getByTestId('ses-secret').fill('super-secret-value');
  await page.getByTestId('ses-save').click();
  await expect(page.getByTestId('ses-status')).toHaveText('configured');

  // Reload: region + key persist; the secret is NOT returned (write-only) — the
  // field is empty with a "leave blank to keep" placeholder.
  await page.reload();
  await page.getByTestId('ses-config').waitFor();
  await expect(page.getByTestId('ses-status')).toHaveText('configured');
  await expect(page.getByTestId('ses-region')).toHaveValue('il-central-1');
  await expect(page.getByTestId('ses-access-key')).toHaveValue('AKIAEXAMPLE');
  await expect(page.getByTestId('ses-secret')).toHaveValue('');

  // Remove → back to unconfigured (also resets state for other tests).
  await page.getByTestId('ses-remove').click();
  await expect(page.getByTestId('ses-status')).toHaveText('not configured');
});
