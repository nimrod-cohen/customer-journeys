// PURE unit tests for the rich WAIT-UNTIL decision (time gate + condition gate +
// max-wait cap; proceed-on-timeout; pin-on-first-arrival; poll-every-sweep).
import { describe, it, expect } from 'vitest';
import { decideRichWait, isRichWait, type RichWaitInputs, type WaitPin } from '../src/core.js';
import type { WaitNode } from '../src/dsl.js';

const TZ = 'UTC';
const NOW = new Date('2026-06-07T12:00:00.000Z');
const arrival = (over: Partial<RichWaitInputs> = {}): RichWaitInputs => ({ conditionMet: true, resolvedAnchor: null, pin: null, ...over });
const resume = (pin: WaitPin, over: Partial<RichWaitInputs> = {}): RichWaitInputs => ({ conditionMet: true, resolvedAnchor: null, pin, ...over });

describe('isRichWait', () => {
  it('is true for any of untilOffset / waitCondition / maxWait; false for plain delay/until', () => {
    expect(isRichWait({ type: 'wait', delay: { seconds: 60 }, next: 'x' })).toBe(false);
    expect(isRichWait({ type: 'wait', until: '2026-07-01T00:00:00Z', next: 'x' })).toBe(false);
    expect(isRichWait({ type: 'wait', untilOffset: { amount: 1, unit: 'days', anchor: 'now' }, next: 'x' })).toBe(true);
    expect(isRichWait({ type: 'wait', waitCondition: { field: 'attributes.x', operator: 'exists' } as never, next: 'x' })).toBe(true);
    expect(isRichWait({ type: 'wait', maxWait: { amount: 3, unit: 'days' }, next: 'x' })).toBe(true);
  });
});

describe('decideRichWait — time gate (untilOffset from now)', () => {
  const node: WaitNode = { type: 'wait', untilOffset: { amount: 2, unit: 'days', anchor: 'now' }, next: 'x' };

  it('first arrival pins now+2d and parks until then', () => {
    const d = decideRichWait(node, NOW, TZ, arrival());
    expect(d.advance).toBe(false);
    const target = new Date('2026-06-09T12:00:00.000Z');
    expect(d.nextRunAt!.toISOString()).toBe(target.toISOString());
    expect(d.pinToPersist).toEqual({ target: target.toISOString(), deadline: null });
  });

  it('resumes BEFORE the target → stays; AT/after the target → advances', () => {
    const pin: WaitPin = { target: '2026-06-09T12:00:00.000Z', deadline: null };
    expect(decideRichWait(node, new Date('2026-06-08T12:00:00Z'), TZ, resume(pin)).advance).toBe(false);
    expect(decideRichWait(node, new Date('2026-06-09T12:00:00Z'), TZ, resume(pin)).advance).toBe(true);
  });
});

describe('decideRichWait — time gate (untilOffset from a {{timestamp}} anchor)', () => {
  const node: WaitNode = { type: 'wait', untilOffset: { amount: 1, unit: 'days', anchor: '{{event.appointment_at}}' }, next: 'x' };

  it('pins resolvedAnchor + 1d', () => {
    const anchorAt = new Date('2026-06-20T09:00:00.000Z');
    const d = decideRichWait(node, NOW, TZ, arrival({ resolvedAnchor: anchorAt }));
    expect(d.pinToPersist!.target).toBe('2026-06-21T09:00:00.000Z');
  });

  it('an UNRESOLVABLE anchor drops the time gate (proceeds, governed by condition only)', () => {
    const d = decideRichWait(node, NOW, TZ, arrival({ resolvedAnchor: null, conditionMet: true }));
    expect(d.advance).toBe(true); // no time gate + condition met → go
  });

  it('direction "before" SUBTRACTS the offset from the anchor (1 day BEFORE the appointment)', () => {
    const before: WaitNode = { type: 'wait', untilOffset: { amount: 1, unit: 'days', anchor: '{{event.appointment_at}}', direction: 'before' }, next: 'x' };
    const anchorAt = new Date('2026-06-20T09:00:00.000Z');
    const d = decideRichWait(before, NOW, TZ, arrival({ resolvedAnchor: anchorAt }));
    expect(d.pinToPersist!.target).toBe('2026-06-19T09:00:00.000Z'); // appointment − 1 day
  });
});

