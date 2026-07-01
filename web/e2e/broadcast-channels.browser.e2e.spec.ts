// E2E (real Chromium): MULTI-CHANNEL broadcasts. An SMS (and a WhatsApp) broadcast
// is composed via the wizard — picking the channel switches the Content step from
// the email-design flow to a plain-text message body — and "Send now" sends it
// for real through the local mock channel provider (no SES creds, no verified
// domain needed; unlike email, the text channels always deliver locally). The list
// shows the channel Badge. Email's own flow is asserted unaffected by the existing
// broadcast spec. Proven in a real browser against real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs, pickAudienceSegment } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('compose + send an SMS broadcast via the wizard (mock provider, no domain needed)', async ({ page }) => {
  // Unique per run so retries / prior runs can't leave duplicate rows that break a
  // hasText filter (the list isn't cleared between runs for test-created broadcasts).
  const name = `SMS blast ${Date.now()}`;
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  // Step 1 — audience + CHANNEL. Pick SMS (default is Email) and the seeded manual
  // segment (index 1; its member a1 has a phone so the send has a recipient).
  await page.getByTestId('broadcast-name').fill(name);
  await page.getByTestId('broadcast-medium').selectOption('sms');
  await pickAudienceSegment(page);
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
  const item = page.getByTestId('broadcast-item').filter({ hasText: name });
  await expect(item.getByTestId('broadcast-status')).toHaveText('sent', { timeout: 15_000 });
  await expect(item.getByTestId('broadcast-medium-badge')).toHaveText('SMS');

  // Opening the SENT SMS broadcast shows a read-only preview of the TEXT message
  // (channel + recipient phone token + body) — NOT a supposed email.
  await item.getByTestId('broadcast-open').click();
  await page.getByTestId('broadcast-preview').waitFor();
  await expect(page.getByTestId('preview-medium')).toHaveText('SMS');
  await expect(page.getByTestId('preview-text-body')).toContainText('flash sale today');
  await expect(page.getByTestId('preview-body')).toHaveCount(0); // no email iframe
  await expect(page.getByTestId('preview-subject')).toHaveCount(0);
});

test('compose + send a WhatsApp broadcast (free-form text mode, channel badge)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  const name = `WA blast ${Date.now()}`;
  await page.getByTestId('broadcast-name').fill(name);
  await page.getByTestId('broadcast-medium').selectOption('whatsapp');
  await pickAudienceSegment(page);
  await page.getByTestId('wizard-next').click();

  // WhatsApp defaults to TEMPLATE mode; switch to free-form text for a plain body send.
  await page.getByTestId('whatsapp-message-type').selectOption('text');
  await page.getByTestId('broadcast-text-body').fill('Your order shipped, {{customer.first_name}}.');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('review-medium')).toHaveText('WhatsApp');
  await page.getByTestId('wizard-save').click();

  await page.getByTestId('broadcast-composer').waitFor();
  const item = page.getByTestId('broadcast-item').filter({ hasText: name });
  await expect(item.getByTestId('broadcast-status')).toHaveText('sent', { timeout: 15_000 });
  await expect(item.getByTestId('broadcast-medium-badge')).toHaveText('WhatsApp');
});

test('compose + send a WhatsApp TEMPLATE broadcast (approved template + variables)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  const name = `WA tpl ${Date.now()}`;
  await page.getByTestId('broadcast-name').fill(name);
  await page.getByTestId('broadcast-medium').selectOption('whatsapp');
  await pickAudienceSegment(page);
  await page.getByTestId('wizard-next').click();

  // Content: WhatsApp defaults to the TEMPLATE editor. The step is gated until a name.
  await expect(page.getByTestId('whatsapp-template')).toBeVisible();
  await expect(page.getByTestId('wa-template-incomplete')).toBeVisible();
  await expect(page.getByTestId('wizard-next')).toBeDisabled();
  await page.getByTestId('wa-template-name').fill('order_update');
  await page.getByTestId('wa-template-lang').fill('en_US');
  // Map {{1}} to a merge tag (a placeholder — e.g. the first name).
  await page.getByTestId('wa-template-param-add').click();
  await page.getByTestId('wa-template-param').first().fill('{{customer.first_name}}');
  await expect(page.getByTestId('wa-template-complete')).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // Review shows the template + its variable count; Send now sends (via the mock — no
  // Meta creds in the e2e workspace, so it delivers deterministically).
  await expect(page.getByTestId('review-wa-template')).toContainText('order_update');
  await expect(page.getByTestId('review-wa-template')).toContainText('1 variable');
  await page.getByTestId('wizard-save').click();

  await page.getByTestId('broadcast-composer').waitFor();
  const item = page.getByTestId('broadcast-item').filter({ hasText: name });
  await expect(item.getByTestId('broadcast-status')).toHaveText('sent', { timeout: 15_000 });
  await expect(item.getByTestId('broadcast-medium-badge')).toHaveText('WhatsApp');
});
