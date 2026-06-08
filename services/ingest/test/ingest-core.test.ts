import { describe, it, expect } from 'vitest';
import {
  validateEnvelope,
  buildProfileUpsert,
  buildSqsMessage,
} from '../src/core.js';
import type { EventEnvelope } from '@cdp/shared';

// AC1 (idempotency key present) / AC4 / AC5 — the pure ingest core.
// validateEnvelope rejects malformed payloads and — CRITICALLY (§7/§13) — never
// trusts a client-supplied workspace_id. buildProfileUpsert / buildSqsMessage are
// pure builders; the handler wires them to the DB / SQS.

const good: EventEnvelope = {
  event_id: '00000000-0000-0000-0000-000000000001',
  email: 'cust-1@acme.com',
  type: 'profile_created',
  occurred_at: '2026-06-06T00:00:00.000Z',
  attributes: { plan: 'pro' },
};

describe('validateEnvelope (AC1/AC4)', () => {
  it('accepts a well-formed envelope and returns a normalized copy', () => {
    const r = validateEnvelope(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.event_id).toBe(good.event_id);
      expect(r.value.email).toBe('cust-1@acme.com');
      expect(r.value.type).toBe('profile_created');
      expect(r.value.attributes).toEqual({ plan: 'pro' });
    }
  });

  it('trims the email (casing is applied per-workspace in the handler)', () => {
    const r = validateEnvelope({ ...good, email: '  Cust-1@ACME.com ' });
    expect(r.ok && r.value.email).toBe('Cust-1@ACME.com');
  });

  it('defaults attributes to an empty object when omitted', () => {
    const { attributes: _omit, ...rest } = good;
    const r = validateEnvelope(rest);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attributes).toEqual({});
  });

  it('rejects a non-object payload', () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope('x').ok).toBe(false);
    expect(validateEnvelope(42).ok).toBe(false);
  });

  it('rejects a missing or non-uuid event_id', () => {
    expect(validateEnvelope({ ...good, event_id: undefined }).ok).toBe(false);
    expect(validateEnvelope({ ...good, event_id: 'not-a-uuid' }).ok).toBe(false);
  });

  it('rejects a missing/invalid email (the identity key)', () => {
    expect(validateEnvelope({ ...good, email: '' }).ok).toBe(false);
    expect(validateEnvelope({ ...good, email: undefined }).ok).toBe(false);
    expect(validateEnvelope({ ...good, email: 'not-an-email' }).ok).toBe(false);
  });

  it('treats external_id as OPTIONAL metadata (absent is fine)', () => {
    const { external_id: _omit, ...rest } = good as EventEnvelope & { external_id?: string };
    void _omit;
    expect(validateEnvelope(rest).ok).toBe(true);
  });

  it('rejects a missing/empty type', () => {
    expect(validateEnvelope({ ...good, type: '' }).ok).toBe(false);
  });

  it('rejects a non-ISO occurred_at', () => {
    expect(validateEnvelope({ ...good, occurred_at: 'yesterday' }).ok).toBe(false);
  });

  // CRITICAL invariant (§7/§13): workspace is NEVER from the client payload.
  it('NEVER carries a client-supplied workspace_id into the validated value', () => {
    const r = validateEnvelope({ ...good, workspace_id: 'attacker-ws' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('workspace_id' in r.value).toBe(false);
      expect((r.value as Record<string, unknown>)['workspace_id']).toBeUndefined();
    }
  });
});

describe('buildProfileUpsert (AC5)', () => {
  it('upserts by (workspace_id, email) — the identity key — scoped to the workspace', () => {
    const q = buildProfileUpsert('ws-1', 'cust-1@acme.com', { plan: 'pro' });
    // workspace_id must be a bound parameter, present in values.
    expect(q.values[0]).toBe('ws-1');
    expect(q.values).toContain('cust-1@acme.com');
    expect(q.text).toMatch(/INSERT INTO profiles/i);
    expect(q.text).toMatch(/ON CONFLICT\s*\(\s*workspace_id\s*,\s*email\s*\)/i);
    expect(q.text).toMatch(/RETURNING id/i);
    // no string interpolation of the workspace id
    expect(q.text).not.toContain('ws-1');
  });

  it('seeds unsubscribed=false on INSERT, and merges only provided attrs on UPDATE', () => {
    const q = buildProfileUpsert('ws-1', 'cust-1@acme.com', { plan: 'pro' });
    // New profile starts subscribed (default merged UNDER provided attrs).
    expect(q.text).toContain(`'{"unsubscribed": false}'::jsonb || $3::jsonb`);
    // On conflict we merge ONLY $3 (not the default) so an existing
    // unsubscribed=true is never reset by a later profile event.
    expect(q.text).toMatch(/DO UPDATE SET attributes = profiles\.attributes \|\| \$3::jsonb/i);
  });
});

describe('buildSqsMessage', () => {
  it('sets MessageGroupId=profile_id and MessageDeduplicationId=event_id (§7)', () => {
    const cmd = buildSqsMessage('ws-1', 'profile-9', good, 'https://q/url.fifo');
    const input = cmd.input;
    expect(input.QueueUrl).toBe('https://q/url.fifo');
    expect(input.MessageGroupId).toBe('profile-9');
    expect(input.MessageDeduplicationId).toBe(good.event_id);
    const body = JSON.parse(input.MessageBody!);
    expect(body.workspace_id).toBe('ws-1');
    expect(body.profile_id).toBe('profile-9');
    expect(body.envelope.event_id).toBe(good.event_id);
  });
});
