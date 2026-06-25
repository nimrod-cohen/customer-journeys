import { describe, it, expect } from 'vitest';
import {
  validateCampaignDefinition,
  resolveStartNode,
  findNode,
  type CampaignDefinition,
} from '../src/dsl.js';

// §9B — node DSL + structural validation. One trigger, unique ids, resolvable
// edges, a reachable exit, per-type required fields.

function validDef(): CampaignDefinition {
  return {
    startNode: 't',
    nodes: {
      t: { type: 'trigger', kind: 'segment_entry', next: 'w' },
      w: { type: 'wait', delay: { seconds: 60 }, next: 'c' },
      c: {
        type: 'condition',
        ast: { field: 'total_events', operator: '>=', value: 1 },
        onTrue: 'a',
        onFalse: 'x',
      },
      a: { type: 'action', kind: 'send', template_id: 'tpl-1', next: 'x' },
      x: { type: 'exit' },
    },
  };
}

describe('validateCampaignDefinition', () => {
  it('accepts a well-formed definition', () => {
    expect(() => validateCampaignDefinition(validDef())).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateCampaignDefinition(null)).toThrow();
    expect(() => validateCampaignDefinition(42)).toThrow();
  });

  it('rejects a missing/empty startNode', () => {
    const d = validDef() as { startNode: string };
    expect(() => validateCampaignDefinition({ ...d, startNode: '' })).toThrow(/startNode/);
  });

  it('rejects an empty nodes map', () => {
    expect(() => validateCampaignDefinition({ startNode: 't', nodes: {} })).toThrow(/non-empty/);
  });

  it('requires exactly one trigger', () => {
    const d = validDef();
    const two = {
      ...d,
      nodes: { ...d.nodes, t2: { type: 'trigger', kind: 'manual', next: 'x' } },
    };
    expect(() => validateCampaignDefinition(two)).toThrow(/exactly one trigger/);

    const zero = {
      startNode: 'w',
      nodes: {
        w: { type: 'wait', delay: { seconds: 1 }, next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(zero)).toThrow(/exactly one trigger/);
  });

  it('rejects an unresolvable edge', () => {
    const d = validDef();
    const broken = {
      ...d,
      nodes: {
        ...d.nodes,
        t: { type: 'trigger', kind: 'segment_entry', next: 'nope' },
      },
    };
    expect(() => validateCampaignDefinition(broken)).toThrow(/unresolvable/);
  });

  it('rejects a startNode that is not a defined node', () => {
    const d = validDef();
    expect(() => validateCampaignDefinition({ ...d, startNode: 'ghost' })).toThrow(
      /not a defined node/,
    );
  });

  it('requires a reachable exit (no-exit graph rejected)', () => {
    // The OLD fixture (a wait whose next loops back to the trigger) is now a CYCLE,
    // so cycle-rejection fires first. A finite graph where every edge resolves and
    // only `exit` is edge-less MUST reach an exit unless it cycles — so a no-exit
    // graph is necessarily cyclic. We assert it is rejected (cycle and/or no-exit).
    const noExit = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 1 }, next: 't' }, // loops, no exit
      },
    };
    expect(() => validateCampaignDefinition(noExit)).toThrow(/cycle|back-edge|no exit/);
  });

  it('enforces per-type required fields', () => {
    // An UNATTACHED send (no template_id) is a valid DRAFT (§9B phase 6 — the
    // publish gate, not structural validation, blocks an emailless send).
    const draftSend = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'send', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(draftSend)).not.toThrow();
    // …but a PRESENT template_id must be a non-empty string.
    const badSend = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'send', template_id: '', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(badSend)).toThrow(/template_id/);

    // set_attribute without key
    const badAttr = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'set_attribute', value: 1, next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(badAttr)).toThrow(/key/);

    // wait without delay or until
    const badWait = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(badWait)).toThrow(/needs a delay, until, untilOffset, waitCondition or maxWait/);
  });

  it('accepts a RICH wait-until: untilOffset + waitCondition + maxWait combined', () => {
    const def = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: {
          type: 'wait',
          untilOffset: { amount: 1, unit: 'days', anchor: '{{event.appointment_at}}' },
          waitCondition: { field: 'attributes.opened', operator: 'exists' },
          maxWait: { amount: 3, unit: 'days' },
          next: 'x',
        },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(def)).not.toThrow();
  });

  it('rejects a bad rich-wait duration (zero amount / unknown unit / missing anchor)', () => {
    const mk = (wait: Record<string, unknown>) => ({
      startNode: 't',
      nodes: { t: { type: 'trigger', kind: 'manual', next: 'w' }, w: { type: 'wait', next: 'x', ...wait }, x: { type: 'exit' } },
    });
    expect(() => validateCampaignDefinition(mk({ untilOffset: { amount: 0, unit: 'days', anchor: 'now' } }))).toThrow(/amount must be a positive number/);
    expect(() => validateCampaignDefinition(mk({ maxWait: { amount: 2, unit: 'weeks' } }))).toThrow(/unit must be minutes\|hours\|days/);
    expect(() => validateCampaignDefinition(mk({ untilOffset: { amount: 1, unit: 'days' } }))).toThrow(/anchor must be 'now' or a/);
  });

  it('accepts combine and|or; rejects any other combine value', () => {
    const mk = (combine: unknown) => ({
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', untilOffset: { amount: 1, unit: 'days', anchor: 'now' }, waitCondition: { field: 'attributes.x', operator: 'exists' }, combine, next: 'x' },
        x: { type: 'exit' },
      },
    });
    expect(() => validateCampaignDefinition(mk('and'))).not.toThrow();
    expect(() => validateCampaignDefinition(mk('or'))).not.toThrow();
    expect(() => validateCampaignDefinition(mk('xor'))).toThrow(/combine must be 'and' or 'or'/);
  });

  it('rejects an unknown node type', () => {
    const bad = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'q' },
        q: { type: 'frobnicate' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(bad)).toThrow(/unknown\/invalid type/);
  });
});

