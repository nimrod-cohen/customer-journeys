// Unit: per-node CONFIG read/write serialization for the builder editors (§9B
// phase 6). PURE — imports the REAL runner validator so every emitted node is
// gated by production rules (no mock); the IF editor binds to the SAME @cdp
// ast-builder used by SegmentBuilder (no second AST path).
import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';
import { buildAstFromGroup, groupFromAst, emptyGroup, type RuleGroup } from '../segments/ast-builder.js';
import {
  parseDefinition,
  buildDefinition,
  defaultNodeConfig,
  type CampaignDefinition,
  type CanvasModel,
} from './model.js';
import {
  applyNodeConfig,
  writeTriggerConfig,
  readTriggerConfig,
  writeWaitConfig,
  readWaitSeconds,
  writeWaitUntilConfig,
  readWaitUntilInput,
  writeHourWindowConfig,
  readHourWindow,
  editorRowsToConditionAst,
  conditionAstToRows,
  writeConditionConfig,
  conditionGroupIsEmpty,
  writeSetAttributeConfig,
  readSetAttributeValue,
  writeWebhookConfig,
  readWebhookConfig,
  webhookSecretHeaders,
  sendNodeNeedsEmail,
} from './node-config.js';

// A model with one node per slot kind to test applyNodeConfig edge-preservation.
function modelWithCondition(): CanvasModel {
  const def: CampaignDefinition = {
    startNode: 'trigger',
    nodes: {
      trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
      cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'x' }, onTrue: 'a', onFalse: 'b' },
      a: { type: 'exit' },
      b: { type: 'exit' },
    },
  };
  return parseDefinition(def);
}

describe('applyNodeConfig', () => {
  it('returns a NEW model with the patched node and PRESERVES every edge slot', () => {
    const before = modelWithCondition();
    const after = applyNodeConfig(before, 'cond', {
      type: 'condition',
      ast: { field: 'attributes.plan', operator: '=', value: 'pro' },
    });
    expect(after).not.toBe(before);
    // Non-edge config updated:
    const def = buildDefinition(after);
    expect((def.nodes.cond as unknown as { ast: { field: string } }).ast.field).toBe('attributes.plan');
    // Edges preserved (onTrue/onFalse unchanged):
    expect((def.nodes.cond as unknown as { onTrue: string; onFalse: string }).onTrue).toBe('a');
    expect((def.nodes.cond as unknown as { onTrue: string; onFalse: string }).onFalse).toBe('b');
    expect(def.startNode).toBe('trigger');
  });

  it('does not mutate sibling nodes (referential immutability)', () => {
    const before = modelWithCondition();
    const triggerBefore = before.nodes.find((n) => n.id === 'trigger')!;
    const after = applyNodeConfig(before, 'cond', { type: 'condition', ast: { field: 'x', operator: 'exists' } });
    const triggerAfter = after.nodes.find((n) => n.id === 'trigger')!;
    expect(triggerAfter).toBe(triggerBefore); // same reference — untouched
  });
});

describe('WAIT', () => {
  it('writeWaitConfig produces {type:wait, delay:{seconds}} and normalizes non-positive to a minimum', () => {
    expect(writeWaitConfig(259200)).toEqual({ type: 'wait', delay: { seconds: 259200 } });
    expect(writeWaitConfig(0)).toEqual({ type: 'wait', delay: { seconds: 1 } });
    expect(writeWaitConfig(-5)).toEqual({ type: 'wait', delay: { seconds: 1 } });
  });

  it('round-trips a wait through a definition', () => {
    const model = parseDefinition({
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'manual', next: 'w' }, w: { type: 'wait', delay: { seconds: 60 }, next: 'x' }, x: { type: 'exit' } },
    });
    const patched = applyNodeConfig(model, 'w', writeWaitConfig(3 * 86400));
    const def = buildDefinition(patched);
    expect(readWaitSeconds(def.nodes.w!)).toBe(3 * 86400);
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });
});

