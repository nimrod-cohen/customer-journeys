import { describe, it, expect } from 'vitest';
import {
  isEmailOpenType,
  isPurchaseLike,
  extractAmount,
  applyEventToFeatures,
  buildFeatureUpsert,
  planProcessing,
} from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// Phase 4 — profile_features pure core (§6, §7 step 3). All logic lives in pure
// functions; buildFeatureUpsert's SQL must MIRROR applyEventToFeatures exactly.

function msg(
  type: string,
  attributes: Record<string, unknown> = {},
  occurredAt = '2026-06-06T00:00:00.000Z',
): ProcessorMessage {
  return {
    workspace_id: 'ws-1',
    profile_id: 'profile-1',
    envelope: {
      event_id: '00000000-0000-0000-0000-0000000000aa',
      email: 'cust-1@acme.com',
      type,
      occurred_at: occurredAt,
      attributes,
    },
  };
}

describe('isEmailOpenType', () => {
  it('is true for open event types', () => {
    expect(isEmailOpenType('email_open')).toBe(true);
    expect(isEmailOpenType('open')).toBe(true);
  });
  it('is false for non-open types', () => {
    expect(isEmailOpenType('purchase')).toBe(false);
    expect(isEmailOpenType('progress')).toBe(false);
    expect(isEmailOpenType('')).toBe(false);
  });
});

describe('isPurchaseLike', () => {
  it('is true for purchase-like types', () => {
    expect(isPurchaseLike('purchase')).toBe(true);
    expect(isPurchaseLike('order_completed')).toBe(true);
  });
  it('is false for non-purchase types', () => {
    expect(isPurchaseLike('email_open')).toBe(false);
    expect(isPurchaseLike('progress')).toBe(false);
  });
});

describe('extractAmount', () => {
  it('reads a numeric amount', () => {
    expect(extractAmount({ amount: 42 })).toBe(42);
  });
  it('parses a numeric string amount', () => {
    expect(extractAmount({ amount: '19.99' })).toBeCloseTo(19.99);
  });
  it('defaults to 0 when absent', () => {
    expect(extractAmount({})).toBe(0);
    expect(extractAmount(undefined as unknown as Record<string, unknown>)).toBe(0);
  });
  it('never returns NaN for garbage', () => {
    expect(extractAmount({ amount: 'not-a-number' })).toBe(0);
    expect(extractAmount({ amount: null })).toBe(0);
    expect(extractAmount({ amount: NaN })).toBe(0);
    expect(extractAmount({ amount: {} })).toBe(0);
  });
});

describe('applyEventToFeatures (pure next-state)', () => {
  it('initializes from null (first event)', () => {
    const next = applyEventToFeatures(null, msg('progress'));
    expect(next.total_events).toBe(1);
    expect(next.last_event_at).toBe('2026-06-06T00:00:00.000Z');
    expect(next.last_email_open_at).toBeNull();
    expect(next.counters).toEqual({ progress: 1 });
    expect(next.monetary_total).toBe(0);
  });

  it('increments total and per-type counters from a prior state', () => {
    const prev = applyEventToFeatures(null, msg('progress'));
    const next = applyEventToFeatures(prev, msg('progress'));
    expect(next.total_events).toBe(2);
    expect(next.counters).toEqual({ progress: 2 });
  });

  it('sets last_email_open_at only on open types (MAX semantics)', () => {
    const a = applyEventToFeatures(null, msg('email_open', {}, '2026-06-01T00:00:00.000Z'));
    expect(a.last_email_open_at).toBe('2026-06-01T00:00:00.000Z');
    // a later non-open event must NOT clear or change last_email_open_at
    const b = applyEventToFeatures(a, msg('progress', {}, '2026-06-05T00:00:00.000Z'));
    expect(b.last_email_open_at).toBe('2026-06-01T00:00:00.000Z');
    // an earlier open event must not move it backwards (MAX)
    const c = applyEventToFeatures(b, msg('open', {}, '2026-05-01T00:00:00.000Z'));
    expect(c.last_email_open_at).toBe('2026-06-01T00:00:00.000Z');
    // a later open event advances it
    const d = applyEventToFeatures(c, msg('open', {}, '2026-06-10T00:00:00.000Z'));
    expect(d.last_email_open_at).toBe('2026-06-10T00:00:00.000Z');
  });

  it('last_event_at is the MAX occurred_at', () => {
    const a = applyEventToFeatures(null, msg('progress', {}, '2026-06-05T00:00:00.000Z'));
    const b = applyEventToFeatures(a, msg('progress', {}, '2026-06-01T00:00:00.000Z'));
    expect(b.last_event_at).toBe('2026-06-05T00:00:00.000Z');
  });

  it('adds amount to monetary_total only for purchase-like events', () => {
    const a = applyEventToFeatures(null, msg('purchase', { amount: 10 }));
    expect(a.monetary_total).toBe(10);
    const b = applyEventToFeatures(a, msg('progress', { amount: 999 }));
    expect(b.monetary_total).toBe(10); // non-purchase contributes nothing
    const c = applyEventToFeatures(b, msg('order_completed', { amount: '5.5' }));
    expect(c.monetary_total).toBeCloseTo(15.5);
  });
});

