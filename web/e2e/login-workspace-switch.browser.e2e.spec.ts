// E2E (real Chromium): login + workspace switching re-scopes the app with NO
// cross-bleed (§12, §18 "Multi-workspace switching"). A user belongs to ONE
// company (Acme) that owns TWO workspaces (WS_A + WS_A2); the user switches
// between them and we prove against the real API + Postgres that:
//   - on WS_A the list shows WS_A's segment ("Manual VIPs") and NOT WS_A2's,
//   - after switching to WS_A2 the active value flips AND the list flips: WS_A's
//     segment is GONE from the DOM and WS_A2's ("Acme West Club") appears.
// This asserts the actual DATA re-scopes in the browser, not just the selector.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A, WS_A2, SEG_A_NAME, SEG_A2_NAME } from './seed.js';

test('login then switch workspace re-scopes the app with no cross-bleed', async ({ page }) => {
  await loginAs(page, DEV_OWNER);

  // The app version is shown (small text) in the sidebar footer.
  await expect(page.getByTestId('app-version')).toContainText(/v\d+\.\d+\.\d+/);

  // Active workspace is one of the memberships; navigate to segments (the list).
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();

  // The switcher lists both of the company's workspaces.
  const select = page.getByTestId('workspace-select');
  await expect(select).toBeVisible();

  // The list of existing segments — the surface we use to prove re-scoping.
  const list = page.getByTestId('segment-list');
  const aItem = list.getByText(SEG_A_NAME, { exact: true });
  const a2Item = list.getByText(SEG_A2_NAME, { exact: true });

  // --- On WS_A: WS_A's segment is present, WS_A2's is absent. ---
  await select.selectOption(WS_A);
  await expect(select).toHaveValue(WS_A);
  await expect(aItem).toBeVisible();
  await expect(a2Item).toHaveCount(0);

  // --- Switch to WS_A2: the active value flips. ---
  await select.selectOption(WS_A2);
  await expect(select).toHaveValue(WS_A2);
  await expect(select).not.toHaveValue(WS_A);

  // CRITICAL: the DATA re-scoped too — WS_A's segment is GONE and WS_A2's shows.
  await expect(a2Item).toBeVisible();
  await expect(aItem).toHaveCount(0);
});

test('profile column choices are per-workspace — switching companies does not bleed them', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  const select = page.getByTestId('workspace-select');

  // --- On WS_A: add the `tier` attribute as a profile column. ---
  await select.selectOption(WS_A);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('columns-button').click();
  await page.getByTestId('columns-menu').waitFor();
  await page.locator('[data-testid="col-option"][data-col="tier"] input[type="checkbox"]').check();
  await expect(page.getByTestId('attr-col-header')).toHaveCount(1);
  await page.getByTestId('profile-search').click(); // close picker

  // --- Switch to WS_A2 (a different workspace, no `tier` attribute): the column
  // is NOT inherited — only the default columns show. (Before per-workspace
  // keying, the shared key + self-heal would have pruned `tier` here and lost it
  // in WS_A too.) ---
  await select.selectOption(WS_A2);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await expect(page.getByTestId('attr-col-header')).toHaveCount(0);

  // --- Switch back to WS_A: the `tier` column choice is still there. ---
  await select.selectOption(WS_A);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await expect(page.getByTestId('attr-col-header')).toHaveCount(1);
  await expect(page.getByTestId('attr-col-header').first()).toHaveText('tier');
});

test('the login screen offers company-owner registration (toggle shows the fields)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('login-form').waitFor();

  // Sign-in mode: dev credentials box is shown, no registration fields.
  await expect(page.getByTestId('register-company')).toHaveCount(0);

  // Switch to "Create a company account" → company + name fields appear.
  await page.getByTestId('show-register').click();
  await expect(page.getByTestId('register-company')).toBeVisible();
  await expect(page.getByTestId('register-name')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toHaveText('Create account');

  // Back to sign-in.
  await page.getByTestId('show-signin').click();
  await expect(page.getByTestId('register-company')).toHaveCount(0);
  await expect(page.getByTestId('login-submit')).toHaveText('Sign in');
});

test('registering a company does NOT create a workspace — the owner must create their first one', async ({ page }) => {
  // A fresh email per run keeps the (throwaway) e2e DB from colliding on re-runs.
  const email = `newowner-${Date.now()}@example.com`;
  await page.goto('/');
  await page.getByTestId('login-form').waitFor();

  // Register a brand-new company owner.
  await page.getByTestId('show-register').click();
  await page.getByTestId('register-company').fill('Newco Inc.');
  await page.getByTestId('register-name').fill('New Owner');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill('pw12345678');
  await page.getByTestId('login-submit').click();

  // Registration created the company only → land on "create your first workspace",
  // NOT the main app shell. The company name is shown; the field defaults to it.
  await page.getByTestId('create-first-workspace').waitFor();
  await expect(page.getByText('Newco Inc.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('first-workspace-name')).toHaveValue('Newco Inc.');
  await expect(page.getByTestId('nav-segments')).toHaveCount(0); // no app shell yet

  // Create the first workspace → the owner enters the main app shell.
  await page.getByTestId('first-workspace-name').fill('Newco – Main');
  await page.getByTestId('create-first-workspace-submit').click();

  await page.getByTestId('workspace-switcher').waitFor();
  await expect(page.getByTestId('create-first-workspace')).toHaveCount(0);
  await expect(page.getByTestId('nav-segments')).toBeVisible();
  // The newly-created workspace is the active one in the switcher.
  await expect(page.getByTestId('workspace-select')).toContainText('Newco – Main');
});