describe('WAIT-UNTIL (workspace tz, DST-correct)', () => {
  const TZ = 'America/New_York';
  it('stores a UTC instant from a zoned wall-clock and round-trips to the same wall-clock', () => {
    const summer = '2026-07-01T09:00';
    const winter = '2026-01-01T09:00';
    const sNode = writeWaitUntilConfig(summer, TZ);
    const wNode = writeWaitUntilConfig(winter, TZ);
    // DST-correct: identical wall-clock → DIFFERENT UTC instants (EDT -4 vs EST -5).
    expect((sNode as unknown as { until: string }).until).not.toBe((wNode as unknown as { until: string }).until);
    expect((sNode as unknown as { until: string }).until).toBe('2026-07-01T13:00:00.000Z'); // 09:00 EDT = 13:00Z
    expect((wNode as unknown as { until: string }).until).toBe('2026-01-01T14:00:00.000Z'); // 09:00 EST = 14:00Z
    // Reading back renders the SAME wall-clock input.
    expect(readWaitUntilInput(sNode, TZ)).toBe(summer);
    expect(readWaitUntilInput(wNode, TZ)).toBe(winter);
  });
});

describe('HOUR-OF-DAY WINDOW', () => {
  it('stores integer hours, accepts overnight (start>end), omits days when none chosen', () => {
    const node = writeHourWindowConfig({ startHour: 22, endHour: 6, daysOfWeek: [] });
    expect(node).toEqual({ type: 'hour_of_day_window', startHour: 22, endHour: 6 });
    expect('daysOfWeek' in (node as object)).toBe(false);
  });

  it('stores a unique sorted subset of days when chosen and the runner accepts it', () => {
    const node = writeHourWindowConfig({ startHour: 9, endHour: 17, daysOfWeek: [5, 1, 1, 3] });
    expect((node as unknown as { daysOfWeek: number[] }).daysOfWeek).toEqual([1, 3, 5]);
    const def: CampaignDefinition = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'manual', next: 'h' }, h: { ...node, next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
    expect(readHourWindow(def.nodes.h!)).toMatchObject({ startHour: 9, endHour: 17, daysOfWeek: [1, 3, 5] });
  });
});

describe('IF / condition', () => {
  it('editorRowsToConditionAst === buildAstFromGroup (same ast-builder, no second path)', () => {
    const group: RuleGroup = { combinator: 'and', rows: [{ kind: 'field', field: 'attributes.tier', operator: '=', value: 'vip' }], groups: [] };
    expect(editorRowsToConditionAst(group)).toEqual(buildAstFromGroup(group));
  });

  it('emits {type:condition, ast} that validateAst accepts; an empty group is blocked', () => {
    const group: RuleGroup = { combinator: 'and', rows: [{ kind: 'field', field: 'attributes.tier', operator: '=', value: 'vip' }], groups: [] };
    const node = writeConditionConfig(group)!;
    expect(node).toMatchObject({ type: 'condition' });
    expect((node as unknown as { ast: unknown }).ast).toBeTruthy();
    // empty → null (the editor blocks save) and conditionGroupIsEmpty agrees.
    const empty: RuleGroup = { combinator: 'and', rows: [{ kind: 'field', field: '', operator: '=', value: '' }], groups: [] };
    expect(writeConditionConfig(empty)).toBeNull();
    expect(conditionGroupIsEmpty(empty)).toBe(true);
    expect(conditionGroupIsEmpty(group)).toBe(false);
  });

  it('includes a trimmed `label` only when non-blank (cosmetic branch name)', () => {
    const group: RuleGroup = { combinator: 'and', rows: [{ kind: 'field', field: 'attributes.tier', operator: '=', value: 'vip' }], groups: [] };
    // No name / blank → no label key.
    expect(writeConditionConfig(group)).not.toHaveProperty('label');
    expect(writeConditionConfig(group, '   ')).not.toHaveProperty('label');
    // A name is trimmed and carried.
    expect(writeConditionConfig(group, '  VIP?  ')).toMatchObject({ type: 'condition', label: 'VIP?' });
  });

  it('round-trip: conditionAstToRows(ast) → re-compile is structurally equal', () => {
    const group: RuleGroup = {
      combinator: 'or',
      rows: [
        { kind: 'field', field: 'attributes.tier', operator: '=', value: 'vip' },
        { kind: 'field', field: 'email_status', operator: '=', value: 'active' },
      ],
      groups: [],
    };
    const ast = buildAstFromGroup(group)!;
    const rehydrated = conditionAstToRows(ast);
    expect(groupFromAst(ast)).toEqual(rehydrated);
    expect(buildAstFromGroup(rehydrated)).toEqual(ast);
  });
});

