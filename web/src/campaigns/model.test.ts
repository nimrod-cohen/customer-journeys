// Unit: canvas model ↔ DSL build/parse round-trip + default node stubs (§9B
// phase 5). Imports the REAL runner validator so every emitted graph is gated by
// production rules (no mock). Pure — no I/O.
import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '@cdp/service-campaign-runner';
import {
  parseDefinition,
  buildDefinition,
  defaultNodeConfig,
  outgoingEdges,
  starterModel,
  type CampaignDefinition,
} from './model.js';

const linear: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'segment_entry', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 172800 }, next: 'send1' },
    send1: { type: 'action', kind: 'send', template_id: 'tpl', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

const branch: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'sendY', onFalse: 'sendN' },
    sendY: { type: 'action', kind: 'send', template_id: 'tplY', next: 'exitY' },
    sendN: { type: 'action', kind: 'send', template_id: 'tplN', next: 'exitN' },
    exitY: { type: 'exit' },
    exitN: { type: 'exit' },
  },
};

// A converging diamond: the condition's BOTH arms point at the same join id.
const diamond: CampaignDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'manual', next: 'cond' },
    cond: { type: 'condition', ast: { field: 'attributes.tier', operator: '=', value: 'vip' }, onTrue: 'join', onFalse: 'join' },
    join: { type: 'exit' },
  },
};

describe('converging diamond bridge', () => {
  it('parseDefinition yields TWO edges into the join (slots onTrue + onFalse, Yes/No)', () => {
    const m = parseDefinition(diamond);
    const condEdges = m.edges.filter((e) => e.from === 'cond');
    expect(condEdges).toEqual([
      { from: 'cond', to: 'join', slot: 'onTrue', label: 'Yes' },
      { from: 'cond', to: 'join', slot: 'onFalse', label: 'No' },
    ]);
    // One CanvasNode per id (the join is a single node).
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['cond', 'join', 'trigger']);
  });

  it('buildDefinition(parseDefinition(diamond)) is identity (both arms preserved)', () => {
    expect(buildDefinition(parseDefinition(diamond))).toEqual(diamond);
  });

  it('outgoingEdges returns onTrue then onFalse even when both point at the SAME join', () => {
    const edges = outgoingEdges('cond', diamond.nodes.cond!);
    expect(edges).toEqual([
      { from: 'cond', to: 'join', slot: 'onTrue', label: 'Yes' },
      { from: 'cond', to: 'join', slot: 'onFalse', label: 'No' },
    ]);
  });

  it('the diamond validates (no false cycle/orphan)', () => {
    expect(() => validateCampaignDefinition(buildDefinition(parseDefinition(diamond)))).not.toThrow();
  });
});

describe('parseDefinition', () => {
  it('derives an explicit edge list from next/onTrue/onFalse and flags the start', () => {
    const m = parseDefinition(linear);
    expect(m.start).toBe('trigger');
    expect(m.nodes.map((n) => n.id).sort()).toEqual(['exit1', 'send1', 'trigger', 'wait1']);
    expect(m.edges).toEqual([
      { from: 'trigger', to: 'wait1', slot: 'next' },
      { from: 'wait1', to: 'send1', slot: 'next' },
      { from: 'send1', to: 'exit1', slot: 'next' },
    ]);
  });

  it('labels condition arms Yes/No and stores no coordinates', () => {
    const m = parseDefinition(branch);
    const condEdges = m.edges.filter((e) => e.from === 'cond');
    expect(condEdges).toEqual([
      { from: 'cond', to: 'sendY', slot: 'onTrue', label: 'Yes' },
      { from: 'cond', to: 'sendN', slot: 'onFalse', label: 'No' },
    ]);
    for (const n of m.nodes) {
      expect(n.node).not.toHaveProperty('x');
      expect(n.node).not.toHaveProperty('y');
    }
  });
});

describe('buildDefinition round-trip', () => {
  it('is identity for a linear trigger→wait→send→exit', () => {
    expect(buildDefinition(parseDefinition(linear))).toEqual(linear);
  });

  it('is identity for an if-branch', () => {
    expect(buildDefinition(parseDefinition(branch))).toEqual(branch);
  });

  it('startNode is the single trigger id', () => {
    expect(buildDefinition(parseDefinition(branch)).startNode).toBe('trigger');
  });
});

describe('emitted graphs pass the real validator', () => {
  it('linear + branch validate without throwing', () => {
    expect(() => validateCampaignDefinition(buildDefinition(parseDefinition(linear)))).not.toThrow();
    expect(() => validateCampaignDefinition(buildDefinition(parseDefinition(branch)))).not.toThrow();
  });

  it('the starter model (trigger→exit) validates', () => {
    expect(() => validateCampaignDefinition(buildDefinition(starterModel()))).not.toThrow();
  });
});

describe('defaultNodeConfig stubs', () => {
  const now = new Date('2026-06-06T00:00:00Z');
  it('wait → {delay:{seconds:86400}}', () => {
    expect(defaultNodeConfig('wait', now)).toMatchObject({ type: 'wait', delay: { seconds: 86400 } });
  });
  it('wait_until → a future ISO until', () => {
    const n = defaultNodeConfig('wait_until', now) as unknown as { until: string };
    expect(new Date(n.until).getTime()).toBeGreaterThan(now.getTime());
  });
  it('hour_of_day_window → start/end hours', () => {
    expect(defaultNodeConfig('hour_of_day_window', now)).toMatchObject({ startHour: 9, endHour: 17 });
  });
  it('condition → an ast + both arms (filled by insert)', () => {
    const n = defaultNodeConfig('condition', now);
    expect(n.type).toBe('condition');
    expect(n).toHaveProperty('ast');
  });
  it('send → NO placeholder template_id (reads as "needs an email")', () => {
    const node = defaultNodeConfig('send', now);
    expect(node).toMatchObject({ type: 'action', kind: 'send' });
    expect((node as { template_id?: string }).template_id ?? '').not.toBe('placeholder');
    expect('template_id' in (node as object)).toBe(false);
  });
  it('set_attribute → a key', () => {
    expect(defaultNodeConfig('set_attribute', now)).toMatchObject({ type: 'action', kind: 'set_attribute', key: 'stage' });
  });
  it('webhook → an https url + method', () => {
    expect(defaultNodeConfig('webhook', now)).toMatchObject({ type: 'action', kind: 'webhook', url: 'https://example.com', method: 'POST' });
  });
  it('exit → a terminal exit', () => {
    expect(defaultNodeConfig('exit', now)).toEqual({ type: 'exit' });
  });
});