describe('validateCampaignDefinition: hour_of_day_window node', () => {
  // trigger -> window -> send -> exit
  function withWindow(win: Record<string, unknown>): unknown {
    return {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'win' },
        win: { type: 'hour_of_day_window', next: 'a', ...win },
        a: { type: 'action', kind: 'send', template_id: 'tpl-1', next: 'x' },
        x: { type: 'exit' },
      },
    };
  }

  it('accepts a well-formed hour_of_day_window', () => {
    expect(() => validateCampaignDefinition(withWindow({ startHour: 9, endHour: 17 }))).not.toThrow();
  });

  it('accepts an optional daysOfWeek (Mon–Fri)', () => {
    expect(() =>
      validateCampaignDefinition(withWindow({ startHour: 9, endHour: 17, daysOfWeek: [1, 2, 3, 4, 5] })),
    ).not.toThrow();
  });

  it('accepts an overnight (wrap-around) window startHour > endHour', () => {
    expect(() => validateCampaignDefinition(withWindow({ startHour: 22, endHour: 6 }))).not.toThrow();
  });

  it('rejects a missing startHour or endHour', () => {
    expect(() => validateCampaignDefinition(withWindow({ endHour: 17 }))).toThrow(/startHour|hour window/);
    expect(() => validateCampaignDefinition(withWindow({ startHour: 9 }))).toThrow(/endHour|hour window/);
  });

  it('rejects out-of-range / non-integer hours', () => {
    expect(() => validateCampaignDefinition(withWindow({ startHour: -1, endHour: 17 }))).toThrow(/hour/);
    expect(() => validateCampaignDefinition(withWindow({ startHour: 9, endHour: 24 }))).toThrow(/hour/);
    expect(() => validateCampaignDefinition(withWindow({ startHour: 9.5, endHour: 17 }))).toThrow(/hour/);
  });

  it('rejects an invalid daysOfWeek (out-of-range, duplicate, non-array, empty)', () => {
    expect(() => validateCampaignDefinition(withWindow({ startHour: 9, endHour: 17, daysOfWeek: [7] }))).toThrow(/day/);
    expect(() =>
      validateCampaignDefinition(withWindow({ startHour: 9, endHour: 17, daysOfWeek: [1, 1] })),
    ).toThrow(/day/);
    expect(() =>
      validateCampaignDefinition(withWindow({ startHour: 9, endHour: 17, daysOfWeek: 'mon' })),
    ).toThrow(/day/);
    expect(() => validateCampaignDefinition(withWindow({ startHour: 9, endHour: 17, daysOfWeek: [] }))).toThrow(/day/);
  });

  it('rejects a missing/unresolvable next edge', () => {
    const broken = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'win' },
        win: { type: 'hour_of_day_window', startHour: 9, endHour: 17, next: 'ghost' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(broken)).toThrow(/next|unresolvable/);
  });

  it('an hour_of_day_window on the only path keeps a reachable exit valid', () => {
    // (Already covered by the accept cases — the window contributes [next] to reachability.)
    expect(() => validateCampaignDefinition(withWindow({ startHour: 0, endHour: 23 }))).not.toThrow();
  });
});

