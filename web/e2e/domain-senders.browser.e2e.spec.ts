// E2E (real Chromium): sending domains as a LIST → per-domain SETUP screen (§10).
// The list screen only lists domains + "Add domain". Adding opens the setup
// screen where you save the domain (pending), verify it via a DNS check, and —
// only once verified — manage its senders. Styled confirm for removal.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER } from './seed.js';

test('domains list → setup screen: save, verify via DNS, then manage senders', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-onboarding').click();
  await page.getByTestId('sending-domains').waitFor();

  // The list is empty; nothing but the list + Add domain lives here (no wizard).
  await expect(page.getByTestId('dns-section')).toHaveCount(0);
  await expect(page.getByTestId('senders-section')).toHaveCount(0);

  // Add domain → the setup screen; save the domain (pending) → continues on it.
  await page.getByTestId('add-domain').click();
  await page.getByTestId('domain-detail').waitFor();
  await page.getByTestId('domain-name-input').fill('mail.acme.com');
  await page.getByTestId('save-domain').click();

  // Now on the saved domain's setup: pending, DNS records shown, senders locked.
  await expect(page.getByTestId('domain-status')).toHaveText('pending');
  await expect(page.getByTestId('dns-record').first()).toBeVisible();
  await expect(page.getByTestId('senders-locked')).toBeVisible();
  await expect(page.getByTestId('add-sender')).toHaveCount(0);

  // Verify is ONLY via the DNS check (the system finds the records).
  await page.getByTestId('check-dns').click();
  await expect(page.getByTestId('domain-status')).toHaveText('verified');
  await expect(page.getByTestId('add-sender')).toBeVisible();

  // Add a sender (local part only — fixed to this domain) and remove it.
  await page.getByTestId('sender-name-input').fill('Support');
  await page.getByTestId('sender-local-input').fill('support');
  await page.getByTestId('add-sender').click();
  await expect(page.getByTestId('sender-row')).toHaveCount(1);
  await expect(page.getByTestId('sender-row')).toContainText('support@mail.acme.com');

  // Back to the list → the domain shows as verified there.
  await page.getByTestId('domain-back').click();
  await page.getByTestId('domain-list').waitFor();
  const row = page.getByTestId('domain-row').filter({ hasText: 'mail.acme.com' });
  await expect(row.getByTestId('domain-status')).toHaveText('verified');

  // Re-open → the sender persisted under the domain.
  await row.click();
  await page.getByTestId('domain-detail').waitFor();
  await expect(page.getByTestId('sender-row')).toHaveCount(1);
  await expect(page.getByTestId('sender-row')).toContainText('support@mail.acme.com');

  // Remove the sender via the styled confirm.
  await page.getByTestId('sender-delete').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('sender-row')).toHaveCount(0);
});
