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

test('profile Subscriptions tab: topics + channels default-on; opting out persists across reload', async ({ page }) => {
  await openProfile(page);

  // Default-on: the seeded topic + the email channel start subscribed (checked).
  await expect(topicToggle(page)).toBeChecked();
  await expect(emailToggle(page)).toBeChecked();

  // Opt the profile out of the topic, then the email channel (SMS stays on, so this
  // is a partial opt-out — not a global unsubscribe). Each toggle PUTs the full state
  // and reloads; the toggle disables while saving, so wait for it to re-enable before
  // the next change.
  await topicToggle(page).uncheck({ force: true });
  await expect(topicToggle(page)).not.toBeChecked();
  await expect(topicToggle(page)).toBeEnabled();
  await emailToggle(page).uncheck({ force: true });
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(emailToggle(page)).toBeEnabled();

  // Reload + reopen → the opt-outs persisted (written via the subscription API).
  await page.reload();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
  await expect(topicToggle(page)).not.toBeChecked();
  await expect(emailToggle(page)).not.toBeChecked();

  // Re-subscribe the channel → back on.
  await emailToggle(page).check({ force: true });
  await expect(emailToggle(page)).toBeChecked();
});

test('admin Subscriptions rules: everything off → unsubscribed; turning a topic back on re-enables both channels', async ({ page }) => {
  // A separate profile so this is independent of the partial-opt-out test above.
  await openProfile(page, 'a2@acme.com');

  // Drive everything OFF (topic, then both channels). Unchecking the LAST channel
  // with the topic already off makes the profile globally unsubscribed.
  await topicToggle(page).uncheck({ force: true });
  await expect(topicToggle(page)).toBeEnabled();
  await emailToggle(page).uncheck({ force: true });
  await expect(emailToggle(page)).toBeEnabled();
  await smsToggle(page).uncheck({ force: true });
  await expect(smsToggle(page)).toBeEnabled();

  // Everything off ⇒ a global unsubscribe banner; all toggles read off.
  await expect(page.getByTestId('globally-unsubscribed-banner')).toBeVisible();
  await expect(emailToggle(page)).not.toBeChecked();
  await expect(smsToggle(page)).not.toBeChecked();
  await expect(topicToggle(page)).not.toBeChecked();

  // Turning a TOPIC back on auto-enables BOTH channels and clears the unsubscribe.
  await topicToggle(page).check({ force: true });
  await expect(emailToggle(page)).toBeChecked();
  await expect(smsToggle(page)).toBeChecked();
  await expect(topicToggle(page)).toBeChecked();
  await expect(page.getByTestId('globally-unsubscribed-banner')).toHaveCount(0);
});
