// E2E (real Chromium): login + workspace switching re-scopes the app with NO
// cross-bleed (§12, §18 "Multi-workspace switching"). A user belongs to ONE
// company (Acme) that owns TWO workspaces (WS_A + WS_A2); the user switches
// between them and we prove against the real API + Postgres that:
//   - on WS_A the list shows WS_A's segment ("Manual VIPs") and NOT WS_A2's,
//   - after switching to WS_A2 the active value flips AND the list flips: WS_A's
//     segment is GONE from the DOM and WS_A2's ("Acme West Club") appears.
// This asserts the actual DATA re-scopes in the browser, not just the selector.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_OWNER, WS_A, WS_A2, SEG_A_NAME, SEG_A2_NAME } from './seed.js';

test('login then switch workspace re-scopes the app with no cross-bleed', async ({ page }) => {
  await loginAs(page, DEV_OWNER);

  // Active workspace is one of the memberships; navigate to segments (the list).
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();

  // The switcher lists both of the company's workspaces.
  const select = page.getByTestId('workspace-select');
  await expect(select).toBeVisible();

  // The list of existing segments — the surface we use to prove re-scoping.
  const list = page.getByTestId('segment-list');
  const aItem = list.getByText(SEG_A_NAME, { exact: true });
  const a2Item = list.getByText(SEG_A2_NAME, { exact: true });

  // --- On WS_A: WS_A's segment is present, WS_A2's is absent. ---
  await select.selectOption(WS_A);
  await expect(select).toHaveValue(WS_A);
  await expect(aItem).toBeVisible();
  await expect(a2Item).toHaveCount(0);

  // --- Switch to WS_A2: the active value flips. ---
  await select.selectOption(WS_A2);
  await expect(select).toHaveValue(WS_A2);
  await expect(select).not.toHaveValue(WS_A);

  // CRITICAL: the DATA re-scoped too — WS_A's segment is GONE and WS_A2's shows.
  await expect(a2Item).toBeVisible();
  await expect(aItem).toHaveCount(0);
});
