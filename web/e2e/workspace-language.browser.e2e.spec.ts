// E2E (real Chromium): the Front-facing language setting in Workspace settings.
// An owner picks the public-page language ('auto'|'en'|'he'); the Select persists
// (the kit Button auto-locks while the PUT is in flight). Hebrew renders RTL on
// the public pages (covered by the integration tier); here we assert the picker
// persists across a reload.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('the Workspace-settings front-facing language Select persists', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-tab-workspace').click();

  const select = page.getByTestId('workspace-language-select');
  await select.waitFor();

  // Change to Hebrew and let the optimistic PUT settle.
  await select.selectOption('he');
  await expect(select).toHaveValue('he');
  // Give the autosave PUT a beat (the onChange fires it).
  await page.waitForTimeout(300);

  // Reload the screen → the persisted value comes back as Hebrew.
  await page.reload();
  await page.getByTestId('settings-tab-workspace').click();
  await expect(page.getByTestId('workspace-language-select')).toHaveValue('he');

  // Switch back to auto via the explicit Save button (clears for other tests).
  await page.getByTestId('workspace-language-select').selectOption('auto');
  await page.getByTestId('workspace-language-save').click();
  await page.waitForTimeout(300);
  await page.reload();
  await page.getByTestId('settings-tab-workspace').click();
  await expect(page.getByTestId('workspace-language-select')).toHaveValue('auto');
});