describe('UPDATE-PROFILE (set_attribute value spec) — LIST of assignments', () => {
  it('writes an assignments[] LIST; literal/expression/js modes; validates through the runner', () => {
    const node = writeSetAttributeConfig({
      rows: [
        { key: 'stage', mode: 'literal', literal: 'lead', expression: '', js: '' },
        { key: 'last_sku', mode: 'expression', literal: '', expression: '{{event.sku}}', js: '' },
        { key: 'greeting', mode: 'js', literal: '', expression: '', js: 'return customer.first_name.toUpperCase()' },
      ],
    });
    expect(node).toMatchObject({
      type: 'action',
      kind: 'set_attribute',
      assignments: [
        { key: 'stage', value: { kind: 'literal', value: 'lead' } },
        { key: 'last_sku', value: { kind: 'expression', expression: '{{event.sku}}' } },
        { key: 'greeting', value: { kind: 'js', code: 'return customer.first_name.toUpperCase()' } },
      ],
    });
    const def: CampaignDefinition = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'manual', next: 'a' }, a: { ...node, next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('drops empty-key rows; an all-empty list is structurally rejected by the runner', () => {
    const node = writeSetAttributeConfig({
      rows: [
        { key: '', mode: 'literal', literal: 'x', expression: '', js: '' },
        { key: 'tier', mode: 'literal', literal: 'gold', expression: '', js: '' },
      ],
    });
    expect((node as unknown as { assignments: unknown[] }).assignments).toHaveLength(1);
    const def: CampaignDefinition = {
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'manual', next: 'a' }, a: { ...node, next: 'x' }, x: { type: 'exit' } },
    };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('reads assignments[] back to rows with the right mode (literal/expression/js)', () => {
    const form = readSetAttributeValue({
      type: 'action',
      kind: 'set_attribute',
      assignments: [
        { key: 'a', value: { kind: 'literal', value: 'gold' } },
        { key: 'b', value: { kind: 'expression', expression: '{{customer.tier}}' } },
        { key: 'c', value: { kind: 'js', code: 'return 1' } },
      ],
    });
    expect(form.rows).toEqual([
      { key: 'a', mode: 'literal', literal: 'gold', expression: '', js: '' },
      { key: 'b', mode: 'expression', literal: '', expression: '{{customer.tier}}', js: '' },
      { key: 'c', mode: 'js', literal: '', expression: '', js: 'return 1' },
    ]);
  });

  it('reads a LEGACY single key/value back into a 1-row list (back-compat)', () => {
    expect(readSetAttributeValue({ type: 'action', kind: 'set_attribute', key: 'k', value: { kind: 'expression', expression: '{{customer.tier}}' } }).rows)
      .toEqual([{ key: 'k', mode: 'expression', literal: '', expression: '{{customer.tier}}', js: '' }]);
    expect(readSetAttributeValue({ type: 'action', kind: 'set_attribute', key: 'k', value: 'vip' }).rows)
      .toEqual([{ key: 'k', mode: 'literal', literal: 'vip', expression: '', js: '' }]);
  });

  it('an empty node reads as a single blank row (the editor starts with one)', () => {
    expect(readSetAttributeValue({ type: 'action', kind: 'set_attribute' }).rows).toEqual([
      { key: '', mode: 'literal', literal: '', expression: '', js: '' },
    ]);
  });
});

describe('WEBHOOK', () => {
  it('emits a valid action webhook; accepts http(s); rejects bad url/timeout/retries', () => {
    const ok = writeWebhookConfig({
      url: 'https://hooks.example.com/x',
      method: 'POST',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyTemplate: '{"id":"{{customer.email}}"}',
      timeoutMs: '5000',
      maxRetries: '2',
      secret: '',
      secretHeader: '',
      hasSecret: false,
    });
    expect(ok.error).toBeNull();
    expect(ok.node).toMatchObject({ type: 'action', kind: 'webhook', url: 'https://hooks.example.com/x', method: 'POST', timeoutMs: 5000, maxRetries: 2 });
    expect(writeWebhookConfig({ ...base(), url: 'ftp://x' }).error).toMatch(/http/i);
    expect(writeWebhookConfig({ ...base(), url: 'not a url' }).error).toMatch(/valid/i);
    expect(writeWebhookConfig({ ...base(), timeoutMs: '0' }).error).toMatch(/timeout/i);
    expect(writeWebhookConfig({ ...base(), maxRetries: '-1' }).error).toMatch(/retr/i);
  });

  it('write-only secret: a stored Authorization header is NOT echoed back; preserved on a save that did not re-type it', () => {
    // A node persisted WITH a secret auth header.
    const persisted = writeWebhookConfig(
      { url: 'https://h.example.com', method: 'POST', headers: [], bodyTemplate: '', timeoutMs: '', maxRetries: '', secret: 'Bearer s3cr3t', secretHeader: 'Authorization', hasSecret: false },
    ).node!;
    // Reading hides the value but flags hasSecret + remembers the header NAME.
    const form = readWebhookConfig(persisted);
    expect(form.secret).toBe('');
    expect(form.hasSecret).toBe(true);
    expect(form.secretHeader).toBe('Authorization');
    // Re-saving WITHOUT re-typing the secret preserves the prior header verbatim.
    const resaved = writeWebhookConfig({ ...form, secret: '' }, webhookSecretHeaders(persisted)).node!;
    expect((resaved as unknown as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer s3cr3t');
  });

  function base() {
    return { url: 'https://ok.example.com', method: 'POST' as const, headers: [], bodyTemplate: '', timeoutMs: '', maxRetries: '', secret: '', secretHeader: '', hasSecret: false };
  }
});

describe('TRIGGER', () => {
  it('event → {kind:event, eventType, filter?}; manual → {kind:manual}; segment_entry omits the segment id', () => {
    expect(writeTriggerConfig({ kind: 'event', eventType: 'purchase' })).toEqual({ type: 'trigger', kind: 'event', eventType: 'purchase' });
    expect(writeTriggerConfig({ kind: 'manual' })).toEqual({ type: 'trigger', kind: 'manual' });
    const seg = writeTriggerConfig({ kind: 'segment_entry' });
    expect(seg).toEqual({ type: 'trigger', kind: 'segment_entry' });
    expect('trigger_segment_id' in (seg as object)).toBe(false);
    expect('segment_id' in (seg as object)).toBe(false);
  });

  it('an event trigger with a payload filter validates through the runner', () => {
    const filter = buildAstFromGroup({ combinator: 'and', rows: [{ kind: 'field', field: 'payload.interest', operator: '=', value: 'webinar' }], groups: [] })!;
    const node = { ...writeTriggerConfig({ kind: 'event', eventType: 'lead', filter: filter as never }), next: 'x' };
    const def: CampaignDefinition = { startNode: 't', nodes: { t: node as never, x: { type: 'exit' } } };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('carries an optional trimmed non-blank `label` (cosmetic) and reads it back', () => {
    expect(writeTriggerConfig({ kind: 'manual' })).not.toHaveProperty('label');
    expect(writeTriggerConfig({ kind: 'manual', label: '   ' })).not.toHaveProperty('label');
    expect(writeTriggerConfig({ kind: 'manual', label: '  New VIPs  ' })).toMatchObject({ type: 'trigger', kind: 'manual', label: 'New VIPs' });
    expect(writeTriggerConfig({ kind: 'event', eventType: 'purchase', label: 'Bought' })).toMatchObject({ kind: 'event', eventType: 'purchase', label: 'Bought' });
    // read back
    expect(readTriggerConfig({ type: 'trigger', kind: 'manual', label: 'New VIPs' }).label).toBe('New VIPs');
    expect(readTriggerConfig({ type: 'trigger', kind: 'manual' }).label).toBeUndefined();
  });
});

describe('SEND default (placeholder removed)', () => {
  it("defaultNodeConfig('send') has NO 'placeholder' template_id and reads as needing an email", () => {
    const node = defaultNodeConfig('send');
    expect((node as { template_id?: string }).template_id ?? '').not.toBe('placeholder');
    expect(sendNodeNeedsEmail(node)).toBe(true);
  });
});

// silence unused import lint when emptyGroup goes unused in a refactor
void emptyGroup;
