// E2E (real Chromium): a send's CHANNEL surfaces in the Activity log as the row
// TYPE (e.g. "sms"), not the literal "send" — and a skip/failure reason rides the
// detail (COALESCE(reason, status)). We compose + send an SMS broadcast to the
// seeded manual segment (its member a1 has a valid E.164 phone, so it delivers via
// the local mock provider), then open the Activity log and assert a row typed
// "sms" with the "send" source appears. (The skip-with-reason path — no phone /
// invalid phone / no email — is proven against real Postgres in the integration
// tier; here we prove the channel TYPE renders in the unified feed.)
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('a sent SMS appears in the Activity log typed by its channel ("sms")', async ({ page }) => {
  await loginAs(page, DEV_MKT);

  // 1. Compose + send an SMS broadcast to the seeded manual segment (index 1).
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await page.getByTestId('broadcast-name').fill('Activity SMS');
  await page.getByTestId('broadcast-medium').selectOption('sms');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('broadcast-text-body').fill('Hi {{customer.first_name}}!');
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-save').click(); // Send now
  await page.getByTestId('broadcast-composer').waitFor();
  await expect(page.getByTestId('toast')).toBeVisible();

  // 2. Open the Activity log; the send rows are recorded "now", so the default
  //    today range covers them. Filter to source=send so only the send rows show.
  await page.getByTestId('nav-activity').click();
  await page.getByTestId('activity').waitFor();
  await page.getByTestId('activity-source').selectOption('send');
  await page.getByTestId('activity-apply').click();

  // The send row's TYPE is the channel medium ("sms"), not the literal "send".
  const smsRow = page.getByTestId('activity-row').filter({ hasText: 'sms' });
  await expect(smsRow.first()).toBeVisible();
});
