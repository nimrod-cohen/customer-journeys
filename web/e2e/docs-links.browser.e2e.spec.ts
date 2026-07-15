// Lightweight link check: the homepage (login, public root '/') links to the
// public API docs at '/docs', and '/docs' links back to the homepage. Both are
// real server paths, so these are full navigations.
import { test, expect } from '@playwright/test';

test('homepage ↔ /docs links navigate both ways', async ({ page }) => {
  // Homepage (public root) → Docs.
  await page.goto('/');
  await page.getByTestId('login-form').waitFor();
  await page.getByTestId('docs-link').click();
  await page.getByTestId('api-docs').waitFor();
  await expect(page).toHaveURL(/\/docs$/);

  // /docs → back to homepage.
  await page.getByTestId('docs-back-home').click();
  await page.getByTestId('login-form').waitFor();
  await expect(page).toHaveURL(/\/$/);
});
