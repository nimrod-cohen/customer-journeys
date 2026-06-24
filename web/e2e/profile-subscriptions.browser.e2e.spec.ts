// E2E (real Chromium, cdp_e2e): the per-profile SUBSCRIPTIONS tab (admin override).
// A marketer opens a profile, sees the topic + channel-group toggles (default-on),
// opts the profile out of one topic + one channel group, and the change persists
// across a reload (the per-toggle PUT hits the new /profiles/:id subscription API).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT, TOPIC_A } from './seed.js';

async function openProfile(page: import('@playwright/test').Page): Promise<void> {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('tab-subscriptions').click();
  await page.getByTestId('subscriptions-tab').waitFor();
}

const topicToggle = (page: import('@playwright/test').Page) =>
  page.locator(`[data-topic-id="${TOPIC_A}"] [data-testid="topic-toggle"]`);
const emailToggle = (page: import('@playwright/test').Page) =>
  page.locator('[data-channel-group="email"] [data-testid="channel-toggle"]');

test('profile Subscriptions tab: topics + channels default-on; opting out persists across reload', async ({ page }) => {
  await openProfile(page);

  // Default-on: the seeded topic + the email channel start subscribed (checked).
  await expect(topicToggle(page)).toBeChecked();
  await expect(emailToggle(page)).toBeChecked();

  // Opt the profile out of the topic + the email channel (each toggle PUTs on
  // change — wait for the writes to land before reloading).
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/topic-subscriptions/${TOPIC_A}`) && r.request().method() === 'PUT'),
    topicToggle(page).uncheck({ force: true }),
  ]);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/channel-subscriptions/email') && r.request().method() === 'PUT'),
    emailToggle(page).uncheck({ force: true }),
  ]);
  await expect(topicToggle(page)).not.toBeChecked();
  await expect(emailToggle(page)).not.toBeChecked();

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
