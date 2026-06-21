// E2E (real Chromium) — MULTI-CHANNEL campaign SEND node (v0.54.0). In the campaign
// builder: insert a send node, switch its channel to SMS, write a message body, set
// a campaign-level TOPIC, and PUBLISH — asserting the publish succeeds (status →
// active) WITHOUT attaching an email template (a text send is gated only on a body,
// not on the email envelope/verified domain). The runner→dispatcher→messages_log
// assertions live in the integration test
// (services/local-api/test/campaign-channel-send.integration.test.ts). Real Postgres (cdp_e2e).
import { test, expect } from '@playwright/test';
import { loginAs, publishCampaign } from './helpers.js';
import { DEV_MKT, TOPIC_A_NAME } from './seed.js';

test('build an SMS send node + a campaign topic, then publish to active', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  await page.getByTestId('campaigns-list-screen').waitFor();
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-canvas').waitFor();
  await page.getByTestId('campaign-name').fill('SMS journey');

  // Set the campaign-level TOPIC (the dispatcher gates campaign sends by it). The
  // Select autosaves; it creates the campaign row on first save (a brand-new
  // campaign), so wait for the editing transition before continuing.
  await page.getByTestId('campaign-topic').selectOption({ label: TOPIC_A_NAME });
  await expect(page.getByTestId('campaign-topic')).toHaveValue(/.+/); // a topic id is selected

  // Insert a send node on the trigger→exit edge.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Open the send editor → switch the channel to SMS → write a body → Save.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-medium').selectOption('sms');
  await drawer.getByTestId('send-text-body').fill('Hi {{customer.first_name}}, welcome!');
  await drawer.getByTestId('send-save-text').click();
  await expect(drawer).toBeHidden();

  // The card summary reflects the SMS medium.
  await expect(page.getByTestId('node-send')).toContainText('Send SMS');

  // Save the assembled journey then publish — a text send needs NO email template /
  // verified domain, so the publish gate passes on the body alone.
  await page.getByTestId('save-campaign').click();
  await expect(page.getByTestId('toast')).toBeVisible();

  await publishCampaign(page, 'SMS v1');
  await expect(page.getByTestId('campaign-status')).toContainText('active');
});
