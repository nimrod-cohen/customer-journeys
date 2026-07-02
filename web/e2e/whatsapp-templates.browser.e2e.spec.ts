// E2E (real Chromium): the WhatsApp templates management tab in Asset management. The e2e
// workspace has no Meta WABA credentials, so the tab shows the "connect WhatsApp" prompt
// (the honest offline state). The full Graph proxy (list/create/delete) is covered by the
// integration test with an injected fake client (services/local-api/test/
// whatsapp-templates.integration.test.ts) — the e2e can't reach real graph.facebook.com.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('WhatsApp templates tab renders and prompts to connect WhatsApp when unconfigured', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();

  // The 4th Asset-management tab exists.
  await page.getByTestId('assets-tab-whatsapp').click();
  await page.getByTestId('whatsapp-templates-screen').waitFor();

  // No WABA credentials in the e2e workspace → the connect prompt (not a create form).
  await expect(page.getByTestId('whatsapp-templates-unconfigured')).toBeVisible();
  await expect(page.getByTestId('whatsapp-templates-unconfigured')).toContainText(/WhatsApp Business account id/i);
});
