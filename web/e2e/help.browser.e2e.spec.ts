// E2E (real Chromium): the Help section is reachable for any signed-in user and
// renders the deliverability/consent/suppression reference.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

// The footer version label must reflect the PROJECT version (root package.json) —
// the single source we bump — not a stale per-package 0.0.0.
const ROOT_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;

test('Help is in the nav and explains email status vs consent vs suppression', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-help').click();
  await page.getByTestId('help').waitFor();
  await expect(page.getByTestId('help')).toContainText('Email status, consent');
  await expect(page.getByTestId('help')).toContainText('soft-bounce');
  // The CSV-import behaviour is documented too.
  await expect(page.getByTestId('help-import')).toContainText('import an existing profile');
  // And how to set up sending — led by the provider that is actually offered. It
  // used to walk everyone through creating an AWS account, including the companies
  // on our own mail server, who have no SES account and never will.
  await expect(page.getByTestId('help-ses')).toContainText('Setting up sending');
  await expect(page.getByTestId('help-ses')).toContainText('Internal mail server');
  await expect(page.getByTestId('help-ses')).toContainText('Resend');

  // The footer version label reflects the root project version.
  await expect(page.getByTestId('app-version')).toContainText(`v${ROOT_VERSION}`);
});
