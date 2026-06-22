// E2E (real Chromium): the TEXT-template library + pick-to-fill. A reusable
// plain-text SMS/WhatsApp template is created in the Asset management "Text
// templates" tab, then picked in the SMS broadcast wizard to FILL the message
// body (copy-on-select) — and the broadcast still sends for real via the local
// mock provider. Proven in a real browser against real Postgres.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create a text template, then pick it to fill an SMS broadcast body + send', async ({ page }) => {
  await loginAs(page, DEV_MKT);

  // --- Create a text template in the library (Asset management → Text tab) ---
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('assets-tab-text').click();
  await page.getByTestId('text-templates-screen').waitFor();

  await page.getByTestId('text-template-name').fill('Flash sale');
  await page.getByTestId('text-template-body').fill('Hi {{customer.first_name}}, flash sale today!');
  await page.getByTestId('text-template-create').click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await expect(page.getByTestId('text-templates-list')).toContainText('Flash sale');

  // --- Use it in the SMS broadcast wizard (pick-to-fill) ---
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();

  await page.getByTestId('broadcast-name').fill('Templated SMS');
  await page.getByTestId('broadcast-medium').selectOption('sms');
  await page.getByTestId('broadcast-segment').selectOption({ index: 1 });
  await page.getByTestId('wizard-next').click();

  // The text-body step shows the template picker; selecting fills the body.
  await expect(page.getByTestId('broadcast-text-body')).toBeVisible();
  await page.getByTestId('text-template-pick').selectOption({ label: 'Flash sale' });
  await expect(page.getByTestId('broadcast-text-body')).toHaveValue('Hi {{customer.first_name}}, flash sale today!');
  await expect(page.getByTestId('text-body-complete')).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // Review + send now (mock provider — no domain needed for text).
  await expect(page.getByTestId('review-text-body')).toContainText('flash sale today');
  await page.getByTestId('wizard-save').click();

  await page.getByTestId('broadcast-composer').waitFor();
  const item = page.getByTestId('broadcast-item').filter({ hasText: 'Templated SMS' });
  await expect(item.getByTestId('broadcast-status')).toHaveText('sent');
  await expect(item.getByTestId('broadcast-medium-badge')).toHaveText('SMS');
});