describe('buildFeatureUpsert (single combined CTE; SQL mirrors applyEventToFeatures)', () => {
  it('is a single statement: event-insert CTE gating the feature upsert', () => {
    const q = buildFeatureUpsert(msg('purchase', { amount: 10 }));
    // exactly one statement (no semicolon-joined statements)
    expect(q.text.replace(/;\s*$/, '').includes(';')).toBe(false);
    expect(q.text).toMatch(/WITH\s+ins\s+AS/i);
    expect(q.text).toMatch(/INSERT INTO events/i);
    expect(q.text).toMatch(/ON CONFLICT\s*\(\s*event_id\s*\)\s*DO NOTHING/i);
    expect(q.text).toMatch(/RETURNING\s+event_id/i);
    expect(q.text).toMatch(/INSERT INTO profile_features/i);
    expect(q.text).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM ins\s*\)/i);
  });

  it('resolves profile_id via the (workspace_id, email) subquery, never the client', () => {
    const q = buildFeatureUpsert(msg('progress'));
    expect(q.text).toMatch(/FROM profiles/i);
    // workspace_id bound at $1
    expect(q.values[0]).toBe('ws-1');
    expect(q.values).toContain('cust-1@acme.com');
    // no interpolation of the workspace id
    expect(q.text).not.toContain('ws-1');
  });

  it('the feature upsert mirrors applyEventToFeatures: counters/monetary/timestamps', () => {
    const q = buildFeatureUpsert(msg('purchase', { amount: 10 }));
    expect(q.text).toMatch(/total_events\s*=\s*profile_features\.total_events\s*\+\s*1/i);
    expect(q.text).toMatch(/last_event_at\s*=\s*GREATEST/i);
    expect(q.text).toMatch(/last_email_open_at\s*=\s*GREATEST/i);
    expect(q.text).toMatch(/counters\s*=\s*profile_features\.counters\s*\|\|/i);
    expect(q.text).toMatch(/jsonb_build_object/i);
    expect(q.text).toMatch(/monetary_total\s*=\s*profile_features\.monetary_total\s*\+\s*EXCLUDED\.monetary_total/i);
    expect(q.text).toMatch(/updated_at\s*=\s*now\(\)/i);
  });

  it('the open-timestamp column is NULL for non-open events (GREATEST preserves prior)', () => {
    const open = buildFeatureUpsert(msg('email_open'));
    const notOpen = buildFeatureUpsert(msg('progress'));
    // the open timestamp is bound as a param: present for open, NULL otherwise
    expect(open.values).toContain('2026-06-06T00:00:00.000Z');
    // for a non-open event, a NULL must be among the bound values for the open ts
    expect(notOpen.values).toContain(null);
  });

  it('binds the computed monetary amount (purchase) and 0 for non-purchase', () => {
    const purchase = buildFeatureUpsert(msg('purchase', { amount: 7 }));
    const progress = buildFeatureUpsert(msg('progress', { amount: 7 }));
    expect(purchase.values).toContain(7);
    expect(progress.values).toContain(0);
  });
});

describe('planProcessing wiring (Phase 4)', () => {
  it('replaces the standalone event-insert with the combined event+feature CTE', () => {
    const plan = planProcessing(msg('purchase', { amount: 5 }));
    const texts = plan.statements.map((s) => s.text);
    // profile upsert still first
    const upsertIdx = texts.findIndex((t) => /INSERT INTO profiles/i.test(t));
    const featureIdx = texts.findIndex((t) => /INSERT INTO profile_features/i.test(t));
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(featureIdx).toBeGreaterThan(upsertIdx);
    // the combined statement carries BOTH the event insert and the feature upsert
    const combined = texts[featureIdx];
    expect(combined).toMatch(/INSERT INTO events/i);
    expect(combined).toMatch(/WITH\s+ins\s+AS/i);
    // no separate standalone events-only insert remains
    const eventOnly = texts.filter(
      (t) => /INSERT INTO events/i.test(t) && !/INSERT INTO profile_features/i.test(t),
    );
    expect(eventOnly).toHaveLength(0);
  });

  it('every statement remains workspace-scoped (ws-1 bound)', () => {
    const plan = planProcessing(msg('progress'));
    for (const s of plan.statements) {
      expect(s.values).toContain('ws-1');
    }
  });
});
