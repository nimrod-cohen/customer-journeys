// Unit: a node configured by the editors serializes into the definition and
// round-trips (§9B phase 6). Uses the REAL runner validator. Pure.
import { describe, it, expect } from 'vitest';
import { validateAutomationDefinition } from '@cdp/service-automation-runner';
import { buildAstFromGroup } from '../segments/ast-builder.js';
import { parseDefinition, buildDefinition, type AutomationDefinition } from './model.js';
import {
  applyNodeConfig,
  writeWaitConfig,
  writeWaitUntilConfig,
  writeHourWindowConfig,
  writeConditionConfig,
  writeSetAttributeConfig,
  writeWebhookConfig,
  writeTriggerConfig,
} from './node-config.js';

const TZ = 'UTC';

describe('per-node serialize → parse round-trip', () => {
  it('a full multi-node journey configured node-by-node round-trips and validates', () => {
    // trigger → wait → condition → (send | set_attribute) → exit, all configured.
    let model = parseDefinition({
      startNode: 'trigger',
      nodes: {
        trigger: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 1 }, next: 'c' },
        c: { type: 'condition', ast: { field: 'x', operator: 'exists' }, onTrue: 's', onFalse: 'u' },
        s: { type: 'action', kind: 'send', template_id: 'tpl', next: 'e1' },
        u: { type: 'action', kind: 'set_attribute', key: 'stage', value: 'x', next: 'e2' },
        e1: { type: 'exit' },
        e2: { type: 'exit' },
      },
    });

    model = applyNodeConfig(model, 'trigger', writeTriggerConfig({ kind: 'manual' }));
    model = applyNodeConfig(model, 'w', writeWaitConfig(2 * 86400));
    const condGroup = { combinator: 'and' as const, rows: [{ kind: 'field' as const, field: 'attributes.tier', operator: '=' as const, value: 'vip' }], groups: [] };
    model = applyNodeConfig(model, 'c', writeConditionConfig(condGroup)!);
    model = applyNodeConfig(model, 'u', writeSetAttributeConfig({ rows: [{ key: 'stage', mode: 'literal', literal: 'won', expression: '', js: '' }] }));

    const def = buildDefinition(model);
    expect(() => validateAutomationDefinition(def)).not.toThrow();

    // Re-parse → re-build is identity (the round-trip).
    const rebuilt = buildDefinition(parseDefinition(def));
    expect(rebuilt).toEqual(def);

    // Edges preserved through the config edits.
    expect((def.nodes.c as unknown as { onTrue: string; onFalse: string })).toMatchObject({ onTrue: 's', onFalse: 'u' });
    expect((def.nodes.w as unknown as { next: string }).next).toBe('c');
  });

  it('each editor-emitted node, once edged, round-trips structurally', () => {
    const samples: Record<string, ReturnType<typeof writeWaitConfig>> = {
      wait: writeWaitConfig(3600),
      waitUntil: writeWaitUntilConfig('2030-01-01T08:00', TZ),
      hour: writeHourWindowConfig({ openMin: 8 * 60, closeMin: 20 * 60, daysOfWeek: [1, 2, 3, 4, 5] }),
      setAttr: writeSetAttributeConfig({ rows: [{ key: 'k', mode: 'expression', literal: '', expression: '{{customer.tier}}', js: '' }] }),
      webhook: writeWebhookConfig({ url: 'https://h.example.com', method: 'PUT', headers: [{ name: 'X-A', value: '1' }], bodyTemplate: '{}', timeoutMs: '3000', maxRetries: '1', secret: '', secretHeader: '', hasSecret: false }).node!,
    };
    for (const [id, node] of Object.entries(samples)) {
      const def: AutomationDefinition = {
        startNode: 't',
        nodes: { t: { type: 'trigger', kind: 'manual', next: id }, [id]: { ...node, next: 'x' }, x: { type: 'exit' } },
      };
      expect(() => validateAutomationDefinition(def), id).not.toThrow();
      expect(buildDefinition(parseDefinition(def))).toEqual(def);
    }
  });

  it('condition node carries the SAME ast the ast-builder emits', () => {
    const group = { combinator: 'and' as const, rows: [{ kind: 'field' as const, field: 'attributes.plan', operator: '=' as const, value: 'pro' }], groups: [] };
    const node = writeConditionConfig(group)!;
    expect((node as unknown as { ast: unknown }).ast).toEqual(buildAstFromGroup(group));
  });
});
