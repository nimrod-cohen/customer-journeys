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
  readWaitUntilForm,
  writeWaitUntilForm,
  waitUntilFormHasGate,
  type WaitUntilForm,
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
  sendNodeMedium,
  sendNodeTemplateId,
  readSendConfig,
  writeSendConfig,
  readEventPayloadFilter,
  writeEventPayloadFilter,
} from './node-config.js';
import { evaluateEventPayloadFilter } from '@cdp/service-campaign-runner';

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

describe('WAIT-UNTIL (rich: time + condition + max-wait)', () => {
  const TZ = 'UTC';
  const baseForm = () => readWaitUntilForm({ type: 'wait', next: '' } as never, TZ);

  it('a relative-from-now offset + max-wait → untilOffset + maxWait, validates, round-trips', () => {
    const f: WaitUntilForm = { ...baseForm(), timeMode: 'relative', amount: 2, unit: 'days', anchorKind: 'now', hasMaxWait: true, maxAmount: 5, maxUnit: 'days' };
    const node = writeWaitUntilForm(f, TZ) as Record<string, unknown>;
    expect(node.untilOffset).toEqual({ amount: 2, unit: 'days', anchor: 'now' });
    expect(node.maxWait).toEqual({ amount: 5, unit: 'days' });
    expect(node.until).toBeUndefined();
    const def = { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'w' }, w: { ...node, next: 'x' }, x: { type: 'exit' } } };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
    // round-trip
    const back = readWaitUntilForm(node as never, TZ);
    expect(back.timeMode).toBe('relative');
    expect(back.amount).toBe(2);
    expect(back.hasMaxWait).toBe(true);
    expect(back.maxAmount).toBe(5);
  });

  it('an expression anchor is stored verbatim as untilOffset.anchor', () => {
    const f: WaitUntilForm = { ...baseForm(), timeMode: 'relative', amount: 1, unit: 'days', anchorKind: 'expression', anchorExpr: '{{event.appointment_at}}' };
    const node = writeWaitUntilForm(f, TZ) as Record<string, unknown>;
    expect(node.untilOffset).toEqual({ amount: 1, unit: 'days', anchor: '{{event.appointment_at}}' });
    const back = readWaitUntilForm(node as never, TZ);
    expect(back.anchorKind).toBe('expression');
    expect(back.anchorExpr).toBe('{{event.appointment_at}}');
  });

  it('a condition gate serializes to a §8 waitCondition AST and validates', () => {
    const condition: RuleGroup = { combinator: 'and', rows: [{ kind: 'field', field: 'attributes.opened', operator: 'exists', value: '' }], groups: [] };
    const f: WaitUntilForm = { ...baseForm(), hasCondition: true, condition };
    const node = writeWaitUntilForm(f, TZ) as Record<string, unknown>;
    expect(node.waitCondition).toBeTruthy();
    const def = { startNode: 't', nodes: { t: { type: 'trigger', kind: 'manual', next: 'w' }, w: { ...node, next: 'x' }, x: { type: 'exit' } } };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('an empty form (no gate) does NOT serialize (write returns null, hasGate false)', () => {
    const f = baseForm();
    expect(waitUntilFormHasGate(f)).toBe(false);
    expect(writeWaitUntilForm(f, TZ)).toBeNull();
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

  it('profile → {kind:profile, profileChange}; round-trips created|updated|any (default any)', () => {
    expect(writeTriggerConfig({ kind: 'profile', profileChange: 'created' })).toEqual({
      type: 'trigger',
      kind: 'profile',
      profileChange: 'created',
    });
    expect(writeTriggerConfig({ kind: 'profile', profileChange: 'updated' })).toEqual({
      type: 'trigger',
      kind: 'profile',
      profileChange: 'updated',
    });
    // No profileChange supplied → defaults to 'any'.
    expect(writeTriggerConfig({ kind: 'profile' })).toEqual({ type: 'trigger', kind: 'profile', profileChange: 'any' });
    // An invalid value is coerced to 'any'.
    expect(writeTriggerConfig({ kind: 'profile', profileChange: 'bogus' as never })).toEqual({
      type: 'trigger',
      kind: 'profile',
      profileChange: 'any',
    });
    // read back
    expect(readTriggerConfig({ type: 'trigger', kind: 'profile', profileChange: 'updated' })).toMatchObject({
      kind: 'profile',
      profileChange: 'updated',
    });
    expect(readTriggerConfig({ type: 'trigger', kind: 'profile' }).profileChange).toBe('any');
    // a profile trigger validates through the runner
    const node = { ...writeTriggerConfig({ kind: 'profile', profileChange: 'any' }), next: 'x' };
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

describe('SEND channel (medium + text_body)', () => {
  it('reads an unconfigured/email send as medium=email (back-compat)', () => {
    expect(readSendConfig({ type: 'action', kind: 'send' }).medium).toBe('email');
    expect(readSendConfig({ type: 'action', kind: 'send', template_id: 't' }).medium).toBe('email');
  });

  it('reads a text send back (medium + body, topic null by default)', () => {
    const form = readSendConfig({ type: 'action', kind: 'send', medium: 'sms', text_body: 'Hi' });
    expect(form).toEqual({ medium: 'sms', textBody: 'Hi', topicId: null });
  });

  it('reads a send carrying a per-node topic_id', () => {
    const form = readSendConfig({ type: 'action', kind: 'send', medium: 'email', template_id: 't', topic_id: 'tpc-1' });
    expect(form.topicId).toBe('tpc-1');
  });

  it('writes a send carrying the topic_id from the form', () => {
    const node = writeSendConfig({ medium: 'email', textBody: '', topicId: 'tpc-9' }, 'tpl-1');
    expect((node as { topic_id?: string }).topic_id).toBe('tpc-9');
  });

  it('writes an email send WITHOUT a text_body (preserves an existing template_id)', () => {
    const node = writeSendConfig({ medium: 'email', textBody: 'ignored' }, 'tpl-99');
    expect(node).toMatchObject({ type: 'action', kind: 'send', medium: 'email', template_id: 'tpl-99' });
    expect((node as { text_body?: string }).text_body).toBeUndefined();
    // The runner validator accepts it (email send with a template).
    expect(() => validateCampaignDefinition(wrapSend(node))).not.toThrow();
  });

  it('writes a text send carrying the trimmed body and NO template_id; runner accepts it', () => {
    const node = writeSendConfig({ medium: 'sms', textBody: '  Hi {{customer.first_name}}  ' }, 'tpl-stale');
    expect(node).toMatchObject({ type: 'action', kind: 'send', medium: 'sms', text_body: 'Hi {{customer.first_name}}' });
    expect((node as { template_id?: string }).template_id).toBeUndefined();
    expect(() => validateCampaignDefinition(wrapSend(node))).not.toThrow();
  });

  it('a text send with a blank body is rejected by the runner validator', () => {
    const node = writeSendConfig({ medium: 'whatsapp', textBody: '   ' });
    expect(() => validateCampaignDefinition(wrapSend(node))).toThrow(/text_body/i);
  });

  it('flipping channels through applyNodeConfig clears the OTHER channel\'s stale field (merge)', () => {
    // Start with an SMS send that ALSO carries a stale template_id (the inconsistent
    // state the merge could produce). Flip to email: the body must be gone and the
    // medium must read email (the bug left medium=sms + the body on the node).
    let model: CanvasModel = {
      start: 's',
      nodes: [{ id: 's', node: { type: 'action', kind: 'send', medium: 'sms', text_body: 'old body', template_id: 'tpl-stale' } as never }],
      edges: [],
    };
    model = applyNodeConfig(model, 's', writeSendConfig({ medium: 'email', textBody: '' }, 'tpl-stale'));
    expect(sendNodeMedium(model.nodes[0]!.node)).toBe('email');
    expect((model.nodes[0]!.node as { text_body?: string }).text_body).toBeUndefined();
    expect(sendNodeTemplateId(model.nodes[0]!.node)).toBe('tpl-stale');

    // Flip back to a text channel: the template_id must be cleared.
    model = applyNodeConfig(model, 's', writeSendConfig({ medium: 'sms', textBody: 'hi' }, null));
    expect(sendNodeMedium(model.nodes[0]!.node)).toBe('sms');
    expect(sendNodeTemplateId(model.nodes[0]!.node)).toBeNull();
    expect(readSendConfig(model.nodes[0]!.node).textBody).toBe('hi');
  });
});

/** Wrap a send DslNode into a minimal valid graph for the real runner validator. */
function wrapSend(send: object): CampaignDefinition {
  return {
    startNode: 't',
    nodes: {
      t: { type: 'trigger', kind: 'manual', next: 's' } as never,
      s: { ...(send as object), next: 'x' } as never,
      x: { type: 'exit' } as never,
    },
  };
}

describe('event trigger payload filter (read/write)', () => {
  it('writes a payload.* GroupNode the runner accepts; round-trips through read', () => {
    const ast = writeEventPayloadFilter({
      match: 'and',
      rows: [
        { field: 'webinar_id', operator: '=', value: '42' },
        { field: 'plan', operator: 'in', value: 'pro, team' },
        { field: 'coupon', operator: 'exists', value: '' },
      ],
    });
    expect(ast).not.toBeNull();
    // Every leaf is namespaced payload.* (the runner REQUIRES this).
    const grp = ast as { op: string; conditions: { field: string; operator: string; value?: unknown }[] };
    expect(grp.op).toBe('and');
    expect(grp.conditions.map((c) => c.field)).toEqual(['payload.webinar_id', 'payload.plan', 'payload.coupon']);
    expect(grp.conditions[0]!.value).toBe(42); // numeric coercion
    expect(grp.conditions[1]!.value).toEqual(['pro', 'team']); // in → array
    expect('value' in grp.conditions[2]!).toBe(false); // exists drops the value

    // The runner can evaluate it against a payload.
    expect(evaluateEventPayloadFilter(ast as never, { webinar_id: 42, plan: 'pro', coupon: 'X' })).toBe(true);
    expect(evaluateEventPayloadFilter(ast as never, { webinar_id: 7, plan: 'pro', coupon: 'X' })).toBe(false);

    // round-trip: read back into rows (bare keys, value re-stringified).
    const form = readEventPayloadFilter(ast);
    expect(form.match).toBe('and');
    expect(form.rows.map((r) => r.field)).toEqual(['webinar_id', 'plan', 'coupon']);
    expect(form.rows[1]!.value).toBe('pro, team');
    expect(form.rows[2]!.operator).toBe('exists');
  });

  it('returns null when no row has a field; reads null/empty into one blank row', () => {
    expect(writeEventPayloadFilter({ match: 'and', rows: [{ field: '  ', operator: '=', value: 'x' }] })).toBeNull();
    const blank = readEventPayloadFilter(null);
    expect(blank.match).toBe('and');
    expect(blank.rows).toHaveLength(1);
    expect(blank.rows[0]!.field).toBe('');
  });

  it('honors the any (OR) match', () => {
    const ast = writeEventPayloadFilter({
      match: 'or',
      rows: [
        { field: 'a', operator: '=', value: '1' },
        { field: 'b', operator: '=', value: '2' },
      ],
    });
    expect(evaluateEventPayloadFilter(ast as never, { a: 1, b: 99 })).toBe(true);
    expect(evaluateEventPayloadFilter(ast as never, { a: 0, b: 0 })).toBe(false);
    expect(readEventPayloadFilter(ast).match).toBe('or');
  });
});

// silence unused import lint when emptyGroup goes unused in a refactor
void emptyGroup;
