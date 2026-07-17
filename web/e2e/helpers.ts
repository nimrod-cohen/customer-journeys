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

/**
 * Define a broadcast's audience as "is a member of the first seeded segment" using the
 * new comprehensive audience RuleBuilder (replaces the old single `broadcast-segment`
 * Select): set the first rule row's kind to Segment and pick the first segment.
 */
export async function pickAudienceSegment(page: Page): Promise<void> {
  const aud = page.getByTestId('broadcast-audience');
  await aud.getByTestId('rule-kind').first().selectOption('segment');
  await aud.getByTestId('rule-segment').first().selectOption({ index: 1 });
}

/**
 * Publish the automation currently open in the builder via the Save-version modal
 * (the automation builder now edits a DRAFT and publishes append-only VERSIONS).
 * Opens the modal, names the version, and confirms a FORWARD publish (the default).
 * Caller asserts the resulting status.
 */
export async function publishAutomation(page: Page, versionName = 'v1'): Promise<void> {
  await page.getByTestId('publish-version').click();
  await page.getByTestId('publish-modal').waitFor();
  await page.getByTestId('version-name').fill(versionName);
  await page.getByTestId('publish-confirm').click();
}
