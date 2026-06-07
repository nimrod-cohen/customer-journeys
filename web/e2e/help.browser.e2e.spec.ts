// E2E (real Chromium): the Help section is reachable for any signed-in user and
// renders the deliverability/consent/suppression reference.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('Help is in the nav and explains email status vs consent vs suppression', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-help').click();
  await page.getByTestId('help').waitFor();
  await expect(page.getByTestId('help')).toContainText('Email status, consent');
  await expect(page.getByTestId('help')).toContainText('soft-bounce');
});
