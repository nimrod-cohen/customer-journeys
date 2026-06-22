// E2E (real Chromium): a company sets its own Amazon SES credentials (§10) in
// Company settings. The secret is write-only (placeholder after save). Cleans up
// (Remove) so it doesn't affect other domain tests that rely on the local mock.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('company SES credentials: save (secret write-only) then remove', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  // The card's initial GET /company/ses-config resets the form fields on resolve;
  // arm the wait BEFORE navigating so it can't be missed, then await it before
  // typing so the async load can't clobber what we fill.
  const initialLoad = page.waitForResponse(
    (r) => r.url().includes('/company/ses-config') && r.request().method() === 'GET',
  );
  await page.getByTestId('nav-company').click();
  await page.getByTestId('company-settings').waitFor();
  await page.getByTestId('company-tab-sending').click(); // SES config lives on the Sending tab
  await page.getByTestId('ses-config').waitFor();
  await initialLoad;

  // Starts unconfigured; can't save without a secret.
  await expect(page.getByTestId('ses-status')).toHaveText('not configured');

  await page.getByTestId('ses-region').fill('il-central-1');
  await page.getByTestId('ses-access-key').fill('AKIAEXAMPLE');
  await page.getByTestId('ses-secret').fill('super-secret-value');
  await page.getByTestId('ses-save').click();
  // Save is a PUT + reload round-trip; allow headroom under full-suite API load.
  await expect(page.getByTestId('ses-status')).toHaveText('configured', { timeout: 15_000 });

  // Reload: region + key persist; the secret is NOT returned (write-only) — the
  // field is empty with a "leave blank to keep" placeholder.
  await page.reload();
  await page.getByTestId('ses-config').waitFor();
  await expect(page.getByTestId('ses-status')).toHaveText('configured', { timeout: 15_000 });
  await expect(page.getByTestId('ses-region')).toHaveValue('il-central-1');
  await expect(page.getByTestId('ses-access-key')).toHaveValue('AKIAEXAMPLE');
  await expect(page.getByTestId('ses-secret')).toHaveValue('');

  // Remove → back to unconfigured (also resets state for other tests).
  await page.getByTestId('ses-remove').click();
  await expect(page.getByTestId('ses-status')).toHaveText('not configured', { timeout: 15_000 });
});
