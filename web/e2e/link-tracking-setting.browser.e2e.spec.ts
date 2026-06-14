// E2E (real Chromium): the workspace-level "Link tracking" toggle (§10) persists.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('toggle link tracking on/off in Workspace settings (persists)', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('workspace-settings').waitFor();

  const toggle = page.getByTestId('toggle-link-tracking');
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); // default OFF
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Persists across a reload.
  await page.reload();
  await page.getByTestId('workspace-settings').waitFor();
  await expect(page.getByTestId('toggle-link-tracking')).toHaveAttribute('aria-checked', 'true');

  // Turn it back off so it doesn't affect other tests / the dev workspace.
  await page.getByTestId('toggle-link-tracking').click();
  await expect(page.getByTestId('toggle-link-tracking')).toHaveAttribute('aria-checked', 'false');
});
