// E2E (real Chromium, cdp_e2e): the PUBLISH gate of the automation builder (§9B
// phase 6). Publish (Draft → Active) runs validateAutomationDefinition + the
// send-node envelope gating (sender → to → subject) + the verified-domain gate.
// A blocked publish surfaces a SPECIFIC reason INLINE (publish-reason +
// node-publish-error on the offending card), never a native dialog, and the status
// badge stays 'draft'; a complete journey flips to 'active'. The seed has a verified
// sending domain + a named sender (LOCAL_SES_FORCE_MOCK).
import { test, expect, type Page } from '@playwright/test';
import { loginAs, publishAutomation } from './helpers.js';
import { DEV_MKT } from './seed.js';

async function openAutomations(page: Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-automations').click();
  // Automations is now a LIST page; New automation / opening a row → the canvas builder.
  await page.getByTestId('automations-list-screen').waitFor();
}

test('a complete seeded journey publishes to active', async ({ page }) => {
  await openAutomations(page);
  // The seeded "Welcome journey" has a send node pointing at the seeded library
  // template (sender + subject + to all set) and the workspace has a verified
  // domain → Publish succeeds and the status badge flips to active.
  await page.getByTestId('automation-item').filter({ hasText: 'Welcome journey' }).getByTestId('automation-open').click();
  await page.getByTestId('automation-canvas').waitFor();

  // Publish via the Save-version modal (name + forward scope) → status flips to active.
  await publishAutomation(page, 'Welcome v1');
  await expect(page.getByTestId('automation-status')).toContainText('active');
});

test('a send step with no From blocks publish inline (sender reason + node error), then publishes once a complete email is attached', async ({ page }) => {
  await openAutomations(page);
  await page.getByTestId('automation-new').click();
  await page.getByTestId('automation-name').fill('Gate journey');

  // Build trigger → send → exit. Insert a send on the trigger→exit edge.
  await page.getByTestId('automation-edge-insert').first().click();
  await page.getByTestId('automation-palette').waitFor();
  await page.getByTestId('palette-send').click();
  await expect(page.getByTestId('node-send')).toBeVisible();

  // Design a BLANK email for the send node (a copy with NO sender) and come back.
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  await page.getByTestId('node-editor-send').getByTestId('send-blank-design').click();
  // The designer opens in a DRAWER over the automation (no navigation).
  await page.getByTestId('email-designer-drawer').waitFor();
  // Return to the automation without choosing a sender (Save & close).
  await page.getByTestId('editor-back').click();
  await expect(page.getByTestId('email-designer-drawer')).toHaveCount(0);
  // The node editor stays open (no navigation any more) — close it to reach the canvas.
  await page.getByTestId('node-editor-send').getByTestId('drawer-close').click();
  await page.getByTestId('automation-canvas').waitFor();

  // Publish via the modal → blocked on the missing From, named against the send
  // node. The gate reason renders inline (publish-reason) AND on the offending card
  // (node-publish-error); the modal stays open (only success closes it).
  await page.getByTestId('publish-version').click();
  await page.getByTestId('publish-modal').waitFor();
  await page.getByTestId('version-name').fill('Gate v1');
  await page.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('publish-reason')).toContainText(/from|who the email is from/i);
  await expect(page.getByTestId('node-publish-error')).toBeVisible();
  await expect(page.getByTestId('automation-status')).toContainText('draft');
  // Dismiss the modal to fix the send node.
  await page.getByTestId('publish-cancel').click();

  // Fix it: the blank-design flow was abandoned without saving, so the send node
  // has no copy yet — reopening it shows the template PICKER (not an instance, like
  // the broadcast wizard's matching flow). Attach the seeded "Welcome" template (a
  // complete envelope — sender + subject + to). Then publish succeeds (verified domain).
  await page.getByTestId('node-send').getByTestId(/node-open-/).first().click();
  const drawer = page.getByTestId('node-editor-send');
  await drawer.getByTestId('send-template-pick').selectOption({ label: 'Welcome' });
  await drawer.getByTestId('send-attach-template').click();
  // The editor stays open showing the instance — close it to reach the canvas/publish.
  await expect(drawer.getByTestId('send-email-instance')).toBeVisible();
  await drawer.getByTestId('drawer-close').click();

  await publishAutomation(page, 'Gate v1');
  await expect(page.getByTestId('automation-status')).toContainText('active');
});
