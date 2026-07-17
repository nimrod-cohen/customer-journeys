// Regression guard: the Automations LIST page must not cause page-level horizontal
// overflow at realistic widths (the AppShell <main> has min-w-0 + overflow-x-hidden
// and the row grid uses minmax(0,1fr) + a shrinkable/wrapping counts block). Uses
// realistic STRESS content (a long automation name + large multi-digit counts) since
// the seeded single short row does not exercise the shrink path. On overflow it
// walks the DOM and logs the offending elements (testid/class/right/width).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

const WIDTHS = [1280, 1024];

test('automations list has no horizontal overflow at 1280 + 1024', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-automations').click();
  await page.getByTestId('automations-list-screen').waitFor();
  await page.getByTestId('automation-item').first().waitFor();

  // Stress content: a long automation name + large multi-digit counts — what surfaces
  // an overflow (a short seeded row would not exercise the shrink path).
  await page.evaluate(() => {
    const item = document.querySelector('[data-testid="automation-item"]');
    if (!item) return;
    const name = item.querySelector('[data-testid="automation-open"]');
    if (name) name.textContent = 'Quarterly re-engagement winback journey for dormant high-value subscribers';
    const vals = ['1234567', '9876543', '456789', '321098'];
    item.querySelectorAll('[data-testid^="automation-count-"] span:last-child').forEach((s, i) => {
      s.textContent = vals[i] ?? s.textContent;
    });
  });

  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(100); // settle layout

    const diag = await page.evaluate(() => {
      const de = document.documentElement;
      const overflow = de.scrollWidth - de.clientWidth;
      const vw = de.clientWidth;
      const offenders: { tag: string; testid: string; cls: string; right: number; width: number }[] = [];
      if (overflow > 0) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const r = el.getBoundingClientRect();
          if (r.right > vw + 1) {
            offenders.push({
              tag: el.tagName.toLowerCase(),
              testid: (el as HTMLElement).dataset?.testid ?? '',
              cls: (el.getAttribute('class') ?? '').slice(0, 90),
              right: Math.round(r.right),
              width: Math.round(r.width),
            });
          }
        }
        offenders.sort((a, b) => a.width - b.width);
      }
      const btn = document.querySelector('[data-testid="automation-new"]') as HTMLElement | null;
      const actions = document.querySelector('[data-testid="automation-actions"]') as HTMLElement | null;
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        overflow,
        btnRight: btn ? Math.round(btn.getBoundingClientRect().right) : null,
        actionsRight: actions ? Math.round(actions.getBoundingClientRect().right) : null,
        offenders: offenders.slice(0, 12),
      };
    });

    if (diag.overflow > 0) console.log(`[overflow @${w}]`, JSON.stringify(diag, null, 2));

    expect(diag.scrollWidth, `no page horizontal overflow at ${w}px`).toBe(diag.clientWidth);
    // The row's kebab menu and the header "New automation" button stay within the viewport.
    expect(diag.actionsRight ?? 0, `row ActionMenu within viewport at ${w}px`).toBeLessThanOrEqual(w);
    expect(diag.btnRight ?? 0, `New-automation button within viewport at ${w}px`).toBeLessThanOrEqual(w);
  }
});
