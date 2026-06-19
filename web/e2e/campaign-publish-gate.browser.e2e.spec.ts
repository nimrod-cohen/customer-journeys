// E2E (real Chromium, cdp_e2e): the PUBLISH gate of the campaign builder (§9B
// phase 6). Publish (Draft → Active) runs validateCampaignDefinition + the
// send-node envelope gating (sender → to → subject) + the verified-domain gate.
// A blocked publish surfaces a SPECIFIC reason INLINE (publish-reason +
// node-publish-error on the offending card), never a native dialog, and the status
// badge stays 'draft'; a complete journey flips to 'active'. The seed has a verified
// sending domain + a named sender (LOCAL_SES_FORCE_MOCK).
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

async function openCampaigns(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-campaigns').click();
  // Campaigns is now a LIST page; New campaign / opening a row → the canvas builder.
  await page.getByTestId('campaigns-list-screen').waitFor();
}

test('a complete seeded journey publishes to active', async ({ page }) => {
  await openCampaigns(page);
  // The seeded "Welcome journey" has a send node pointing at the seeded library
  // template (sender + subject + to all set) and the workspace has a verified
  // domain → Publish succeeds and the status badge flips to active.
  await page.getByTestId('campaign-item').filter({ hasText: 'Welcome journey' }).getByTestId('campaign-open').click();
  await page.getByTestId('campaign-canvas').waitFor();

  await page.getByTestId('campaign-publish').click();
  await expect(page.getByTestId('campaign-status')).toContainText('active');
});

test('a send step with no From blocks publish inline (sender reason + node error), then publishes once a complete email is attached', async ({ page }) => {
  await openCampaigns(page);
  await page.getByTestId('campaign-new').click();
  await page.getByTestId('campaign-name').fill('Gate journey');

  // Build trigger → send → exit. Insert a send on the trigger→exit edge.
  await page.getByTestId('campaign-edge-insert').first().click();
  await page.getByTestId('campaign-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Design a BLANK email for the send node (a copy with NO sender) and come back.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  await page.getByTestId('node-editor-send').getByTestId('send-blank-design').click();
  await expect(page).toHaveURL(/\/editor/);
  // Return to the campaign without choosing a sender.
  await page.getByTestId('editor-back').click();
  await page.getByTestId('campaign-canvas').waitFor();

  // Publish → blocked on the missing From, named against the send node.
  await page.getByTestId('campaign-publish').click();
  await expect(page.getByTestId('publish-reason')).toContainText(/from|who the email is from/i);
  await expect(page.getByTestId('node-publish-error')).toBeVisible();
  await expect(page.getByTestId('campaign-status')).toContainText('draft');

  // Fix it: the blank-design flow was abandoned without saving, so the send node
  // has no copy yet — reopening it shows the template PICKER (not an instance, like
  // the broadcast wizard's matching flow). Attach the seeded "Welcome" template (a
  // complete envelope — sender + subject + to). Then publish succeeds (verified domain).
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('campaign-publish').click();
  await expect(page.getByTestId('campaign-status')).toContainText('active');
});
