// Profile trigger (kind='profile'): a profile CREATE or UPDATE enrolls. The DSL
// accepts kind 'profile' with an optional profileChange (created|updated|any,
// default 'any') and rejects an invalid profileChange; the exactly-one-trigger /
// edges / cycle / orphan invariants are unaffected.
import { describe, it, expect } from 'vitest';
import { validateCampaignDefinition } from '../src/dsl.js';

const def = (trigger: Record<string, unknown>) => ({
  startNode: 't',
  nodes: { t: { type: 'trigger', ...trigger, next: 'x' }, x: { type: 'exit' } },
});

describe('validateCampaignDefinition — profile trigger', () => {
  it('ACCEPTS kind=profile with no profileChange (defaults to any)', () => {
    expect(() => validateCampaignDefinition(def({ kind: 'profile' }))).not.toThrow();
  });

  it('ACCEPTS each valid profileChange value', () => {
    for (const profileChange of ['created', 'updated', 'any'] as const) {
      expect(() => validateCampaignDefinition(def({ kind: 'profile', profileChange }))).not.toThrow();
    }
  });

  it('ACCEPTS an optional cosmetic label on a profile trigger', () => {
    expect(() =>
      validateCampaignDefinition(def({ kind: 'profile', profileChange: 'created', label: 'New customers' })),
    ).not.toThrow();
  });

  it('REJECTS an invalid profileChange value', () => {
    expect(() => validateCampaignDefinition(def({ kind: 'profile', profileChange: 'deleted' }))).toThrow(
      /profileChange/,
    );
    expect(() => validateCampaignDefinition(def({ kind: 'profile', profileChange: '' }))).toThrow(/profileChange/);
  });

  it('still REJECTS an unknown trigger kind', () => {
    expect(() => validateCampaignDefinition(def({ kind: 'nope' }))).toThrow(/invalid kind/);
  });

  it('keeps the exactly-one-trigger / cycle / orphan invariants with a profile trigger', () => {
    const valid = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'profile', profileChange: 'updated', next: 'w' },
        w: { type: 'wait', delay: { seconds: 60 }, next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(valid)).not.toThrow();

    const twoTriggers = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'profile', next: 't2' },
        t2: { type: 'trigger', kind: 'manual', next: 'x' },
        x: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(twoTriggers)).toThrow(/exactly one trigger/);

    const orphan = {
      startNode: 't',
      nodes: {
        t: { type: 'trigger', kind: 'profile', next: 'x' },
        x: { type: 'exit' },
        lost: { type: 'exit' },
      },
    };
    expect(() => validateCampaignDefinition(orphan)).toThrow(/orphan/);
  });
});
