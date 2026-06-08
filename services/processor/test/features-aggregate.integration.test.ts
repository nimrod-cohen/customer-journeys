import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runPlanInWorkspaceTx } from '../src/deps.js';
import { planProcessing } from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// Phase 4 — profile_features aggregation on real Postgres (§6, §7 step 3).
// Proves AC: events roll up into profile_features (total_events, counters,
// monetary_total, last_event_at, last_email_open_at) AND that a replayed
// event_id does NOT double-count — the inner INSERT returns no row, `ins` is
// empty, WHERE EXISTS(ins) yields nothing, profile_features is untouched.
// Runs the EXACT prod path (runPlanInWorkspaceTx) on the service-role pool.
const RUN = hasDatabaseUrl();

// Unique fixture namespace for THIS file (cold-cache cross-file determinism).
const ws = 'f4f4f4f4-0000-0000-0000-000000000001';
const externalId = 'feat-cust@acme.com';

function ev(
  eventId: string,
  type: string,
  attributes: Record<string, unknown> = {},
  occurredAt = '2026-06-06T00:00:00.000Z',
): ProcessorMessage {
  return {
    workspace_id: ws,
    profile_id: '',
    envelope: { event_id: eventId, email: externalId, type, occurred_at: occurredAt, attributes },
  };
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

describe.skipIf(!RUN)('profile_features aggregation on real Postgres (AC1 + replay)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'features')", [ws]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  async function feat(): Promise<Record<string, unknown> | undefined> {
    const { rows } = await admin.query(
      `SELECT pf.* FROM profile_features pf
       JOIN profiles p ON p.id = pf.profile_id
       WHERE p.workspace_id = $1 AND p.email = $2`,
      [ws, externalId],
    );
    return rows[0];
  }

  it('first event creates a profile_features row with total_events=1', async () => {
    await runPlanInWorkspaceTx(
      admin,
      ws,
      planProcessing(ev('f4ea0001-0000-0000-0000-000000000001', 'progress', {}, '2026-06-01T00:00:00.000Z')),
    );
    const f = await feat();
    expect(f).toBeDefined();
    expect(f!.total_events).toBe(1);
    expect(f!.counters).toEqual({ progress: 1 });
    expect(Number(f!.monetary_total)).toBe(0);
    expect(new Date(f!.last_event_at as string).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(f!.last_email_open_at).toBeNull();
  });

  it('a purchase rolls up monetary_total and a per-type counter', async () => {
    await runPlanInWorkspaceTx(
      admin,
      ws,
      planProcessing(ev('f4ea0002-0000-0000-0000-000000000002', 'purchase', { amount: 19.99 }, '2026-06-03T00:00:00.000Z')),
    );
    const f = await feat();
    expect(f!.total_events).toBe(2);
    expect(f!.counters).toEqual({ progress: 1, purchase: 1 });
    expect(Number(f!.monetary_total)).toBeCloseTo(19.99);
    expect(new Date(f!.last_event_at as string).toISOString()).toBe('2026-06-03T00:00:00.000Z');
  });

  it('an email_open sets last_email_open_at (MAX) without touching monetary_total', async () => {
    await runPlanInWorkspaceTx(
      admin,
      ws,
      planProcessing(ev('f4ea0003-0000-0000-0000-000000000003', 'email_open', {}, '2026-06-04T00:00:00.000Z')),
    );
    const f = await feat();
    expect(f!.total_events).toBe(3);
    expect(new Date(f!.last_email_open_at as string).toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(Number(f!.monetary_total)).toBeCloseTo(19.99);
  });

  it('a later non-open event does NOT change last_email_open_at; last_event_at advances', async () => {
    await runPlanInWorkspaceTx(
      admin,
      ws,
      planProcessing(ev('f4ea0004-0000-0000-0000-000000000004', 'progress', {}, '2026-06-10T00:00:00.000Z')),
    );
    const f = await feat();
    expect(f!.total_events).toBe(4);
    expect(f!.counters).toEqual({ progress: 2, purchase: 1, email_open: 1 });
    expect(new Date(f!.last_email_open_at as string).toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(new Date(f!.last_event_at as string).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('REPLAY: the same event_id reprocessed does NOT double-count (gate via WHERE EXISTS ins)', async () => {
    const before = await feat();
    // replay the purchase event_id verbatim
    await runPlanInWorkspaceTx(
      admin,
      ws,
      planProcessing(ev('f4ea0002-0000-0000-0000-000000000002', 'purchase', { amount: 19.99 }, '2026-06-03T00:00:00.000Z')),
    );
    const after = await feat();
    expect(after!.total_events).toBe(before!.total_events);
    expect(after!.counters).toEqual(before!.counters);
    expect(Number(after!.monetary_total)).toBeCloseTo(Number(before!.monetary_total));
    // and still exactly one events row for that id
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND event_id = $2',
      [ws, 'f4ea0002-0000-0000-0000-000000000002'],
    );
    expect(rows[0].n).toBe(1);
  });
});
