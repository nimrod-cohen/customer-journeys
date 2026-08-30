// The Transactional screen: creating an API-triggered message and keying it.
//
// The point of the screen is discoverability — the feature was previously reachable
// only through a row menu, which meant nobody found it. So the test walks the path a
// person actually takes: sidebar → create → it appears with its key.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create a transactional SMS and see it listed by its key', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-transactional').click();
  await page.getByTestId('transactional-screen').waitFor();

  await page.getByTestId('new-transactional-text').click();
  await page.getByTestId('transactional-text-drawer').waitFor();
  await page.getByTestId('transactional-text-name').fill('Login code');
  await page.getByTestId('transactional-text-key').fill('e2e-otp-sms');
  await page.getByTestId('transactional-text-body').fill('Your code is {{data.code}}');
  await page.getByTestId('transactional-text-save').click();

  const row = page.getByTestId('transactional-item').filter({ hasText: 'e2e-otp-sms' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('SMS');

  // It really persisted, rather than only living in local state.
  await page.reload();
  await page.getByTestId('transactional-screen').waitFor();
  await expect(page.getByTestId('transactional-item').filter({ hasText: 'e2e-otp-sms' })).toHaveCount(1);
});

// The key is the integrator's contract: two messages answering to one name would
// make "template": "otp" ambiguous.
test('a key already in use is refused, naming the message that holds it', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-transactional').click();
  await page.getByTestId('transactional-screen').waitFor();

  for (const name of ['First claim', 'Second claim']) {
    await page.getByTestId('new-transactional-text').click();
    await page.getByTestId('transactional-text-drawer').waitFor();
    await page.getByTestId('transactional-text-name').fill(name);
    await page.getByTestId('transactional-text-key').fill('e2e-dup');
    await page.getByTestId('transactional-text-body').fill('body');
    await page.getByTestId('transactional-text-save').click();
    if (name === 'First claim') {
      await expect(page.getByTestId('transactional-item').filter({ hasText: 'e2e-dup' })).toHaveCount(1);
    }
  }

  await expect(page.getByTestId('transactional-text-error')).toContainText('First claim');
  // The drawer stays open on the rejected value so the key can be corrected.
  await expect(page.getByTestId('transactional-text-drawer')).toBeVisible();
});

// A transactional email is sendable in its own right, so unlike a library template
// it must expose an envelope — without it every send 409s on a missing From.
test('a transactional email shows From and Subject in the designer', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-transactional').click();
  await page.getByTestId('transactional-screen').waitFor();

  await page.getByTestId('new-transactional-email').click();
  await page.getByTestId('transactional-email-drawer').waitFor();
  await page.getByTestId('transactional-email-name').fill('Password reset');
  await page.getByTestId('transactional-email-key').fill('e2e-reset');
  await page.getByTestId('transactional-email-create').click();

  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('email-subject')).toBeVisible();
  await expect(page.getByTestId('email-sender')).toBeVisible();
  // The recipient comes from the API call, so there is no stored To to edit.
  await expect(page.getByTestId('email-to')).toHaveCount(0);
  await expect(page.getByTestId('email-to-transactional')).toBeVisible();
});