describe('validateCampaignDefinition: webhook action', () => {
  function withWebhook(cfg: Record<string, unknown>): unknown {
    return {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'h' },
        h: { type: 'action', kind: 'webhook', next: 'x', ...cfg },
        x: { type: 'exit' },
      },
    };
  }

  it('accepts a fully-configured webhook action', () => {
    expect(() =>
      validateCampaignDefinition(
        withWebhook({
          url: 'https://hooks.example.com/x',
          method: 'POST',
          headers: {},
          bodyTemplate: '{}',
          timeoutMs: 5000,
          maxRetries: 2,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a webhook missing url', () => {
    expect(() => validateCampaignDefinition(withWebhook({ method: 'POST' }))).toThrow(/url/);
  });

  it('rejects a webhook with a missing/invalid method', () => {
    expect(() => validateCampaignDefinition(withWebhook({ url: 'https://h.example/x' }))).toThrow(/method/);
    expect(() =>
      validateCampaignDefinition(withWebhook({ url: 'https://h.example/x', method: 'TRACE' })),
    ).toThrow(/method/);
  });

  it('rejects a webhook with a non-http(s) url scheme (SSRF pre-check)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://h/x', 'javascript:alert(1)']) {
      expect(() => validateCampaignDefinition(withWebhook({ url, method: 'POST' }))).toThrow(/url|scheme|https?/);
    }
  });

  it('rejects a webhook with non-object headers, non-positive timeoutMs, or negative maxRetries', () => {
    const base = { url: 'https://h.example/x', method: 'POST' };
    expect(() => validateCampaignDefinition(withWebhook({ ...base, headers: 'nope' }))).toThrow();
    expect(() => validateCampaignDefinition(withWebhook({ ...base, timeoutMs: 0 }))).toThrow();
    expect(() => validateCampaignDefinition(withWebhook({ ...base, timeoutMs: -5 }))).toThrow();
    expect(() => validateCampaignDefinition(withWebhook({ ...base, maxRetries: -1 }))).toThrow();
  });

  it('allows an unattached send (draft) but rejects an empty template_id; still requires key for set_attribute', () => {
    const draftSend = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'send', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(draftSend)).not.toThrow();
    const emptyTpl = { ...draftSend, nodes: { ...draftSend.nodes, a: { type: 'action', kind: 'send', template_id: '', next: 'x' } } };
    expect(() => validateCampaignDefinition(emptyTpl)).toThrow(/template_id/);
  });
});

