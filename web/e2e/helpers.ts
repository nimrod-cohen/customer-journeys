// Shared e2e helpers — log in via the SPA UI as a seeded user.
import type { Page } from '@playwright/test';

export async function loginAs(page: Page, userId: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('login-user-id').fill(userId);
  await page.getByTestId('login-submit').click();
  // The AppShell renders the nav once the session token is set.
  await page.getByTestId('app-nav').waitFor();
}
