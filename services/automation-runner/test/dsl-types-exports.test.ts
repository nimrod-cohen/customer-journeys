// The new DSL node types (hour_of_day_window node + webhook action shape) must be
// part of the public model: importable from ./dsl.js, re-exported via index.ts, and
// included in the Node union so the builder + runner narrow on them. This file is a
// runtime-importable shape guard (the type imports double as a strict tsc -b gate).
import { describe, it, expect } from 'vitest';
import {
  validateAutomationDefinition,
  type AutomationDefinition,
  type HourOfDayWindowNode,
  type WebhookAction,
  type Node,
} from '../src/dsl.js';
// Re-export barrel: the same symbols must be reachable from the package entrypoint
// (web's automation builder imports validateAutomationDefinition from here).
import * as pkg from '../src/index.js';

describe('DSL type exports', () => {
  it('re-exports validateAutomationDefinition from the package barrel', () => {
    expect(typeof pkg.validateAutomationDefinition).toBe('function');
  });

  it('builds an hour_of_day_window literal that narrows to the Node union and validates', () => {
    const win: HourOfDayWindowNode = {
      type: 'hour_of_day_window',
      startHour: 9,
      endHour: 17,
      daysOfWeek: [1, 2, 3, 4, 5],
      next: 'a',
    };
    const asNode: Node = win; // compile-time guard: it is part of the union
    expect(asNode.type).toBe('hour_of_day_window');

    const def: AutomationDefinition = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'win' },
        win,
        a: { type: 'action', kind: 'send', template_id: 'tpl-1', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });

  it('builds a webhook action literal that narrows to the Node union and validates', () => {
    const hook: WebhookAction = {
      type: 'action',
      kind: 'webhook',
      url: 'https://hooks.example.com/x',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      bodyTemplate: '{"email":"{{customer.email}}"}',
      timeoutMs: 5000,
      maxRetries: 2,
      next: 'x',
    };
    const asNode: Node = hook;
    expect(asNode.type).toBe('action');

    const def: AutomationDefinition = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'h' },
        h: hook,
        x: { type: 'exit' },
      },
    };
    // The webhook contributes [next] to reachability — the exit stays reachable.
    expect(() => validateAutomationDefinition(def)).not.toThrow();
  });
});
