// E2E (real Chromium): configuration-readiness surfacing. There is NO dedicated "Setup"
// nav item and NO global banner. Instead, a small count badge sits on the Company settings
// nav item (connector/provider gaps) and the Workspace settings nav item (sending-domain
// gaps); clicking a badge opens the Setup summary page. The seeded Acme WS_A is fully
// configured (no badges); its sibling WS_A2 shares the company connectors but has no
// verified sending domain → a WORKSPACE-settings badge appears.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A, WS_A2 } from './seed.js';

test('a fully-configured workspace shows no setup badges and no banner/nav item', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('workspace-select').selectOption(WS_A);
  await page.getByTestId('app-nav').waitFor();

  // No dedicated Setup nav item, no global banner.
  await expect(page.getByTestId('nav-setup')).toHaveCount(0);
  await expect(page.getByTestId('setup-banner')).toHaveCount(0);
  // No badges — everything is set up.
  await expect(page.getByTestId('nav-setup-badge-company')).toHaveCount(0);
  await expect(page.getByTestId('nav-setup-badge-settings')).toHaveCount(0);
});

test('a workspace missing a verified domain shows a WORKSPACE-settings badge → Setup page', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('workspace-select').selectOption(WS_A2);

  // The company connectors are all present (shared) → no company badge; the missing
  // sending domain is workspace-level → a badge on Workspace settings.
  const wsBadge = page.getByTestId('nav-setup-badge-settings');
  await expect(wsBadge).toBeVisible();
  await expect(page.getByTestId('nav-setup-badge-company')).toHaveCount(0);

  // Clicking the badge opens the Setup summary page; email is incomplete there.
  await wsBadge.click();
  await page.getByTestId('setup-screen').waitFor();
  await expect(page.getByTestId('readiness-status-email')).toContainText('Incomplete');
  await expect(page.getByTestId('readiness-status-sms')).toContainText('Ready');
});
