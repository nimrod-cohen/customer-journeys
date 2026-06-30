// E2E (real Chromium): numbered-page pagination + server-side search on the Broadcasts
// list. Bulk-seeds 60 broadcasts into WS_A (so the list spans 2 pages at 50/page), then
// asserts: page 1 shows 50, the Pagination summary reads "1–50 of 6x", Next/page-2 loads
// the rest, and a server-side search finds a row that lives on a later page. Cleans up the
// seeded rows after. Real Postgres (cdp_e2e).
import { test, expect } from '@playwright/test';
import { adminPool } from '@cdp/db';
import { loginAs } from './helpers.js';
import { DEV_MKT, WS_A } from './seed.js';

const TAG = 'PgTest'; // unique name prefix so we can find + clean up just these rows

test.beforeAll(async () => {
  const pool = adminPool();
  // 60 extra broadcasts; one carries a needle name to prove server-side search spans pages.
  for (let i = 0; i < 60; i++) {
    const name = i === 59 ? `${TAG} zzz-needle` : `${TAG} ${String(i).padStart(2, '0')}`;
    await pool.query(
      "INSERT INTO broadcasts (workspace_id, name, audience_kind, audience_ref, status, created_at) VALUES ($1,$2,'rule',null,'draft', now() - ($3 || ' seconds')::interval)",
      [WS_A, name, String(i)],
    );
  }
});

test.afterAll(async () => {
  const pool = adminPool();
  await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1 AND name LIKE $2', [WS_A, `${TAG}%`]);
});

test('broadcasts list pages through 60+ rows and searches server-side across pages', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();

  // Page 1: exactly 50 rows, and the summary reads "1–50 of N" (N ≥ 60).
  await expect(page.getByTestId('broadcast-item')).toHaveCount(50);
  const summary = page.getByTestId('pagination-summary');
  await expect(summary).toContainText(/^1–50 of \d+/);
  const total = Number((await summary.textContent())!.replace(/.*of\s+([\d,]+).*/, '$1').replace(/,/g, ''));
  expect(total).toBeGreaterThanOrEqual(60);

  // Go to page 2 via Next → the remaining rows; summary advances to "51–…".
  await page.getByTestId('page-next').click();
  await expect(summary).toContainText(/^51–/);
  await expect(page.getByTestId('broadcast-item')).toHaveCount(total - 50);

  // Back to page 1 via the page-1 number button.
  await page.getByTestId('page-number').filter({ hasText: /^1$/ }).first().click();
  await expect(summary).toContainText(/^1–50/);

  // Server-side search finds the needle even though it's on a later page (created last →
  // oldest → would be on page 2 without search). One match, paging collapses to one page.
  await page.getByTestId('broadcast-search').fill('zzz-needle');
  await expect(page.getByTestId('broadcast-item')).toHaveCount(1);
  await expect(page.getByTestId('broadcast-item').first()).toContainText('zzz-needle');
  // A single result ⇒ the pagination control hides (≤ 1 page).
  await expect(page.getByTestId('pagination')).toHaveCount(0);
});
