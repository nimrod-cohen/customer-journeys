// E2E (real Chromium): phone as a core identity field. Create a PHONE-ONLY profile via the
// drawer (no email), see it identified by phone, edit its phone, and set the workspace
// default phone country. Uses full +E.164 numbers so no workspace default country is needed.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A2 } from './seed.js';

test('create a phone-only profile, then edit its phone', async ({ page }) => {
  const phone = `+97254${Date.now().toString().slice(-7)}`;
  await loginAs(page, DEV_OWNER);
  // Do this in the sibling workspace so the created profile never pollutes WS_A's
  // exact profile-count assertions in other (parallel) specs.
  await page.getByTestId('workspace-select').selectOption(WS_A2);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();

  // New profile with ONLY a phone (email left blank).
  await page.getByTestId('new-profile').click();
  await page.getByTestId('new-profile-drawer').waitFor();
  await page.getByTestId('new-profile-phone').fill(phone);
  await expect(page.getByTestId('create-profile')).toBeEnabled(); // phone alone satisfies "at least one"
  await page.getByTestId('create-profile').click();
  await expect(page.getByTestId('new-profile-drawer')).toHaveCount(0);

  // Find it by phone and open it — the header shows the phone (no email).
  await page.getByTestId('profile-search').fill(phone);
  await expect(page.getByTestId('profile-row').first()).toContainText(phone);
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();
  await expect(page.getByTestId('profile-email')).toContainText(phone);

  // Edit the phone on the Details tab.
  const phone2 = `+97253${Date.now().toString().slice(-7)}`;
  await expect(page.getByTestId('profile-phone-input')).toHaveValue(phone);
  await page.getByTestId('profile-phone-input').fill(phone2);
  await page.getByTestId('profile-save').click();
  await expect(page.getByTestId('profile-email')).toContainText(phone2);
});

test('workspace default phone country persists', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.goto('/#/settings');
  await page.getByTestId('workspace-phone-country').waitFor();
  await page.getByTestId('workspace-phone-country').fill('IL');
  // Ensure the controlled input + its save-handler closure have re-rendered with 'IL'
  // before clicking Save (otherwise the handler can capture the stale empty value).
  await expect(page.getByTestId('workspace-phone-country')).toHaveValue('IL');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/workspace/settings') && r.request().method() === 'PUT' && r.ok(),
  );
  await page.getByTestId('workspace-phone-country-save').click();
  await saved;
  // Navigate away and back (same session/workspace) so the screen re-fetches from the server.
  await page.getByTestId('nav-dashboards').click();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('workspace-phone-country')).toHaveValue('IL');
});
