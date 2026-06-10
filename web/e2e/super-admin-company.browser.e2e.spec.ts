import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_ADMIN, DEV_OWNER, WS_B } from './seed.js';

test('an owner adds a workspace to their company from Company settings', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-company').click();
  await page.getByTestId('company-settings').waitFor();

  // Rename the company, then rename it back (keeps shared seed data stable).
  await expect(page.getByTestId('company-name')).toContainText('Acme');
  await page.getByTestId('rename-company').click();
  await page.getByTestId('company-name-input').fill('Acme Inc');
  await page.getByTestId('company-rename-save').click();
  await expect(page.getByTestId('company-name')).toHaveText('Acme Inc');
  await page.getByTestId('rename-company').click();
  await page.getByTestId('company-name-input').fill('Acme');
  await page.getByTestId('company-rename-save').click();
  await expect(page.getByTestId('company-name')).toHaveText('Acme');

  // Owner starts in Acme, which already owns two workspaces (they're owner of both).
  const rows = page.getByTestId('ws-row');
  await expect(rows).toHaveCount(2);

  // Add a third workspace to the company.
  await page.getByTestId('new-workspace-name').fill('Acme – North');
  await page.getByTestId('create-workspace').click();
  await expect(page.getByTestId('ws-row')).toHaveCount(3);
  await expect(page.getByTestId('company-workspaces')).toContainText('Acme – North');

  // It's now selectable in the sidebar workspace switcher too.
  await expect(page.getByTestId('workspace-select')).toContainText('Acme – North');

  // The owner can RENAME that workspace inline.
  const northRow = page.getByTestId('ws-row').filter({ hasText: 'Acme – North' });
  await northRow.getByTestId('rename-workspace').click();
  await page.getByTestId('rename-input').fill('Acme – Northwest');
  await page.getByTestId('rename-save').click();
  await expect(page.getByTestId('company-workspaces')).toContainText('Acme – Northwest');

  // …and delete it (type-the-name confirm uses the NEW name); gone after.
  const nwRow = page.getByTestId('ws-row').filter({ hasText: 'Acme – Northwest' });
  await nwRow.getByTestId('delete-workspace').click();
  await page.getByTestId('delete-workspace-modal').waitFor();
  const confirmBtn = page.getByTestId('confirm-delete-workspace');
  await expect(confirmBtn).toBeDisabled();
  await page.getByTestId('delete-confirm-input').fill('Acme – Northwest');
  await confirmBtn.click();
  await expect(page.getByTestId('ws-row')).toHaveCount(2);
  await expect(page.getByTestId('company-workspaces')).not.toContainText('Acme – North');
});

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

test('deleting a workspace requires typing its exact name (admin only)', async ({ page }) => {
  await loginAs(page, DEV_ADMIN);
  await page.getByTestId('nav-admin').click();
  await page.getByTestId('system-admin-console').waitFor();

  // Open the delete confirm for Beta (B).
  await page.locator(`[data-testid="delete-workspace"][data-ws="${WS_B}"]`).click();
  await page.getByTestId('delete-workspace-modal').waitFor();

  // The confirm button is disabled until the exact name is typed.
  const confirmBtn = page.getByTestId('confirm-delete-workspace');
  await expect(confirmBtn).toBeDisabled();
  await page.getByTestId('delete-confirm-input').fill('wrong name');
  await expect(confirmBtn).toBeDisabled();
  await page.getByTestId('delete-confirm-input').fill('Beta (B)');
  await expect(confirmBtn).toBeEnabled();

  // Cancel — the workspace is still there (non-destructive check).
  await page.getByText('Cancel', { exact: true }).click();
  await expect(page.getByTestId('delete-workspace-modal')).toHaveCount(0);
  await expect(page.getByTestId('admin-company-name').filter({ hasText: /^Beta$/ })).toHaveCount(1);
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
