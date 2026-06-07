// E2E (real Chromium): login + workspace switching re-scopes the app with NO
// cross-bleed (§12, §18 "Multi-workspace switching"). The multi-workspace user
// logs in, navigates to Segments (which now lists EXISTING segments), and we
// prove against the real API + Postgres that:
//   - on WS_A the list shows A's segment ("Manual VIPs") and NOT B's,
//   - after switching to WS_B the active value flips AND the list flips: A's
//     segment is GONE from the DOM and B's segment ("Beta Loyalty Club") appears.
// This asserts the actual DATA re-scopes in the browser, not just the selector.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A, WS_B, SEG_A_NAME, SEG_B_NAME } from './seed.js';

test('login then switch workspace re-scopes the app with no cross-bleed', async ({ page }) => {
  await loginAs(page, DEV_OWNER);

  // Active workspace is one of the memberships; navigate to segments (the list).
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();

  // The switcher lists both workspaces.
  const select = page.getByTestId('workspace-select');
  await expect(select).toBeVisible();

  // The list of existing segments — the surface we use to prove re-scoping.
  const list = page.getByTestId('segment-list');
  const aItem = list.getByText(SEG_A_NAME, { exact: true });
  const bItem = list.getByText(SEG_B_NAME, { exact: true });

  // --- On WS_A: A's segment is present, B's is absent. ---
  await select.selectOption(WS_A);
  await expect(select).toHaveValue(WS_A);
  await expect(aItem).toBeVisible();
  await expect(bItem).toHaveCount(0);

  // --- Switch to WS_B: the active value flips. ---
  await select.selectOption(WS_B);
  await expect(select).toHaveValue(WS_B);
  // No cross-bleed: after switching to WS_B the active workspace id is WS_B, not A.
  await expect(select).not.toHaveValue(WS_A);

  // CRITICAL: the DATA re-scoped too — A's segment is GONE from the DOM and B's
  // segment is now shown. A stale/cross-bleeding view would still show "Manual VIPs".
  await expect(bItem).toBeVisible();
  await expect(aItem).toHaveCount(0);
});
