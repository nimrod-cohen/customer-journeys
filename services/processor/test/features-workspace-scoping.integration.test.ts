import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runPlanInWorkspaceTx } from '../src/deps.js';
import { planProcessing } from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// Phase 4 — profile_features workspace scoping on real Postgres (AC2 / §3 / §7).
// The processor runs as the SERVICE ROLE (BYPASSRLS); isolation comes from
// in-code workspace_id scoping ($1) + the (workspace_id, external_id) subquery
// that resolves profile_id — NEVER from the client message. Two workspaces with
// the SAME external_id must keep fully separate profile_features rows that count
// only their own events.
const RUN = hasDatabaseUrl();

// Unique fixture namespace for THIS file.
const wsA = 'f5f5f5f5-0000-0000-0000-00000000000a';
const wsB = 'f5f5f5f5-0000-0000-0000-00000000000b';
const externalId = 'shared-feat-cust@acme.com';

function ev(ws: string, eventId: string, type: string, attributes: Record<string, unknown> = {}): ProcessorMessage {
  return {
    workspace_id: ws,
    profile_id: '',
    envelope: { event_id: eventId, email: externalId, type, occurred_at: '2026-06-06T00:00:00.000Z', attributes },
  };
}

async function cleanup(admin: Pool): Promise<void> {
  for (const ws of [wsA, wsB]) {
    await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
}

describe.skipIf(!RUN)('profile_features in-code workspace scoping (AC2)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  async function featFor(ws: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await admin.query(
      `SELECT pf.* FROM profile_features pf
       JOIN profiles p ON p.id = pf.profile_id
       WHERE pf.workspace_id = $1 AND p.workspace_id = $1 AND p.email = $2`,
      [ws, externalId],
    );
    return rows[0];
  }

  it('same external_id in two workspaces yields two SEPARATE feature rows', async () => {
    // ws-A: two purchases; ws-B: one progress
    await runPlanInWorkspaceTx(admin, wsA, planProcessing(ev(wsA, 'f5a00001-0000-0000-0000-000000000001', 'purchase', { amount: 10 })));
    await runPlanInWorkspaceTx(admin, wsA, planProcessing(ev(wsA, 'f5a00002-0000-0000-0000-000000000002', 'purchase', { amount: 5 })));
    await runPlanInWorkspaceTx(admin, wsB, planProcessing(ev(wsB, 'f5b00001-0000-0000-0000-000000000001', 'progress', {})));

    const a = await featFor(wsA);
    const b = await featFor(wsB);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // different profile rows
    expect(a!.profile_id).not.toBe(b!.profile_id);
    // ws-A counted only its own events
    expect(a!.total_events).toBe(2);
    expect(a!.counters).toEqual({ purchase: 2 });
    expect(Number(a!.monetary_total)).toBeCloseTo(15);
    // ws-B counted only its own events; no monetary
    expect(b!.total_events).toBe(1);
    expect(b!.counters).toEqual({ progress: 1 });
    expect(Number(b!.monetary_total)).toBe(0);
  });

  it("each feature row's workspace_id matches its own workspace (no cross-bleed)", async () => {
    const a = await featFor(wsA);
    const b = await featFor(wsB);
    expect(a!.workspace_id).toBe(wsA);
    expect(b!.workspace_id).toBe(wsB);
    // exactly one feature row per workspace
    const cntA = await admin.query('SELECT count(*)::int AS n FROM profile_features WHERE workspace_id = $1', [wsA]);
    const cntB = await admin.query('SELECT count(*)::int AS n FROM profile_features WHERE workspace_id = $1', [wsB]);
    expect(cntA.rows[0].n).toBe(1);
    expect(cntB.rows[0].n).toBe(1);
  });
});
