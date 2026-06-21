// E2E (real Chromium): MULTI-CHANNEL broadcasts. An SMS (and a WhatsApp) broadcast
// is composed via the wizard — picking the channel switches the Content step from
// the email-design flow to a plain-text message body — and "Send now" sends it
// for real through the local mock channel provider (no SES creds, no verified
// domain needed; unlike email, the text channels always deliver locally). The list
// shows the channel Badge. Email's own flow is asserted unaffected by the existing
// broadcast spec. Proven in a real browser against real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('compose + send an SMS broadcast via the wizard (mock provider, no domain needed)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Step 1 — audience + CHANNEL. Pick SMS (default is Email) and the seeded manual
  // segment (index 1; its member a1 has a phone so the send has a recipient).
  await page.getByTestId('broadcast-name').fill('SMS blast');
  await page.getByTestId('broadcast-medium').selectOption('sms');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // Step 2 — Content for a text channel is a plain-text body (NO template picker,
  // NO email-design flow). The step is gated until the body is non-blank.
  await expect(page.getByTestId('broadcast-text-body')).toBeVisible();
  await expect(page.getByTestId('broadcast-template')).toHaveCount(0); // no email picker for SMS
  await expect(page.getByTestId('text-body-incomplete')).toBeVisible();
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
  await page.getByTestId('broadcast-text-body').fill('Hi {{customer.first_name}}, flash sale today!');
  await expect(page.getByTestId('text-body-complete')).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // Step 3 — review shows the channel + message; "Send now" sends immediately.
  await expect(page.getByTestId('review-medium')).toHaveText('SMS');
  await expect(page.getByTestId('review-text-body')).toContainText('flash sale today');
  await expect(page.getByTestId('wizard-save')).toHaveText('Send now');
  await page.getByTestId('wizard-save').click();

  // Back on the list: a success toast; the SMS broadcast is SENT (mock provider),
  // and the row shows the SMS channel badge.
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('toast')).toBeVisible();
  const item = page.getByTestId('broadcast-item').filter({ hasText: 'SMS blast' });
  await expect(item.getByTestId('broadcast-status')).toHaveText('sent');
  await expect(item.getByTestId('broadcast-medium-badge')).toHaveText('SMS');
});

test('compose + send a WhatsApp broadcast (text body, channel badge)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('WA blast');
  await page.getByTestId('broadcast-medium').selectOption('whatsapp');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  await page.getByTestId('broadcast-text-body').fill('Your order shipped, {{customer.first_name}}.');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('review-medium')).toHaveText('WhatsApp');
  await page.getByTestId('wizard-save').click();

  await page.getByTestId('broadcast-composer').waitFor();
  const item = page.getByTestId('broadcast-item').filter({ hasText: 'WA blast' });
  await expect(item.getByTestId('broadcast-status')).toHaveText('sent');
  await expect(item.getByTestId('broadcast-medium-badge')).toHaveText('WhatsApp');
});
