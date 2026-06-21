// E2E (real Chromium): TOPIC-BASED subscription management + the public
// preference center. An admin creates a topic on the Topics screen; the public
// "manage your subscription" page (served by the API) renders the workspace's
// topics + channel-group checkboxes, a PARTIAL opt-out persists (and leaves the
// person reachable), and "unsubscribe from everything" works. Real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT, WS_B, TOPIC_A_NAME, TOPIC_B_NAME, PREF_EMAIL } from './seed.js';

const API_BASE = 'http://localhost:8788';
// The preference center is driven against the WS_B fixture (isolated from WS_A's
// asserted profile/suppression counts).
const prefLink = `${API_BASE}/manage-subscription?workspace_id=${WS_B}&email=${encodeURIComponent(PREF_EMAIL)}`;

test('admin creates a topic on the Topics screen', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-topics').click();
  await page.getByTestId('topics-screen').waitFor();

  // The seeded topic is listed.
  await expect(page.getByTestId('topics-list')).toContainText(TOPIC_A_NAME);

  // Create a new topic.
  const unique = `E2E Topic ${Date.now()}`;
  await page.getByTestId('topic-name').fill(unique);
  await page.getByTestId('topic-create').click();
  await expect(page.getByTestId('topics-list')).toContainText(unique);
});

test('the public preference center renders topics + channels and a PARTIAL opt-out persists', async ({ page }) => {
  // The page is served by the API (not the SPA). No auth — the link is scoped.
  await page.goto(prefLink);
  await expect(page.getByTestId('pref-form')).toBeVisible();
  // The seeded topic + both channel groups + the unsubscribe-all action render.
  await expect(page.locator('body')).toContainText(TOPIC_B_NAME);
  await expect(page.getByTestId('pref-group-email')).toBeVisible();
  await expect(page.getByTestId('pref-group-sms_whatsapp')).toBeVisible();
  await expect(page.getByTestId('pref-unsub-all')).toBeVisible();

  // PARTIAL opt-out: uncheck the Email group, leave WhatsApp & SMS checked, and
  // keep the topic checked. Save → the person stays reachable on sms_whatsapp and
  // is NOT globally unsubscribed.
  const emailBox = page.getByTestId('pref-group-email');
  await expect(emailBox).toBeChecked(); // default-on
  await emailBox.uncheck();
  await page.getByTestId('pref-save').click();
  await expect(page.locator('body')).toContainText(/Preferences saved/i);

  // Reload the center: the email group is now UNchecked, WhatsApp & SMS still checked.
  await page.goto(prefLink);
  await expect(page.getByTestId('pref-group-email')).not.toBeChecked();
  await expect(page.getByTestId('pref-group-sms_whatsapp')).toBeChecked();
});

test('"unsubscribe from everything" on the preference center fully opts out', async ({ page }) => {
  await page.goto(prefLink);
  await page.getByTestId('pref-unsub-all').click();
  await expect(page.locator('body')).toContainText(/unsubscribed/i);
});
