// E2E (real Chromium): company-centric RBAC user management. The Acme owner opens
// Company settings → Users, sees the company's users (owner + marketer), and edits
// the marketer's per-workspace grant. Also a smoke test that the app boots under the
// company-centric auth model (owner resolves to all their company's workspaces).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A2 } from './seed.js';

test('company users: owner manages company users + marketer workspace grants', async ({ page }) => {
  await loginAs(page, DEV_OWNER);

  // The owner sees BOTH Acme workspaces in the picker (company-centric: owner → all).
  await page.getByTestId('nav-company').click();
  await page.getByTestId('company-settings').waitFor();

  // Users tab.
  await page.getByTestId('company-tab-users').click();
  await page.getByTestId('company-users-screen').waitFor();

  // The seed folds workspace_users → company_users: an owner + a marketer in Acme.
  const rows = page.getByTestId('company-user-row');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('company-user-role-badge').filter({ hasText: 'Owner' })).toHaveCount(1);
  await expect(page.getByTestId('company-user-role-badge').filter({ hasText: 'Marketer' })).toHaveCount(1);

  // The marketer is granted WS_A (seed), not WS_A2. Grant WS_A2 and confirm it sticks.
  const wsA2Grant = page.locator(`[data-testid="company-user-grant"][data-ws="${WS_A2}"]`);
  await expect(wsA2Grant).not.toBeChecked();
  await wsA2Grant.check();
  // toggleGrant PATCHes then reloads the list; the checkbox reflects the server state.
  await expect(page.locator(`[data-testid="company-user-grant"][data-ws="${WS_A2}"]`)).toBeChecked();
});
