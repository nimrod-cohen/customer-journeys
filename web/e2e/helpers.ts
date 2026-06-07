// Shared e2e helpers — log in via the SPA UI with email + password (the dev
// credential fixture in @cdp/shared, resolved server-side to the seeded user).
import type { Page } from '@playwright/test';
import type { DevUser } from '@cdp/shared';

export async function loginAs(page: Page, user: DevUser): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-email').fill(user.email);
  await page.getByTestId('login-password').fill(user.password);
  await page.getByTestId('login-submit').click();
  // The AppShell renders the nav once the session token is set.
  await page.getByTestId('app-nav').waitFor();
}
