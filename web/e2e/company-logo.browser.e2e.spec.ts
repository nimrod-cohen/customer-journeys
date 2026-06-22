// E2E (real Chromium): a company uploads a LOGO in Company settings, it shows,
// then it's removed (so it doesn't leak into other tests' public pages). The
// logo renders atop the public unsubscribe + manage-subscription pages; that is
// covered by the integration tier — here we exercise the admin UI flow.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

// A tiny valid 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('company logo: upload shows the image, then remove clears it', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-company').click();
  await page.getByTestId('company-settings').waitFor();
  await page.getByTestId('company-logo').waitFor();

  // Starts with no logo.
  await expect(page.getByTestId('company-logo-img')).toHaveCount(0);

  // Pick a file → POST /assets then PUT /company/logo; the <img> appears.
  await page.getByTestId('company-logo-file').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  });
  await expect(page.getByTestId('company-logo-img')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('company-logo-img')).toHaveAttribute('src', /\/assets\//);

  // Persists across a reload.
  await page.reload();
  await page.getByTestId('company-logo').waitFor();
  await expect(page.getByTestId('company-logo-img')).toBeVisible({ timeout: 15_000 });

  // Remove → the image is gone (resets state for other specs).
  await page.getByTestId('company-logo-remove').click();
  await expect(page.getByTestId('company-logo-img')).toHaveCount(0, { timeout: 15_000 });
});
