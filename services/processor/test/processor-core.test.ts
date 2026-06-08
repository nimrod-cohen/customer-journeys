import { describe, it, expect } from 'vitest';
import {
  parseProcessorMessage,
  buildEventInsert,
  buildProcessorProfileUpsert,
  planProcessing,
} from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// AC1/AC2/AC4 — the pure processor core.
//   parseProcessorMessage: validate the trusted message body ingest wrote.
//   buildEventInsert: INSERT events ... ON CONFLICT(event_id) DO NOTHING (idempotency).
//   buildProcessorProfileUpsert: stub-or-upsert by (workspace_id, external_id) (ordering).
//   planProcessing: the ordered list of scoped statements the handler runs in a tx.

const msg: ProcessorMessage = {
  workspace_id: 'ws-1',
  profile_id: 'profile-1',
  envelope: {
    event_id: '00000000-0000-0000-0000-0000000000aa',
    email: 'cust-1@acme.com',
    type: 'progress',
    occurred_at: '2026-06-06T00:00:00.000Z',
    attributes: { step: 2 },
  },
};

describe('parseProcessorMessage (AC1)', () => {
  it('parses a valid JSON body produced by ingest', () => {
    const r = parseProcessorMessage(JSON.stringify(msg));
    expect(r.workspace_id).toBe('ws-1');
    expect(r.profile_id).toBe('profile-1');
    expect(r.envelope.event_id).toBe(msg.envelope.event_id);
  });

  it('throws on a body missing workspace_id (must not be inferred)', () => {
    const bad = { ...msg, workspace_id: undefined };
    expect(() => parseProcessorMessage(JSON.stringify(bad))).toThrow();
  });

  it('throws on a body missing profile_id', () => {
    const bad = { ...msg, profile_id: '' };
    expect(() => parseProcessorMessage(JSON.stringify(bad))).toThrow();
  });

  it('throws on non-JSON', () => {
    expect(() => parseProcessorMessage('not json')).toThrow();
  });
});

describe('buildEventInsert (AC4 idempotency)', () => {
  it('inserts ON CONFLICT(event_id) DO NOTHING, workspace-scoped via params', () => {
    const q = buildEventInsert(msg);
    expect(q.text).toMatch(/INSERT INTO events/i);
    expect(q.text).toMatch(/ON CONFLICT\s*\(\s*event_id\s*\)\s*DO NOTHING/i);
    expect(q.values).toContain('ws-1');
    expect(q.values).toContain(msg.envelope.event_id);
    expect(q.values).toContain(msg.envelope.type);
    // profile_id is resolved by a (workspace_id, email) subquery — it links
    // to the SAME profile the upsert created in this tx, never a client value.
    expect(q.text).toMatch(/FROM profiles/i);
    expect(q.values).toContain(msg.envelope.email);
    // no interpolation
    expect(q.text).not.toContain('ws-1');
  });
});

describe('buildProcessorProfileUpsert (AC2 ordering)', () => {
  it('upserts by (workspace_id, email); progress-first creates a stub', () => {
    const q = buildProcessorProfileUpsert(msg);
    expect(q.text).toMatch(/INSERT INTO profiles/i);
    expect(q.text).toMatch(/ON CONFLICT\s*\(\s*workspace_id\s*,\s*email\s*\)/i);
    expect(q.values[0]).toBe('ws-1');
    expect(q.values).toContain('cust-1@acme.com');
  });

  it('merges attributes on profile_created (not just stub)', () => {
    const created: ProcessorMessage = {
      ...msg,
      envelope: { ...msg.envelope, type: 'profile_created', attributes: { plan: 'pro' } },
    };
    const q = buildProcessorProfileUpsert(created);
    // attributes payload travels as a bound JSON param
    expect(q.values.some((v) => typeof v === 'string' && v.includes('plan'))).toBe(true);
  });
});

describe('planProcessing (AC1/AC2/AC4)', () => {
  it('plans profile-upsert THEN event-insert (stub must exist before the event FK)', () => {
    const plan = planProcessing(msg);
    expect(plan.workspaceId).toBe('ws-1');
    expect(plan.statements.length).toBeGreaterThanOrEqual(2);
    const texts = plan.statements.map((s) => s.text);
    const upsertIdx = texts.findIndex((t) => /INSERT INTO profiles/i.test(t));
    const eventIdx = texts.findIndex((t) => /INSERT INTO events/i.test(t));
    expect(upsertIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeLessThan(eventIdx);
  });

  it('every statement is workspace-scoped (ws-1 bound in values)', () => {
    const plan = planProcessing(msg);
    for (const s of plan.statements) {
      expect(s.values).toContain('ws-1');
    }
  });
});
