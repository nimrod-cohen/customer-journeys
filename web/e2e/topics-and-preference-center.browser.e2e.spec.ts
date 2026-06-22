// E2E (real Chromium): TOPIC-BASED subscription management + the public
// preference center. An admin creates a topic on the Topics screen; the public
// "manage your subscription" page (served by the API) renders the workspace's
// topics + channel-group checkboxes, a PARTIAL opt-out persists (and leaves the
// person reachable), and "unsubscribe from everything" works. Real Postgres.
import { test, expect } from '@playwright/test';
import { packSubscriptionToken, unsubscribeLinkSecret } from '@cdp/email';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_B, TOPIC_A_NAME, TOPIC_B_NAME, PREF_EMAIL } from './seed.js';

const API_BASE = 'http://localhost:8788';
// The preference center is driven against the WS_B fixture (isolated from WS_A's
// asserted profile/suppression counts). The link is the compact, self-contained,
// unguessable `?t=` token (the handler 403s a missing/forged token) — pack it with
// the same dev-fallback secret the local-api uses (no UNSUBSCRIBE_LINK_SECRET env
// in the e2e stack).
const prefToken = packSubscriptionToken(unsubscribeLinkSecret(), WS_B, PREF_EMAIL);
const prefLink = `${API_BASE}/manage-subscription?t=${encodeURIComponent(prefToken)}`;

test('admin creates a topic on the Topics tab in Workspace settings', async ({ page }) => {
  // Topics admin lives inside Workspace settings (owner-gated). Marketers still pick
  // topics in the broadcast/campaign selector, but managing them is an owner task.
  await loginAs(page, DEV_OWNER);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-tab-topics').click();
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
