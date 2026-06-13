// E2E (real Chromium): manage sending domains + their named senders (§10). An
// owner opens Domain onboarding, adds a sending domain (initially pending), can't
// add a sender until it's verified, then verifies it, adds two senders grouped by
// domain, and removes one via the styled confirm (no native dialog).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('sending domains list: add → verify gates senders; add & remove senders', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-onboarding').click();
  await page.getByTestId('onboarding-wizard').waitFor();
  await page.getByTestId('sending-domains').waitFor();
  await page.getByTestId('domain-senders').waitFor();

  // Add a sending domain — it starts PENDING (unverified).
  await page.getByTestId('domain-add-input').fill('mail.acme.com');
  await page.getByTestId('add-domain').click();
  await expect(page.getByTestId('domain-row')).toHaveCount(1);
  await expect(page.getByTestId('domain-status')).toHaveText('pending');

  // A sender can't be added while the domain is unverified.
  await page.getByTestId('sender-name-input').fill('Support');
  await page.getByTestId('sender-email-input').fill('support@mail.acme.com');
  await page.getByTestId('add-sender').click();
  await expect(page.getByTestId('senders-error')).toBeVisible();
  await expect(page.getByTestId('sender-row')).toHaveCount(0);

  // Verify the domain → badge flips, Verify button gone.
  await page.getByTestId('domain-verify').click();
  await expect(page.getByTestId('domain-status')).toHaveText('verified');

  // Now the two senders at that domain are accepted.
  await page.getByTestId('sender-name-input').fill('Support');
  await page.getByTestId('sender-email-input').fill('support@mail.acme.com');
  await page.getByTestId('add-sender').click();
  await expect(page.getByTestId('sender-row')).toHaveCount(1);

  await page.getByTestId('sender-name-input').fill('Sales');
  await page.getByTestId('sender-email-input').fill('sales@mail.acme.com');
  await page.getByTestId('add-sender').click();
  await expect(page.getByTestId('sender-row')).toHaveCount(2);

  // Both group under the single derived domain.
  await expect(page.getByTestId('sender-domain-group')).toHaveCount(1);
  await expect(page.getByTestId('sender-domain-group')).toContainText('mail.acme.com');
  await expect(page.getByTestId('sender-row').filter({ hasText: 'support@mail.acme.com' })).toHaveCount(1);

  // A malformed email is rejected with an inline error (no row added).
  await page.getByTestId('sender-name-input').fill('Bad');
  await page.getByTestId('sender-email-input').fill('not-an-email');
  await page.getByTestId('add-sender').click();
  await expect(page.getByTestId('senders-error')).toBeVisible();
  await expect(page.getByTestId('sender-row')).toHaveCount(2);

  // Remove one via the styled confirm.
  await page.getByTestId('sender-row').filter({ hasText: 'Support' }).getByTestId('sender-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('sender-row')).toHaveCount(1);
  await expect(page.getByTestId('sender-row').filter({ hasText: 'Sales' })).toHaveCount(1);

  // Persists across a reload (saved server-side).
  await page.reload();
  await page.getByTestId('domain-senders').waitFor();
  await expect(page.getByTestId('sender-row')).toHaveCount(1);
  await expect(page.getByTestId('sender-row')).toContainText('sales@mail.acme.com');
});
