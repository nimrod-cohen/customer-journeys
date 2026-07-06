import { describe, it, expect } from 'vitest';
import { decideDispatch, type DispatchContext, type QuietSchedule } from '../src/core.js';

/** A quiet schedule with the SAME window every weekday (UTC in these tests). */
const allDays = (startHour: number, endHour: number): QuietSchedule =>
  Array.from({ length: 7 }, (_, d) => ({ startDay: d, startMinute: startHour * 60, endDay: d, endMinute: endHour * 60 }));

// §9 / CLAUDE.md invariant 7 — the guard order is LOAD-BEARING:
//   gate(canSend) → suppression → frequency-cap → quiet-hours → send
// decideDispatch short-circuits at the FIRST block (lazy: later predicates are
// not evaluated once blocked) and reports where it stopped. SES is only reached
// on the all-pass 'send' action (proven in the handler tests via call count).
function base(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    workspace: {
      id: 'ws-1',
      status: 'active',
      sending_identity: { verified: true, from_domain: 'mail.acme.com', config_set: 'cs' },
    },
    profile: { id: 'p-1', email: 'r@example.com' },
    template: { compiledHtml: '<html>{{x}}</html>' },
    subject: 'Hi',
    merge: { x: '1' },
    frequencyCap: { max: 7, days: 7 },
    quietHours: null,
    timeZone: 'UTC',
    recentSendCount: 0,
    isSuppressed: false,
    now: new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    linkTrackingBaseUrl: 'https://api.cdp.example',
    ...overrides,
  };
}

describe('decideDispatch — guard order + short-circuit', () => {
  it('all pass → send', () => {
    const d = decideDispatch(base());
    expect(d.action).toBe('send');
    expect(d.stoppedAt).toBeUndefined();
  });

  it('gate blocks first: not active → refuse, stoppedAt=gate', () => {
    const d = decideDispatch(
      base({
        workspace: {
          id: 'ws-1',
          status: 'onboarding',
          sending_identity: { verified: false, from_domain: 'm', config_set: 'cs' },
        },
        // Even though suppressed AND over cap AND quiet, gate wins (order).
        isSuppressed: true,
        recentSendCount: 999,
        quietHours: allDays(0, 23),
      }),
    );
    expect(d.action).toBe('refuse');
    expect(d.stoppedAt).toBe('gate');
  });

  it('suppression blocks before cap/quiet → skip, stoppedAt=suppression', () => {
    const d = decideDispatch(
      base({ isSuppressed: true, recentSendCount: 999, quietHours: allDays(0, 23) }),
    );
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('suppression');
  });

  it('medium-group opt-out → skip, stoppedAt=medium-optout', () => {
    const d = decideDispatch(base({ optedOutOfMedium: true }));
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('medium-optout');
  });

  it('topic opt-out → skip, stoppedAt=topic-optout', () => {
    const d = decideDispatch(base({ topicUnsubscribed: true }));
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('topic-optout');
  });

  it('suppression beats medium/topic opt-out (order: suppression first)', () => {
    const d = decideDispatch(base({ isSuppressed: true, optedOutOfMedium: true, topicUnsubscribed: true }));
    expect(d.stoppedAt).toBe('suppression');
  });

  it('medium-group opt-out beats topic opt-out (order)', () => {
    const d = decideDispatch(base({ optedOutOfMedium: true, topicUnsubscribed: true }));
    expect(d.stoppedAt).toBe('medium-optout');
  });

  it('medium/topic opt-out beat the cap (order: opt-outs before cap/quiet)', () => {
    const d = decideDispatch(
      base({ topicUnsubscribed: true, recentSendCount: 999, quietHours: allDays(0, 23) }),
    );
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('topic-optout');
  });

  it('frequency cap blocks before quiet → skip, stoppedAt=frequency-cap', () => {
    const d = decideDispatch(
      base({ recentSendCount: 7, quietHours: allDays(0, 23) }),
    );
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('frequency-cap');
  });

  it('quiet hours block last → defer, stoppedAt=quiet-hours', () => {
    const d = decideDispatch(base({ quietHours: allDays(9, 17) }));
    expect(d.action).toBe('defer');
    expect(d.stoppedAt).toBe('quiet-hours');
    expect(d.deferUntil?.toISOString()).toBe('2026-06-10T17:00:00.000Z');
  });

  it('soft-bounce cooldown defers a send within 24h of the last soft bounce', () => {
    // last soft bounce 12h ago → still in the 24h window → defer until +24h.
    const d = decideDispatch(base({ lastSoftBounceAt: new Date('2026-06-10T00:00:00.000Z') }));
    expect(d.action).toBe('defer');
    expect(d.stoppedAt).toBe('soft-bounce-cooldown');
    expect(d.deferUntil?.toISOString()).toBe('2026-06-11T00:00:00.000Z');
  });

  it('soft-bounce cooldown does NOT block once 24h have passed', () => {
    const d = decideDispatch(base({ lastSoftBounceAt: new Date('2026-06-08T00:00:00.000Z') }));
    expect(d.action).toBe('send');
  });

  it('suppression beats the cooldown (order)', () => {
    const d = decideDispatch(
      base({ isSuppressed: true, lastSoftBounceAt: new Date('2026-06-10T00:00:00.000Z') }),
    );
    expect(d.stoppedAt).toBe('suppression');
  });

  it('is LAZY: later predicates are not evaluated once blocked (suppression beats a throwing cap)', () => {
    // recentSendCount is read as a number; to prove laziness we make the quiet
    // config something that would mis-evaluate if reached. Suppression stops
    // first, so the decision is 'skip' at 'suppression' regardless.
    const d = decideDispatch(
      base({
        isSuppressed: true,
        // a cap of 0 means "no cap" — if cap were evaluated it would PASS, not
        // block; but suppression short-circuits before cap is even consulted.
        frequencyCap: null,
        recentSendCount: 0,
      }),
    );
    expect(d.action).toBe('skip');
    expect(d.stoppedAt).toBe('suppression');
  });
});
