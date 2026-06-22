// E2E (real Chromium): a company sets its own 019 SMS credentials (§10) in
// Company settings. The bearer is write-only (placeholder after save, never
// echoed back). Cleans up (Remove) so the default mock SMS path stays the default
// for other channel tests.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('company 019 SMS credentials: save (bearer write-only) then remove', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  // The card's initial GET /company/channel-config resets the form fields on
  // resolve; arm the wait BEFORE navigating so it can't be missed, then await it
  // before typing so the async load can't clobber what we fill.
  const initialLoad = page.waitForResponse(
    (r) => r.url().includes('/company/channel-config') && r.request().method() === 'GET',
  );
  await page.getByTestId('nav-company').click();
  await page.getByTestId('company-settings').waitFor();
  await page.getByTestId('company-tab-sending').click(); // 019 SMS config lives on the Sending tab
  await page.getByTestId('channel-019-config').waitFor();
  await initialLoad;

  // Starts unconfigured; can't save without a bearer.
  await expect(page.getByTestId('channel-019-status')).toHaveText('not configured');

  await page.getByTestId('channel-019-url').fill('https://019sms.co.il/api');
  await page.getByTestId('channel-019-username').fill('acme');
  await page.getByTestId('channel-019-source').fill('MyBrand');
  await page.getByTestId('channel-019-country').selectOption('IL'); // default country for national-number normalization
  await page.getByTestId('channel-019-secret').fill('super-secret-bearer');
  // The Save button enables only once all four fields are non-blank — wait for it.
  await expect(page.getByTestId('channel-019-save')).toBeEnabled();
  await page.getByTestId('channel-019-save').click();
  // Save is a PUT + reload round-trip; allow headroom under full-suite API load.
  await expect(page.getByTestId('channel-019-status')).toHaveText('configured', { timeout: 15_000 });

  // Reload: url + username + source persist; the bearer is NOT returned
  // (write-only) — the field is empty with a "leave blank to keep" placeholder.
  await page.reload();
  await page.getByTestId('channel-019-config').waitFor();
  await expect(page.getByTestId('channel-019-status')).toHaveText('configured', { timeout: 15_000 });
  await expect(page.getByTestId('channel-019-url')).toHaveValue('https://019sms.co.il/api');
  await expect(page.getByTestId('channel-019-username')).toHaveValue('acme');
  await expect(page.getByTestId('channel-019-source')).toHaveValue('MyBrand');
  await expect(page.getByTestId('channel-019-country')).toHaveValue('IL'); // default country persisted
  await expect(page.getByTestId('channel-019-secret')).toHaveValue('');

  // Remove → back to unconfigured (resets state so SMS sends use the mock).
  await page.getByTestId('channel-019-remove').click();
  await expect(page.getByTestId('channel-019-status')).toHaveText('not configured', { timeout: 15_000 });
});
