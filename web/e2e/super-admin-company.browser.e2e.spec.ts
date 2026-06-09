import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_ADMIN, WS_B } from './seed.js';

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

test('switching company re-scopes the main content (no stale data)', async ({ page }) => {
  await loginAs(page, DEV_ADMIN);

  // Enter Acme → Acme (A) and confirm its profile shows.
  await page.getByTestId('company-current').click();
  await page.getByTestId('company-search').fill('Acme');
  await page.locator('[data-testid="company-option"]').first().click();
  await page.getByTestId('admin-workspace-select').selectOption({ label: 'Acme (A)' });
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(1);

  // Switch to Beta (one workspace → enters directly); the Profiles screen must
  // re-scope: Beta's profile appears and Acme's is gone.
  await page.getByTestId('company-current').click();
  await page.getByTestId('company-search').fill('Beta');
  await page.locator('[data-testid="company-option"]').first().click();
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('b1@beta.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(1);
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await expect(page.getByTestId('profile-row')).toHaveCount(0);
});

test('super admin creates a company and moves a workspace into it', async ({ page }) => {
  await loginAs(page, DEV_ADMIN);
  await page.getByTestId('nav-admin').click();
  await page.getByTestId('system-admin-console').waitFor();

  // Seeded companies are listed.
  await expect(page.getByTestId('admin-company-name').filter({ hasText: /^Acme$/ })).toHaveCount(1);

  // Create a new company.
  await page.getByTestId('company-name').fill('Globex');
  await page.getByTestId('create-company').click();
  await expect(page.getByTestId('admin-company-name').filter({ hasText: /^Globex$/ })).toHaveCount(1);

  // Move "Beta (B)" into Globex.
  await page.locator(`[data-testid="assign-company-select"][data-ws="${WS_B}"]`).selectOption({ label: 'Globex' });

  // The Globex company card now contains that workspace.
  const globexCard = page
    .locator('[data-testid="admin-company"]')
    .filter({ has: page.getByTestId('admin-company-name').filter({ hasText: /^Globex$/ }) });
  await expect(globexCard.getByText('Beta (B)')).toBeVisible();
});
