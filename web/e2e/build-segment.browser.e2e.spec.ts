// E2E (real Chromium): the Segments list → designated builder flow (§12). The
// builder is an edit page: the members panel on the right refreshes ONLY on entry
// and on SAVE (never on every keystroke), and saving stays on the page. "← Back to
// segments" returns to the list, which re-fetches and shows the change.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers.js';
import { DEV_MKT } from './seed.js';

test('the customer.* shorthand resolves like attributes.* in a segment rule (§11)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();

  await page.getByTestId('segment-name').fill('VIPs (shorthand)');
  // `customer.tier` is shorthand for `attributes.tier` — the server expands it.
  await page.getByTestId('rule-field').first().fill('customer.tier');
  await page.getByTestId('rule-operator').first().selectOption('=');
  // Value autocomplete still works on the shorthand (resolves to the attribute).
  await page.getByTestId('rule-value').first().click();
  await page.getByTestId('value-suggestion').filter({ hasText: 'vip' }).first().click();
  await expect(page.getByTestId('rule-value').first()).toHaveValue('vip');

  // Same two seeded VIPs as the explicit attributes.tier rule.
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('2');
  await expect(page.getByTestId('member-preview-row')).toHaveCount(2);
});

test('create a dynamic segment, save, and see its members + the list', async ({ page }) => {
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

  // Members only resolve on SAVE. Two seeded VIPs in WS_A; WS_B's profile excluded.
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('2');
  await expect(page.getByTestId('member-preview-row')).toHaveCount(2);

  // Back to the list, which re-fetches and shows the new segment.
  await page.getByTestId('segments-back').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('VIP members');

  // The membership is materialized: a1 (a VIP) now shows 'VIP members' on its
  // profile's Segments tab — consistent with the builder's members panel.
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('profile-explorer').waitFor();
  await page.getByTestId('profile-search').fill('a1@acme.com');
  await page.getByTestId('profile-row').first().click();
  await page.getByTestId('profile-detail').waitFor();
  await page.getByTestId('tab-segments').click();
  await expect(page.getByTestId('profile-segment-row').filter({ hasText: 'VIP members' })).toHaveCount(1);
});

test('segment by the unsubscribed attribute and by an event (count refreshes on save)', async ({ page }) => {
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
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  // (2) Switch to an EVENT rule and AUTOSUGGEST the event name: typing "pur"
  // surfaces "purchase" (a1 has one).
  await page.getByTestId('rule-kind').first().selectOption('event');
  await page.getByTestId('event-name').first().fill('pur');
  await page.getByTestId('value-suggestion').filter({ hasText: 'purchase' }).first().click();
  await expect(page.getByTestId('event-name').first()).toHaveValue('purchase');
  await page.getByTestId('save-segment').click();
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
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  // A non-matching payload value yields zero (after saving).
  await page.getByTestId('event-cond-value').fill('nope');
  await page.getByTestId('save-segment').click();
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

  // tier=vip AND (plan=pro OR tier=std) → only a2 matches (after save).
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  await page.getByTestId('segments-back').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Nested group');
});

test('create a MANUAL segment (CSV list) — no rule builder; members show after save', async ({ page }) => {
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
  // Saving imports the emails and the members panel refreshes with the 2 members.
  await expect(page.getByTestId('member-preview-row')).toHaveCount(2);

  await page.getByTestId('segments-back').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Hand picked');
});

test('deleting the root rule leaves an inactive draft segment', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();
  await page.getByTestId('segment-name').fill('Draft seg');

  // The lone root rule is now deletable → no rules left → inactive draft.
  await page.getByTestId('rule-remove').click();
  await expect(page.getByTestId('rule-row')).toHaveCount(0);
  await expect(page.getByTestId('segment-draft-note')).toBeVisible();
  await expect(page.getByTestId('segment-size')).toContainText('Draft');

  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-draft-note')).toBeVisible();

  await page.getByTestId('segments-back').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Draft seg');
});

test('event rule with a time window (occurred within last N days)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();
  await page.getByTestId('segment-name').fill('Recent buyers');

  // Event rule: purchase OCCURRED, within a time window. a1's seeded purchase is
  // dated 2026-02-01 (months ago), so a tight window matches no one.
  await page.getByTestId('rule-kind').first().selectOption('event');
  await page.getByTestId('event-name').first().fill('purchase');
  await page.getByTestId('event-window').selectOption('within');
  await page.getByTestId('event-window-days').fill('7');
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('0');

  // A wide window includes the old purchase → a1 matches.
  await page.getByTestId('event-window-days').fill('36500');
  await page.getByTestId('save-segment').click();
  await expect(page.getByTestId('segment-size')).toContainText('1');

  // "did not occur within 7 days" is the dual — a1 (no recent purchase) is included.
  await page.getByTestId('event-op').first().selectOption('not_occurred');
  await page.getByTestId('event-window-days').fill('7');
  await page.getByTestId('save-segment').click();
  // At least a1; exact count depends on workspace size, so assert a1 is present.
  await expect(page.getByTestId('member-preview-row').filter({ hasText: 'a1@acme.com' })).toHaveCount(1);
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
  await expect(page.getByTestId('segment-size')).toContainText('1');
  await page.getByTestId('segments-back').click();
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

  // Rename and save → back on the list, the rename reflects.
  await page.getByTestId('segment-name').fill('Seg Edited');
  await page.getByTestId('save-segment').click();
  await page.getByTestId('segments-back').click();
  await page.getByTestId('segments-list').waitFor();
  await expect(page.getByTestId('segment-list')).toContainText('Seg Edited');
});

test('unsaved edits gate leaving the builder (cancel stays, discard leaves)', async ({ page }) => {
  await loginAs(page, DEV_MKT);
  await page.getByTestId('nav-segments').click();
  await page.getByTestId('segments-list').waitFor();
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();

  // A pristine (untouched) builder does NOT prompt — leaving goes straight back.
  await page.getByTestId('segments-back').click();
  await page.getByTestId('segments-list').waitFor();

  // Re-enter and make an edit → now dirty.
  await page.getByTestId('new-segment').click();
  await page.getByTestId('segment-builder').waitFor();
  await page.getByTestId('segment-name').fill('Unsaved seg');
  await page.getByTestId('rule-field').first().fill('attributes.tier');

  // Back button → discard dialog. Cancel → we stay on the builder.
  await page.getByTestId('segments-back').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-cancel').click();
  await expect(page.getByTestId('segment-builder')).toBeVisible();
  await expect(page.getByTestId('segment-name')).toHaveValue('Unsaved seg');

  // Sidebar navigation is gated too. Cancel again → still on the builder.
  await page.getByTestId('nav-profiles').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-cancel').click();
  await expect(page.getByTestId('segment-builder')).toBeVisible();

  // Confirm discard → the navigation proceeds.
  await page.getByTestId('segments-back').click();
  await page.getByTestId('app-dialog').waitFor();
  await page.getByTestId('dialog-confirm').click();
  await page.getByTestId('segments-list').waitFor();
});
