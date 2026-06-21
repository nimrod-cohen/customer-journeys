// Mobile-viewport responsive smoke (v0.53.0). At a 390px-wide phone viewport the
// admin SPA's CORE flows must reflow without page-level horizontal overflow: the
// left sidebar collapses to a slide-in DRAWER reached via the `nav-menu-toggle`
// hamburger, and the primary list screens (Profiles, Broadcasts) fit the width.
// The desktop layout/behaviour is the regression gate of the rest of the suite
// (run at the default Desktop Chrome viewport); this spec only adds the phone case.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

const PHONE = { width: 390, height: 844 };

/** Page-level horizontal overflow in px (scrollWidth − clientWidth of <html>). */
async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const de = document.scrollingElement ?? document.documentElement;
    return de.scrollWidth - de.clientWidth;
  });
}

test('mobile (390px): drawer nav + no horizontal overflow on core screens', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await loginAs(page, DEV_MKT);

  // The hamburger is visible on mobile; the sidebar is off-canvas (its nav links
  // are not clickable until the drawer opens).
  const toggle = page.getByTestId('nav-menu-toggle');
  await expect(toggle).toBeVisible();

  // Open the drawer and navigate to Profiles via the (now-reachable) nav link.
  await toggle.click();
  await expect(page.getByTestId('nav-overlay')).toBeVisible();
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  // The drawer closes on route change.
  await expect(page.getByTestId('nav-overlay')).toHaveCount(0);

  // Profiles: the New-profile action stays within the viewport, no page overflow.
  await expect(page.getByTestId('new-profile')).toBeVisible();
  expect(await pageOverflow(page), 'no horizontal overflow on Profiles @390px').toBeLessThanOrEqual(1);

  // Navigate to Broadcasts via the drawer again.
  await toggle.click();
  await page.getByTestId('nav-broadcasts').click();
  await page.getByTestId('broadcast-composer').waitFor();
  // The broadcasts list screen renders (the list container is present).
  await page.getByTestId('broadcast-list').waitFor();
  expect(await pageOverflow(page), 'no horizontal overflow on Broadcasts @390px').toBeLessThanOrEqual(1);

  // The overlay click closes the drawer (open it, click the scrim).
  await toggle.click();
  await expect(page.getByTestId('nav-overlay')).toBeVisible();
  await page.getByTestId('nav-overlay').click({ position: { x: 360, y: 400 } });
  await expect(page.getByTestId('nav-overlay')).toHaveCount(0);
});
