// E2E (real Chromium) — MULTI-CHANNEL automation SEND node (v0.54.0). In the automation
// builder: insert a send node, switch its channel to SMS, write a message body, set
// a automation-level TOPIC, and PUBLISH — asserting the publish succeeds (status →
// active) WITHOUT attaching an email template (a text send is gated only on a body,
// not on the email envelope/verified domain). The runner→dispatcher→messages_log
// assertions live in the integration test
// (services/local-api/test/automation-channel-send.integration.test.ts). Real Postgres (cdp_e2e).
import { test, expect } from '@playwright/test';
import { loginAs, publishAutomation } from './helpers.js';
import { DEV_MKT, TOPIC_A_NAME } from './seed.js';

test('build an SMS send node + a automation topic, then publish to active', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-automations').click();
  await page.getByTestId('automations-list-screen').waitFor();
  await page.getByTestId('automation-new').click();
  await page.getByTestId('automation-canvas').waitFor();
  await page.getByTestId('automation-name').fill('SMS journey');

  // Insert a send node on the trigger→exit edge.
  await page.getByTestId('automation-edge-insert').first().click();
  await page.getByTestId('automation-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Open the send editor → switch the channel to SMS → set the per-node TOPIC (the
  // dispatcher gates this send on it) → write a body → Save.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-medium').selectOption('sms');
  await drawer.getByTestId('send-topic').selectOption({ label: TOPIC_A_NAME });
  await expect(drawer.getByTestId('send-topic')).toHaveValue(/.+/); // a topic id is selected
  await drawer.getByTestId('send-text-body').fill('Hi {{customer.first_name}}, welcome!');
  await drawer.getByTestId('send-save-text').click();
  await expect(drawer).toBeHidden();

  // The card summary reflects the SMS medium.
  await expect(page.getByTestId('node-send')).toContainText('Send SMS');

  // Save the assembled journey then publish — a text send needs NO email template /
  // verified domain, so the publish gate passes on the body alone.
  await page.getByTestId('save-automation').click();
  await expect(page.getByTestId('toast')).toBeVisible();

  await publishAutomation(page, 'SMS v1');
  await expect(page.getByTestId('automation-status')).toContainText('active');
});

test('build a WhatsApp TEMPLATE send node, then publish to active', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-automations').click();
  await page.getByTestId('automations-list-screen').waitFor();
  await page.getByTestId('automation-new').click();
  await page.getByTestId('automation-canvas').waitFor();
  await page.getByTestId('automation-name').fill('WA template journey');

  await page.getByTestId('automation-edge-insert').first().click();
  await page.getByTestId('automation-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Open the send editor → WhatsApp → the message type defaults to TEMPLATE → fill the
  // approved template name + language + a {{1}} variable → Save.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-medium').selectOption('whatsapp');
  await expect(drawer.getByTestId('send-whatsapp-template')).toBeVisible();
  await drawer.getByTestId('send-wa-template-name').fill('order_update');
  await drawer.getByTestId('send-wa-template-lang').fill('en_US');
  await drawer.getByTestId('send-wa-param-add').click();
  await drawer.getByTestId('send-wa-param').first().fill('{{customer.first_name}}');
  await drawer.getByTestId('send-save-text').click();
  await expect(drawer).toBeHidden();

  await expect(page.getByTestId('node-send')).toContainText('Send WhatsApp');

  // Publish — a WhatsApp template send needs NO email envelope / verified domain, and the
  // template satisfies the gate WITHOUT a body.
  await page.getByTestId('save-automation').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await publishAutomation(page, 'WA v1');
  await expect(page.getByTestId('automation-status')).toContainText('active');
});
