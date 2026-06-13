// E2E (real Chromium): sending domains, each with its OWN senders (§10). An owner
// opens Domain onboarding, adds a domain (pending — no sender form yet), verifies
// it, then adds/removes senders inline UNDER that domain. Uses a local-part input
// that's always at the domain. Styled confirm for removal (no native dialog).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('senders live under a specific (verified) domain', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-onboarding').click();
  await page.getByTestId('onboarding-wizard').waitFor();
  await page.getByTestId('sending-domains').waitFor();

  // Add a sending domain — starts PENDING; no sender form while unverified.
  await page.getByTestId('domain-add-input').fill('mail.acme.com');
  await page.getByTestId('add-domain').click();
  const row = page.getByTestId('domain-row').filter({ hasText: 'mail.acme.com' });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('domain-status')).toHaveText('pending');
  await expect(row.getByTestId('add-sender')).toHaveCount(0);
  await expect(row).toContainText('Verify this domain to add senders');

  // Verify → badge flips and the per-domain sender form appears.
  await row.getByTestId('domain-verify').click();
  await expect(row.getByTestId('domain-status')).toHaveText('verified');
  await expect(row.getByTestId('add-sender')).toBeVisible();

  // Add two senders UNDER this domain (local part only; domain is fixed).
  await row.getByTestId('sender-name-input').fill('Support');
  await row.getByTestId('sender-local-input').fill('support');
  await row.getByTestId('add-sender').click();
  await expect(row.getByTestId('sender-row')).toHaveCount(1);
  await expect(row.getByTestId('sender-row')).toContainText('support@mail.acme.com');

  await row.getByTestId('sender-name-input').fill('Sales');
  await row.getByTestId('sender-local-input').fill('sales');
  await row.getByTestId('add-sender').click();
  await expect(row.getByTestId('sender-row')).toHaveCount(2);

  // Remove one via the styled confirm.
  await row.getByTestId('sender-row').filter({ hasText: 'Support' }).getByTestId('sender-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(row.getByTestId('sender-row')).toHaveCount(1);
  await expect(row.getByTestId('sender-row')).toContainText('sales@mail.acme.com');

  // Persists across a reload, still under its domain.
  await page.reload();
  await page.getByTestId('sending-domains').waitFor();
  const row2 = page.getByTestId('domain-row').filter({ hasText: 'mail.acme.com' });
  await expect(row2.getByTestId('sender-row')).toHaveCount(1);
  await expect(row2.getByTestId('sender-row')).toContainText('sales@mail.acme.com');
});
