// Tests for the `journey.*` personalization namespace.
import { describe, it, expect } from 'vitest';
import { journeyMerge, resolveJourneyPath, resolveValueSpec } from '../src/index.js';

describe('journeyMerge — flatten a per-enrollment vars object into journey.* tokens', () => {
  it('emits scalar leaves as journey.<dotted-path>', () => {
    expect(journeyMerge({ cohort: 'launch', meta: { score: 9 } })).toEqual({
      'journey.cohort': 'launch',
      'journey.meta.score': '9',
    });
  });
  it('arrays use numeric segment keys; nested scalars are walked', () => {
    expect(journeyMerge({ steps: [{ name: 'opened' }, { name: 'clicked' }] })).toEqual({
      'journey.steps.0.name': 'opened',
      'journey.steps.1.name': 'clicked',
    });
  });
  it('an undefined / null / non-object input yields {}', () => {
    expect(journeyMerge(undefined)).toEqual({});
    expect(journeyMerge(null)).toEqual({});
    expect(journeyMerge('nope')).toEqual({});
  });
  it('null leaves are skipped (read as safe-empty downstream)', () => {
    expect(journeyMerge({ a: 1, b: null })).toEqual({ 'journey.a': '1' });
  });
});

describe('resolveJourneyPath — deep dot reader', () => {
  it('walks objects and arrays', () => {
    const v = { meta: { items: [{ sku: 'X1' }, { sku: 'X2' }] } };
    expect(resolveJourneyPath(v, 'meta.items.0.sku')).toBe('X1');
    expect(resolveJourneyPath(v, 'meta.items.5.sku')).toBeUndefined();
  });
  it('a missing path resolves to undefined (never throws)', () => {
    expect(resolveJourneyPath({}, 'nope')).toBeUndefined();
    expect(resolveJourneyPath(undefined, 'x')).toBeUndefined();
  });
});

describe('resolveValueSpec — expressions can reference {{journey.*}}', () => {
  it('substitutes journey.* tokens from the ctx.journey vars', () => {
    const out = resolveValueSpec(
      { kind: 'expression', expression: 'Step is {{journey.step}} ({{journey.cohort}})' },
      { profile: { id: 'p1' }, journey: { step: 3, cohort: 'launch' } },
    );
    expect(out).toBe('Step is 3 (launch)');
  });
  it('a missing journey key renders empty (safe-empty)', () => {
    const out = resolveValueSpec(
      { kind: 'expression', expression: '[{{journey.missing}}]' },
      { profile: { id: 'p1' } },
    );
    expect(out).toBe('[]');
  });
});
