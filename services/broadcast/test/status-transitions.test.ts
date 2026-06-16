import { describe, it, expect } from 'vitest';
import { isValidBroadcastTransition, buildBroadcastStatusUpdate } from '../src/core.js';

// §9A / §6 — the broadcast state machine: draft|scheduled|sending|sent|cancelled.
const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BC = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('isValidBroadcastTransition', () => {
  it('allows the send path', () => {
    expect(isValidBroadcastTransition('draft', 'sending')).toBe(true);
    expect(isValidBroadcastTransition('scheduled', 'sending')).toBe(true);
    expect(isValidBroadcastTransition('sending', 'sent')).toBe(true);
  });

  it('allows scheduling and cancellation', () => {
    expect(isValidBroadcastTransition('draft', 'scheduled')).toBe(true);
    expect(isValidBroadcastTransition('draft', 'cancelled')).toBe(true);
    expect(isValidBroadcastTransition('scheduled', 'cancelled')).toBe(true);
  });

  it('allows a failed send to roll back from sending (never stuck)', () => {
    expect(isValidBroadcastTransition('sending', 'draft')).toBe(true);
    expect(isValidBroadcastTransition('sending', 'scheduled')).toBe(true);
  });

  it('rejects terminal and illegal transitions', () => {
    expect(isValidBroadcastTransition('sent', 'sending')).toBe(false);
    expect(isValidBroadcastTransition('sent', 'draft')).toBe(false);
    expect(isValidBroadcastTransition('cancelled', 'sending')).toBe(false);
    expect(isValidBroadcastTransition('draft', 'sent')).toBe(false);
    expect(isValidBroadcastTransition('sending', 'sending')).toBe(false);
  });
});

describe('buildBroadcastStatusUpdate', () => {
  it('is a compare-and-set: WHERE workspace_id=$1 AND status=from', () => {
    const stmt = buildBroadcastStatusUpdate(WS, BC, 'draft', 'sending');
    expect(stmt.values[0]).toBe(WS);
    const t = stmt.text.replace(/\s+/g, ' ');
    expect(t).toMatch(/UPDATE broadcasts SET status =/i);
    expect(t).toMatch(/WHERE workspace_id = \$1/i);
    expect(t).toMatch(/AND status = /i);
    // the "from" status must be a bound value so the CAS is atomic
    expect(stmt.values).toContain('draft');
    expect(stmt.values).toContain('sending');
  });

  it('sets sent_at when transitioning to sent', () => {
    const stmt = buildBroadcastStatusUpdate(WS, BC, 'sending', 'sent');
    expect(stmt.text.replace(/\s+/g, ' ')).toMatch(/sent_at = now\(\)/i);
  });

  it('does NOT set sent_at for non-sent transitions', () => {
    const stmt = buildBroadcastStatusUpdate(WS, BC, 'draft', 'sending');
    expect(stmt.text).not.toMatch(/sent_at/i);
  });

  it('throws on a falsy workspaceId', () => {
    expect(() => buildBroadcastStatusUpdate('', BC, 'draft', 'sending')).toThrow();
  });

  it('throws on an invalid transition', () => {
    expect(() => buildBroadcastStatusUpdate(WS, BC, 'sent', 'sending')).toThrow();
  });
});
