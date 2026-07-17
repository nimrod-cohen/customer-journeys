// Unit: the pure automation-versioning helpers (§9B builder). Pure — no I/O.
import { describe, it, expect } from 'vitest';
import { backfillAllowed, draftDiffersFrom, stableStringify } from './versioning.js';
import type { AutomationDefinition } from './model.js';

const segmentEntry: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'segment_entry', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

const eventTrigger: AutomationDefinition = {
  startNode: 'trigger',
  nodes: {
    trigger: { type: 'trigger', kind: 'event', event: 'signup', next: 'exit1' },
    exit1: { type: 'exit' },
  },
};

describe('backfillAllowed', () => {
  it('is true only for a segment_entry trigger WITH a segment selected', () => {
    expect(backfillAllowed(segmentEntry, 'seg-1')).toBe(true);
  });

  it('is false for a segment_entry trigger with no segment selected', () => {
    expect(backfillAllowed(segmentEntry, null)).toBe(false);
  });

  it('is false for a non-segment_entry trigger even with a segment id', () => {
    expect(backfillAllowed(eventTrigger, 'seg-1')).toBe(false);
  });
});

describe('draftDiffersFrom', () => {
  it('is true when there is no published baseline yet', () => {
    expect(draftDiffersFrom(segmentEntry, null, 'seg-1', null)).toBe(true);
  });

  it('is false when local equals live (same graph + same trigger segment)', () => {
    expect(draftDiffersFrom(segmentEntry, segmentEntry, 'seg-1', 'seg-1')).toBe(false);
  });

  it('ignores key/node ordering (canonical compare)', () => {
    const reordered: AutomationDefinition = {
      nodes: {
        exit1: { type: 'exit' },
        trigger: { next: 'exit1', kind: 'segment_entry', type: 'trigger' },
      },
      startNode: 'trigger',
    } as unknown as AutomationDefinition;
    expect(draftDiffersFrom(reordered, segmentEntry, null, null)).toBe(false);
  });

  it('is true when the graph differs', () => {
    expect(draftDiffersFrom(eventTrigger, segmentEntry, null, null)).toBe(true);
  });

  it('is true when only the trigger segment differs', () => {
    expect(draftDiffersFrom(segmentEntry, segmentEntry, 'seg-2', 'seg-1')).toBe(true);
  });

  it('treats undefined and null trigger segments as equal', () => {
    expect(draftDiffersFrom(segmentEntry, segmentEntry, null, null)).toBe(false);
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
