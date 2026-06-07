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
      nodes: { ...d.nodes, t2: { type: 'trigger', kind: 'event', next: 'x' } },
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

  it('requires a reachable exit', () => {
    const noExit = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'w' },
        w: { type: 'wait', delay: { seconds: 1 }, next: 't' }, // loops, no exit
      },
    };
    expect(() => validateCampaignDefinition(noExit)).toThrow(/no exit/);
  });

  it('enforces per-type required fields', () => {
    // send action without template_id
    const badSend = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'manual', next: 'a' },
        a: { type: 'action', kind: 'send', next: 'x' },
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
    expect(() => validateCampaignDefinition(badWait)).toThrow(/delay or until/);
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