describe('validateCampaignDefinition: cycle + orphan detection', () => {
  it('rejects a back-edge to an ancestor (cycle)', () => {
    const cyclic = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 1 }, next: 'c' },
        c: {
          type: 'condition',
          ast: { field: 'total_events', operator: '>=', value: 1 },
          onTrue: 'w', // back-edge to ancestor
          onFalse: 'x',
        },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(cyclic)).toThrow(/cycle|back-edge/);
  });

  it('rejects a self-loop', () => {
    const selfLoop = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 1 }, next: 'w' }, // points to itself
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(selfLoop)).toThrow(/cycle/);
  });

  it('rejects an orphan node not reachable from startNode', () => {
    const orphaned = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'x' },
        x: { type: 'exit' },
        // unreachable island (still individually valid):
        lonely: { type: 'action', kind: 'set_attribute', key: 'k', value: 1, next: 'x' },
      },
    };
    expect(() => validateCampaignDefinition(orphaned)).toThrow(/orphan|unreachable|not reachable/);
  });

  it('ACCEPTS a condition whose BOTH arms point at the SAME continuation (empty arms rejoin)', () => {
    const emptyArms = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'c' },
        c: {
          type: 'condition',
          ast: { field: 'total_events', operator: '>=', value: 1 },
          onTrue: 'x',
          onFalse: 'x', // both arms straight into the same join — a converging diamond
        },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(emptyArms)).not.toThrow();
  });

  it('ACCEPTS one populated arm + one empty arm rejoining the trunk', () => {
    const oneArm = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'c' },
        c: {
          type: 'condition',
          ast: { field: 'total_events', operator: '>=', value: 1 },
          onTrue: 'a',
          onFalse: 'join', // empty arm passes straight through to the join
        },
        a: { type: 'action', kind: 'set_attribute', key: 'k', value: 1, next: 'join' },
        join: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(oneArm)).not.toThrow();
  });

  it('ACCEPTS one arm terminating in its own exit while the other rejoins the trunk', () => {
    const armTerminates = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'c' },
        c: {
          type: 'condition',
          ast: { field: 'total_events', operator: '>=', value: 1 },
          onTrue: 'exitT', // this arm terminates
          onFalse: 'join', // the other arm rejoins the trunk → exit
        },
        exitT: { type: 'exit' },
        join: { type: 'action', kind: 'set_attribute', key: 'done', value: 'y', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(armTerminates)).not.toThrow();
  });

  it('ACCEPTS a diamond (two paths converging on one node) — not a cycle', () => {
    const diamond = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'c' },
        c: {
          type: 'condition',
          ast: { field: 'total_events', operator: '>=', value: 1 },
          onTrue: 'm',
          onFalse: 'n',
        },
        m: { type: 'action', kind: 'set_attribute', key: 'a', value: 1, next: 'x' },
        n: { type: 'action', kind: 'set_attribute', key: 'b', value: 2, next: 'x' },
        x: { type: 'exit' }, // both m and n converge here — a re-convergence, not a cycle
      },
    };
    expect(() => validateCampaignDefinition(diamond)).not.toThrow();
  });

  it('a second trigger that is also an orphan still reports a deterministic error', () => {
    const twoTriggers = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'x' },
        x: { type: 'exit' },
        t2: { type: 'trigger', kind: 'manual', next: 'x' }, // extra trigger + orphan
      },
    };
    expect(() => validateCampaignDefinition(twoTriggers)).toThrow(/exactly one trigger|orphan|unreachable/);
  });
});

describe('resolveStartNode / findNode', () => {
  it('resolveStartNode returns the start node', () => {
    const d = validDef();
    expect(resolveStartNode(d).type).toBe('trigger');
  });

  it('findNode returns a node by id and throws on a miss', () => {
    const d = validDef();
    expect(findNode(d, 'x').type).toBe('exit');
    expect(() => findNode(d, 'nope')).toThrow(/not found/);
  });
});
