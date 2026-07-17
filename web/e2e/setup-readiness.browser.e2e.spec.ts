// E2E (real Chromium): the Setup / configuration-readiness screen + the global alert.
// The seeded Acme workspace (WS_A) is fully configured (email provider + verified domain
// + sender, SMS + WhatsApp connectors) → every channel READY, no banner. Its sibling
// workspace (WS_A2) shares the company connectors but has NO verified sending domain →
// email is INCOMPLETE → the channel is disabled, a red nav badge + a global banner appear.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A, WS_A2 } from './seed.js';

test('a fully-configured workspace shows every channel Ready and no alert', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  // Deterministically land on the fully-configured workspace.
  await page.getByTestId('workspace-select').selectOption(WS_A);

  await page.getByTestId('nav-setup').click();
  await page.getByTestId('setup-screen').waitFor();

  await expect(page.getByTestId('readiness-status-email')).toContainText('Ready');
  await expect(page.getByTestId('readiness-status-sms')).toContainText('Ready');
  await expect(page.getByTestId('readiness-status-whatsapp')).toContainText('Ready');
  // Image storage (R2) is optional — a warning, never an error.
  await expect(page.getByTestId('readiness-status-storage')).toContainText('Optional');

  // No error → no global banner and no nav badge.
  await expect(page.getByTestId('setup-banner')).toHaveCount(0);
  await expect(page.getByTestId('nav-setup-badge')).toHaveCount(0);
});

test('a workspace missing a verified domain disables email and raises an alert', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  // Switch to the sibling workspace (shares the company connectors, but has no domain).
  await page.getByTestId('workspace-select').selectOption(WS_A2);

  // A global banner appears on a non-Setup screen + the nav badge shows the error count.
  await expect(page.getByTestId('setup-banner')).toBeVisible();
  await expect(page.getByTestId('nav-setup-badge')).toHaveText('1');

  // Review → the Setup screen shows email incomplete with a fix link; text channels stay ready.
  await page.getByTestId('setup-banner-review').click();
  await page.getByTestId('setup-screen').waitFor();
  await expect(page.getByTestId('readiness-status-email')).toContainText('Incomplete');
  await expect(page.getByTestId('readiness-fix-email').first()).toBeVisible();
  await expect(page.getByTestId('readiness-status-sms')).toContainText('Ready');

  // The banner is not shown ON the Setup screen itself (no redundant nag).
  await expect(page.getByTestId('setup-banner')).toHaveCount(0);
});
