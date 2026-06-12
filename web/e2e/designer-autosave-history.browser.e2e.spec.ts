// E2E (real Chromium): the designer AUTOSAVES (no explicit save needed) and the
// History tab lists committed changes with preview + restore. §11/§12.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('changes autosave without clicking save', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();

  // Name + an element — then just WAIT: the debounced autosave persists.
  await page.getByTestId('template-name').fill('Autosaved one');
  await page.getByTestId('toolbox-text').click();
  await expect(page.getByTestId('template-saved')).toBeVisible({ timeout: 10_000 });

  // No save click ever happened — yet the template exists in the library.
  await page.getByTestId('editor-back').click();
  await page.getByTestId('templates-screen').waitFor();
  await expect(page.getByTestId('template-list')).toContainText('Autosaved one');

  // And re-opening loads the autosaved design.
  await page.getByTestId('template-item').filter({ hasText: 'Autosaved one' }).getByTestId('template-edit').click();
  await page.getByTestId('email-editor').waitFor();
  await expect(page.getByTestId('canvas-element')).toHaveCount(1);
});

test('the History tab lists changes; preview + restore work', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-templates').click();
  await page.getByTestId('templates-screen').waitFor();
  await page.getByTestId('new-template').click();
  await page.getByTestId('email-editor').waitFor();

  // Two committed changes → two history entries.
  await page.getByTestId('toolbox-heading').click();
  await page.getByTestId('toolbox-button').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(2);

  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-item')).toHaveCount(2);
  await expect(page.getByTestId('designer-history')).toContainText('Add heading');
  await expect(page.getByTestId('designer-history')).toContainText('Add button');

  // Click the OLDER entry → previews the state right after "Add heading" (1 element).
  await page.getByTestId('history-item').nth(1).locator('.nm-history-row').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(1);

  // Restore commits that version (undoable); the canvas stays at 1 element.
  await page.getByTestId('history-restore').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(1);

  // Undo brings the button back — the restore itself is just another change.
  await page.getByTestId('designer-undo').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(2);

  // Back-to-live guard: previewing then exiting returns to the live document.
  await page.getByTestId('history-item').last().locator('.nm-history-row').click();
  await page.getByTestId('history-exit-preview').click();
  await expect(page.getByTestId('canvas-element')).toHaveCount(2);
});