describe('decideRichWait — condition gate (poll every sweep)', () => {
  const node: WaitNode = { type: 'wait', waitCondition: { field: 'attributes.opened', operator: 'exists' } as never, next: 'x' };

  it('condition not met → parks at NOW (re-due next sweep); met → advances', () => {
    const pending = decideRichWait(node, NOW, TZ, arrival({ conditionMet: false }));
    expect(pending.advance).toBe(false);
    expect(pending.nextRunAt!.toISOString()).toBe(NOW.toISOString()); // poll
    expect(decideRichWait(node, NOW, TZ, arrival({ conditionMet: true })).advance).toBe(true);
  });
});

describe('decideRichWait — BOTH time AND condition (combinable)', () => {
  const node: WaitNode = {
    type: 'wait',
    untilOffset: { amount: 1, unit: 'days', anchor: 'now' },
    waitCondition: { field: 'attributes.opened', operator: 'exists' } as never,
    next: 'x',
  };
  const pin: WaitPin = { target: '2026-06-08T12:00:00.000Z', deadline: null };

  it('before the time target → parks until the target (no condition polling yet)', () => {
    const d = decideRichWait(node, new Date('2026-06-07T18:00:00Z'), TZ, resume(pin, { conditionMet: true }));
    expect(d.advance).toBe(false);
    expect(d.nextRunAt!.toISOString()).toBe(pin.target);
  });

  it('time reached but condition NOT met → polls; time reached AND condition met → advances', () => {
    const after = new Date('2026-06-08T12:00:00Z');
    expect(decideRichWait(node, after, TZ, resume(pin, { conditionMet: false })).advance).toBe(false);
    expect(decideRichWait(node, after, TZ, resume(pin, { conditionMet: true })).advance).toBe(true);
  });
});

describe('decideRichWait — time OR condition (combine: or)', () => {
  const node: WaitNode = {
    type: 'wait',
    untilOffset: { amount: 2, unit: 'days', anchor: 'now' },
    waitCondition: { field: 'attributes.opened', operator: 'exists' } as never,
    combine: 'or',
    next: 'x',
  };
  const pin: WaitPin = { target: '2026-06-09T12:00:00.000Z', deadline: null };

  it('BEFORE the time target but condition MET → proceeds (OR — either gate)', () => {
    const d = decideRichWait(node, new Date('2026-06-07T18:00:00Z'), TZ, resume(pin, { conditionMet: true }));
    expect(d.advance).toBe(true);
  });

  it('BEFORE the time target and condition NOT met → stays, waking at the target AND polling now', () => {
    const d = decideRichWait(node, new Date('2026-06-07T18:00:00Z'), TZ, resume(pin, { conditionMet: false }));
    expect(d.advance).toBe(false);
    // earliest of poll-now and the target → now (re-checks the condition each sweep)
    expect(d.nextRunAt!.toISOString()).toBe('2026-06-07T18:00:00.000Z');
  });

  it('AFTER the time target, condition still NOT met → proceeds (OR — the time fired)', () => {
    const d = decideRichWait(node, new Date('2026-06-09T12:00:00Z'), TZ, resume(pin, { conditionMet: false }));
    expect(d.advance).toBe(true);
  });

  it('default (no combine) is AND: before the target with condition met → stays', () => {
    const andNode: WaitNode = { ...node, combine: undefined };
    const d = decideRichWait(andNode, new Date('2026-06-07T18:00:00Z'), TZ, resume(pin, { conditionMet: true }));
    expect(d.advance).toBe(false);
  });
});

describe('decideRichWait — max-wait cap (proceed on timeout)', () => {
  const node: WaitNode = {
    type: 'wait',
    waitCondition: { field: 'attributes.opened', operator: 'exists' } as never,
    maxWait: { amount: 3, unit: 'days' },
    next: 'x',
  };

  it('first arrival pins deadline now+3d and parks (condition unmet)', () => {
    const d = decideRichWait(node, NOW, TZ, arrival({ conditionMet: false }));
    expect(d.advance).toBe(false);
    expect(d.pinToPersist).toEqual({ target: null, deadline: '2026-06-10T12:00:00.000Z' });
  });

  it('at/after the deadline → ADVANCES even though the condition is still unmet', () => {
    const pin: WaitPin = { target: null, deadline: '2026-06-10T12:00:00.000Z' };
    expect(decideRichWait(node, new Date('2026-06-10T12:00:00Z'), TZ, resume(pin, { conditionMet: false })).advance).toBe(true);
    // before the deadline, still polling
    expect(decideRichWait(node, new Date('2026-06-09T12:00:00Z'), TZ, resume(pin, { conditionMet: false })).advance).toBe(false);
  });
});
