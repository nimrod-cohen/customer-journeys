import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_ADMIN } from './seed.js';

// §3A: a platform admin (system-admin) has no workspace membership, but can pick
// ANY company from a searchable selector and then see exactly what that company's
// admin sees (the system-admin role carries every workspace capability).
test('super admin picks a company from the searchable selector and sees its profiles', async ({ page }) => {
  await loginAs(page, DEV_ADMIN);

  // The platform-admin company picker is in the sidebar (not the membership switcher).
  await page.getByTestId('company-picker').waitFor();
  // Before a company is picked there's no workspace switcher yet.
  await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
  await page.getByTestId('company-current').click();
  await page.getByTestId('company-search').fill('Acme');
  await page.locator('[data-testid="company-option"]').first().click();

  // The standard workspace switcher now follows, naming the active company.
  await expect(page.getByTestId('workspace-switcher')).toBeVisible();
  await expect(page.getByTestId('workspace-select')).toContainText('Acme');

  // Now scoped into Acme — its profiles are visible (a company-admin view).
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(1);

  // The picker reflects the company now being viewed.
  await expect(page.getByTestId('company-current')).toContainText('Acme');
});
