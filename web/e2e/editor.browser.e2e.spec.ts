import { test, expect } from '@playwright/test';

// §11 / §16A tier 3 (browser): the editor renders in REAL Chromium and EMITS
// MJML — the third tier proving the "emit MJML, never hand-rolled HTML"
// invariant (unit + integration + browser). Stable data-testid selectors; the
// app seeds a deterministic starter doc so there's no flakiness.
//
// Skips cleanly (the whole project is gated) if Chromium isn't installed — the
// webServer/build still has to succeed for the suite to run.

test('the GrapesJS+MJML editor renders and emits MJML rooted at <mjml>', async ({ page }) => {
  await page.goto('/');

  // The editor host mounts.
  await expect(page.getByTestId('gjs-host')).toBeVisible();

  // The live MJML output is rooted at <mjml> — never hand-rolled email HTML.
  const output = page.getByTestId('mjml-output');
  await expect(output).toHaveValue(/^<mjml>/, { timeout: 20_000 });
  const mjml = await output.inputValue();
  expect(mjml).toContain('<mj-body>');
  expect(mjml).not.toMatch(/<!DOCTYPE|<html/i);
});

test('inserting an image adds an <mj-image src> referencing the asset URL', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('gjs-host')).toBeVisible();

  await page.getByTestId('insert-image').click();

  const output = page.getByTestId('mjml-output');
  await expect(output).toHaveValue(/<mj-image/, { timeout: 20_000 });
  const mjml = await output.inputValue();
  expect(mjml).toContain('<mj-image');
  expect(mjml).toContain('https://images.cdp.example/ws/sample-hero.png');

  // The save payload carries {name, mjml} only (no compiled HTML client-side).
  const payload = JSON.parse(await page.getByTestId('payload-preview').innerText()) as {
    name: string;
    mjml: string;
  };
  expect(Object.keys(payload).sort()).toEqual(['mjml', 'name']);
  expect(payload.mjml).toContain('<mj-image');
});
