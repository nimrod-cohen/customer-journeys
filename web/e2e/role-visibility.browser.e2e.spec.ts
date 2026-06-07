// E2E (real Chromium): role-aware UI + SERVER-SIDE enforcement (§3A, §18
// "Roles"). A marketer's nav hides billing/settings/admin; an owner's shows
// them. AND — proving the server enforces independently of UI hiding — a
// marketer hitting the billing API directly still gets 403 (asserted via the
// page's fetch, bypassing the hidden nav).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT, DEV_OWNER } from './seed.js';

test('marketer nav hides billing/settings/admin', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await expect(page.getByTestId('nav-segments')).toBeVisible();
  await expect(page.getByTestId('nav-billing')).toHaveCount(0);
  await expect(page.getByTestId('nav-settings')).toHaveCount(0);
  await expect(page.getByTestId('nav-admin')).toHaveCount(0);
});

test('owner nav shows billing + settings', async ({ page }) => {
  await loginAs(page, DEV_OWNER);
  await expect(page.getByTestId('nav-billing')).toBeVisible();
  await expect(page.getByTestId('nav-settings')).toBeVisible();
});

test('server 403s a marketer on billing even when the UI route is hidden', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  // Call the API directly from the browser with the marketer's stored token —
  // the SERVER must enforce the capability regardless of the hidden nav link.
  const status = await page.evaluate(async () => {
    // The apiClient stores the token in the session store; read it from a fresh
    // dev-login is overkill — instead just re-login via the API to get a token.
    const base = 'http://localhost:8787';
    const login = await fetch(`${base}/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: '0e2efe00-0000-4000-8000-0000000000b2' }),
    });
    const { token } = await login.json();
    const res = await fetch(`${base}/billing/usage`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.status;
  });
  expect(status).toBe(403);
});
