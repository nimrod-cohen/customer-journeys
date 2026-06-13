// E2E (real Chromium): manage the named senders for a sending domain (§10). An
// owner opens Domain onboarding, adds two senders, sees them grouped by domain,
// then removes one via the styled confirm (no native dialog).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('add and remove domain senders (grouped by domain, styled confirm)', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-onboarding').click();
  await page.getByTestId('onboarding-wizard').waitFor();
  await page.getByTestId('domain-senders').waitFor();

  // Add two senders at the same domain.
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
