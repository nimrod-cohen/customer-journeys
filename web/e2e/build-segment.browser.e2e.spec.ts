// E2E (real Chromium): the Segments list → designated builder flow (§12). The
// marketer opens the builder from the list, enters a rule (attributes.tier =
// vip), previews the size (must be 2 — the two seeded VIPs in WS_A, never WS_B's
// profile), saves, and lands back on the list which now shows the new segment
// (proves the list is reactive). A second test loads an existing segment into the
// builder, renames it, and confirms the rename reflects in the list.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('create a dynamic segment from the list, preview size, and see it appear', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();

  // Open the designated create screen.
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();

  await page.getByTestId('segment-name').fill('VIP members');
  await page.getByTestId('rule-field').first().fill('attributes.tier');
  await page.getByTestId('rule-operator').first().selectOption('=');
  // The value box autosuggests EXISTING attribute values: just focusing it shows
  // the seeded values ("vip", "std"); pick "vip".
  await page.getByTestId('rule-value').first().click();
  await page.getByTestId('value-suggestion').filter({ hasText: 'vip' }).first().click();
  await expect(page.getByTestId('rule-value').first()).toHaveValue('vip');

  await page.getByTestId('preview-size').click();
  // Two seeded VIPs in WS_A; WS_B's VIP-less profile is excluded by scoping.
  await expect(page.getByTestId('segment-size')).toContainText('2');

  await page.getByTestId('save-segment').click();

  // Saving returns to the list, which re-fetches and shows the new segment.
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('VIP members');
});

test('segment by the unsubscribed attribute and by an event', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();
  await page.getByTestId('segment-name').fill('Audience tests');

  // (1) Boolean attribute: attributes.unsubscribed = true → the one unsubscriber.
  await page.getByTestId('rule-field').first().fill('attributes.unsubscribed');
  await page.getByTestId('rule-operator').first().selectOption('=');
  await page.getByTestId('rule-value').first().fill('true');
  await page.getByTestId('preview-size').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  // (2) Switch to an EVENT rule and AUTOSUGGEST the event name: typing "pur"
  // surfaces "purchase" (a1 has one).
  await page.getByTestId('rule-kind').first().selectOption('event');
  await page.getByTestId('event-name').first().fill('pur');
  await page.getByTestId('value-suggestion').filter({ hasText: 'purchase' }).first().click();
  await expect(page.getByTestId('event-name').first()).toHaveValue('purchase');
  await page.getByTestId('preview-size').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  // (3) Event-attribute filter, autosuggesting the payload KEY and VALUE on focus:
  // sku = book (from the seeded purchase payload) → still the one match.
  await page.getByTestId('event-cond-add').click();
  await page.getByTestId('event-cond-field').click();
  await page.getByTestId('value-suggestion').filter({ hasText: 'sku' }).first().click();
  await expect(page.getByTestId('event-cond-field')).toHaveValue('sku');
  await page.getByTestId('event-cond-op').selectOption('=');
  await page.getByTestId('event-cond-value').click();
  await page.getByTestId('value-suggestion').filter({ hasText: 'book' }).first().click();
  await expect(page.getByTestId('event-cond-value')).toHaveValue('book');
  await page.getByTestId('preview-size').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  // A non-matching payload value yields zero.
  await page.getByTestId('event-cond-value').fill('nope');
  await page.getByTestId('preview-size').click();
  await expect(page.getByTestId('segment-size')).toContainText('0');
});

test('build a segment with a nested AND/OR group', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();
  await page.getByTestId('segment-name').fill('Nested group');

  // Root (AND): attributes.tier = vip  (matches a1, a2).
  await page.getByTestId('rule-field').first().fill('attributes.tier');
  await page.getByTestId('rule-operator').first().selectOption('=');
  await page.getByTestId('rule-value').first().fill('vip');
  await page.getByTestId('segment-combinator').selectOption('and');

  // Add a sub-group (OR): attributes.plan = pro  OR  attributes.tier = std.
  await page.getByTestId('add-group').click();
  const group = page.getByTestId('rule-group');
  await group.getByTestId('group-combinator').selectOption('or');
  await group.getByTestId('rule-field').first().fill('attributes.plan');
  await group.getByTestId('rule-operator').first().selectOption('=');
  await group.getByTestId('rule-value').first().fill('pro');
  await group.getByTestId('add-rule').click();
  await group.getByTestId('rule-field').nth(1).fill('attributes.tier');
  await group.getByTestId('rule-operator').nth(1).selectOption('=');
  await group.getByTestId('rule-value').nth(1).fill('std');

  // tier=vip AND (plan=pro OR tier=std) → only a2 matches.
  await page.getByTestId('preview-size').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  await page.getByTestId('save-segment').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Nested group');
});

test('create a MANUAL segment (CSV list) — no rule builder', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();

  await page.getByTestId('segment-name').fill('Hand picked');
  // Switch type to manual → the rule builder disappears, CSV box appears.
  await page.getByTestId('segment-type').selectOption('manual');
  await expect(page.getByTestId('rule-field')).toHaveCount(0);
  await expect(page.getByTestId('segment-combinator')).toHaveCount(0);
  await expect(page.getByTestId('csv-input')).toBeVisible();

  await page.getByTestId('csv-input').fill('a1@acme.com, a2@acme.com');
  await page.getByTestId('save-segment').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Hand picked');

  // The two emails resolved to members.
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-segment-filter').selectOption({ label: 'Hand picked' });
  await expect(page.getByTestId('profile-row')).toHaveCount(2);
});

test('edit a segment from the list: builder hydrates and the rename reflects', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();

  // Create a segment to edit (self-contained — does not touch seeded data).
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();
  await page.getByTestId('segment-name').fill('Seg To Edit');
  await page.getByTestId('rule-field').first().fill('attributes.tier');
  await page.getByTestId('rule-operator').first().selectOption('=');
  await page.getByTestId('rule-value').first().fill('std');
  await page.getByTestId('save-segment').click();
  await page.getByTestId('segments-list').waitFor();

  // Open it in the designated edit screen — the builder hydrates from its AST.
  await page
    .getByTestId('segment-list-item')
    .filter({ hasText: 'Seg To Edit' })
    .getByTestId('segment-edit')
    .click();
  await page.getByTestId('segment-builder').waitFor();
  await expect(page.getByTestId('segment-name')).toHaveValue('Seg To Edit');
  await expect(page.getByTestId('rule-field').first()).toHaveValue('attributes.tier');
  await expect(page.getByTestId('rule-value').first()).toHaveValue('std');

  // Rename and save → the list reflects the change.
  await page.getByTestId('segment-name').fill('Seg Edited');
  await page.getByTestId('save-segment').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Seg Edited');
});
