import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_ADMIN } from './seed.js';

// §3A: a platform admin has no workspace membership, but picks a COMPANY from a
// searchable selector, then a WORKSPACE within it — and then sees exactly what
// that workspace's admin sees (the system-admin role carries every workspace
// capability). "Acme" owns two workspaces, exercising the two-level picker.
test('super admin picks a company then a workspace, and sees its profiles', async ({ page }) => {
  await loginAs(page, DEV_ADMIN);

  // The platform-admin company picker is in the sidebar.
  await page.getByTestId('company-picker').waitFor();
  await page.getByTestId('company-current').click();
  await page.getByTestId('company-search').fill('Acme');
  await page.locator('[data-testid="company-option"]').first().click();

  // Acme has two workspaces — the workspace sub-selector lists them; pick one.
  await page.getByTestId('admin-workspace-select').selectOption({ label: 'Acme (A)' });

  // Now scoped into that workspace — its profiles are visible (company-admin view).
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(1);

  // The picker reflects the company being viewed.
  await expect(page.getByTestId('company-current')).toContainText('Acme');
});
