// E2E (real Chromium, cdp_e2e): the per-profile SUBSCRIPTIONS tab (admin override).
// A marketer opens a profile, sees the topic + channel-group toggles (default-on),
// opts the profile out of one topic + one channel group, and the change persists
// across a reload (the per-toggle PUT hits the new /profiles/:id subscription API).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT, TOPIC_A } from './seed.js';

async function openProfile(page: import('@playwright/test').Page, email = 'a1@acme.com'): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill(email);
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
}

const topicToggle = (page: import('@playwright/test').Page) =>
  page.locator(`[data-topic-id="${TOPIC_A}"] [data-testid="topic-toggle"]`);
const emailToggle = (page: import('@playwright/test').Page) =>
  page.locator('[data-channel-group="email"] [data-testid="channel-toggle"]');
const smsToggle = (page: import('@playwright/test').Page) =>
  page.locator('[data-channel-group="sms_whatsapp"] [data-testid="channel-toggle"]');

/** Reset the open profile to a clean FULLY-SUBSCRIBED baseline (every channel +
 *  topic on, no suppression) via the Attributes "Unsubscribed" toggle, so the test
 *  doesn't depend on residual state. Ends on the Subscriptions tab. */
async function resetSubscribed(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('tab-attributes').click();
  const unsub = page.getByTestId('attr-unsubscribed');
  if (!(await unsub.isChecked())) {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/global-subscription') && r.request().method() === 'PUT'),
      unsub.check({ force: true }), // unsubscribe (cascade everything off)
    ]);
  }
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/global-subscription') && r.request().method() === 'PUT'),
    unsub.uncheck({ force: true }), // resume → every channel + topic back on
  ]);
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
}

test('Subscriptions tab: a channel-level partial opt-out persists (keeps a channel + topic)', async ({ page }) => {
  await openProfile(page);
  await resetSubscribed(page);

  // Default-on: the seeded topic + both channels start subscribed.
  await expect(topicToggle(page)).toBeChecked();
  await expect(emailToggle(page)).toBeChecked();
  await expect(smsToggle(page)).toBeChecked();

  // Opt out of EMAIL only — SMS + the topic stay on, so still subscribed (no banner).
  await emailToggle(page).uncheck({ force: true });
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(emailToggle(page)).toBeEnabled();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toHaveCount(0);

  // Persists across reload (email off, sms + topic on).
  await page.reload();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).toBeChecked();
  await expect(topicToggle(page)).toBeChecked();

  // Re-subscribe email.
  await emailToggle(page).check({ force: true });
  await expect(emailToggle(page)).toBeChecked();
});

test('Subscriptions rules: turning off the only topic unsubscribes; turning it back on resumes', async ({ page }) => {
  await openProfile(page, 'a2@acme.com');
  await resetSubscribed(page);
  await expect(topicToggle(page)).toBeChecked();

  // Turn off the only topic (channels still on) → a topic is required, so this is a
  // global unsubscribe: the banner appears and everything goes off.
  await topicToggle(page).uncheck({ force: true });
  await expect(page.getByTestId('globally-unsubscribed-banner')).toBeVisible();
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).not.toBeChecked();
  await expect(topicToggle(page)).not.toBeChecked();
  await expect(topicToggle(page)).toBeEnabled(); // wait for the save+reload to settle

  // Turning the topic back on auto-enables BOTH channels and clears the unsubscribe.
  await topicToggle(page).check({ force: true });
  await expect(emailToggle(page)).toBeChecked();
  await expect(smsToggle(page)).toBeChecked();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toHaveCount(0);
});

test('Subscriptions rules: turning off the LAST channel unsubscribes — channels do NOT bounce back on', async ({ page }) => {
  await openProfile(page, 'a2@acme.com');
  await resetSubscribed(page);
  await expect(emailToggle(page)).toBeChecked();
  await expect(smsToggle(page)).toBeChecked();
  await expect(topicToggle(page)).toBeChecked();

  // Opt out of email first (partial — sms + topic still on).
  await emailToggle(page).uncheck({ force: true });
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(emailToggle(page)).toBeEnabled();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toHaveCount(0);

  // Now turn off the LAST channel (sms). With no channel nothing is deliverable, so this
  // is a global unsubscribe — the banner appears and BOTH channels stay off (regression:
  // the old server Rule A re-enabled both channels here, snapping them back on).
  await smsToggle(page).uncheck({ force: true });
  await expect(page.getByTestId('globally-unsubscribed-banner')).toBeVisible();
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).not.toBeChecked();
  await expect(topicToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).toBeEnabled();

  // Persists across reload (still unsubscribed, nothing bounced back on).
  await page.reload();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toBeVisible();
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).not.toBeChecked();
});

test('Attributes "Unsubscribed" toggle auto-saves and cascades to the Subscriptions tab', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();

  // Turn Unsubscribed ON on the Attributes tab — it auto-saves (no Save click) and
  // cascades server-side (opts out every channel + topic + the suppression).
  await page.getByTestId('tab-attributes').click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/global-subscription') && r.request().method() === 'PUT'),
    page.getByTestId('attr-unsubscribed').check({ force: true }),
  ]);

  // The Subscriptions tab now shows the unsubscribe banner + everything off.
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toBeVisible();
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).not.toBeChecked();
  await expect(topicToggle(page)).not.toBeChecked();

  // Toggle it OFF on Attributes → resumes (everything default-on, banner gone).
  await page.getByTestId('tab-attributes').click();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/global-subscription') && r.request().method() === 'PUT'),
    page.getByTestId('attr-unsubscribed').uncheck({ force: true }),
  ]);
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toHaveCount(0);
  await expect(emailToggle(page)).toBeChecked();
  await expect(topicToggle(page)).toBeChecked();
});
