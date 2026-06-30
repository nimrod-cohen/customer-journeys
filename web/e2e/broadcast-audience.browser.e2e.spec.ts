// E2E (real Chromium): a broadcast's audience is now a COMPREHENSIVE segment-style rule
// (§9A) — attribute/event conditions AND segment-membership leaves ("is / is NOT a member
// of X") under AND/OR. This proves the unified builder: include a DYNAMIC segment (resolved
// LIVE), see a live recipient estimate, then EXCLUDE a segment and watch the estimate drop.
// Real Postgres (cdp_e2e); the count comes from /broadcasts/audience-preview.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT, SEG_DYN_A_NAME, SEG_A_NAME } from './seed.js';

/** Parse the "≈ N recipients" estimate (waits for it to be a concrete number). */
async function recipientCount(page: import('@playwright/test').Page): Promise<number> {
  const cell = page.getByTestId('broadcast-audience-count');
  await expect(cell).toContainText(/≈\s*[\d,]+ recipient/, { timeout: 10_000 });
  const txt = (await cell.textContent()) ?? '';
  return Number(txt.replace(/[^\d]/g, ''));
}

test('build a comprehensive audience: include a dynamic segment, then EXCLUDE one — the live count drops', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  await page.getByTestId('new-broadcast').click();
  await page.getByTestId('broadcast-wizard').waitFor();
  await page.getByTestId('broadcast-name').fill('Audience rule');

  const aud = page.getByTestId('broadcast-audience');
  // Row 1: "is a member of" the DYNAMIC VIP segment (resolved live: tier=vip → a1, a2).
  await aud.getByTestId('rule-kind').first().selectOption('segment');
  await aud.getByTestId('rule-segment').first().selectOption({ label: SEG_DYN_A_NAME });
  const included = await recipientCount(page);
  expect(included).toBeGreaterThanOrEqual(1); // at least a1/a2 are VIP

  // Next is enabled once the audience has a condition (no accidental blast-all).
  await expect(page.getByTestId('wizard-next')).toBeEnabled();

  // Row 2: AND "is NOT a member of" the Manual VIPs segment (a1 is a member → excluded).
  await aud.getByTestId('add-rule').click();
  await aud.getByTestId('rule-kind').nth(1).selectOption('segment');
  await aud.getByTestId('rule-segment').nth(1).selectOption({ label: SEG_A_NAME });
  await aud.getByTestId('rule-segment-op').nth(1).selectOption('not');

  // The estimate must DROP (the manual-VIP member is removed by the exclude).
  await expect
    .poll(async () => recipientCount(page), { timeout: 10_000 })
    .toBeLessThan(included);
});
