import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runPlanInWorkspaceTx } from '../src/deps.js';
import { planProcessing } from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// AC1/AC2 — order convergence (§7/§18, CLAUDE.md invariant 3). profile_created
// and progress for the SAME (workspace, external_id) must converge to ONE profile
// in BOTH orders. A progress-first arrival upserts a STUB; the later
// profile_created merges attributes. Real Postgres only — convergence lives in
// the (workspace_id, external_id) upsert. We do NOT test "SQS delivered in order".
const RUN = hasDatabaseUrl();

// Unique fixture namespace for THIS file.
const ws = 'd2d2d2d2-0000-0000-0000-000000000002';
const externalId = 'order-cust@acme.com';

function ev(type: string, eventId: string, attributes: Record<string, unknown>): ProcessorMessage {
  return {
    workspace_id: ws,
    profile_id: '',
    envelope: { event_id: eventId, email: externalId, type, occurred_at: '2026-06-06T00:00:00.000Z', attributes },
  };
}

const created = () => ev('profile_created', 'aaaa0001-0000-0000-0000-000000000001', { plan: 'pro' });
const progress = () => ev('progress', 'bbbb0001-0000-0000-0000-000000000001', { step: 5 });

async function reset(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'order')", [ws]);
}

describe.skipIf(!RUN)('processor order convergence on real Postgres (AC1/AC2)', () => {
  let admin: Pool;
  beforeEach(async () => {
    admin = admin ?? adminPool();
    await reset(admin);
  });
  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      await admin.end();
    }
  });

  it('created THEN progress → exactly ONE profile, both events stored', async () => {
    await runPlanInWorkspaceTx(admin, ws, planProcessing(created()));
    await runPlanInWorkspaceTx(admin, ws, planProcessing(progress()));

    const p = await admin.query(
      'SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND email = $2',
      [ws, externalId],
    );
    expect(p.rows[0].n).toBe(1);
    const e = await admin.query('SELECT count(*)::int AS n FROM events WHERE workspace_id = $1', [ws]);
    expect(e.rows[0].n).toBe(2);
  });

  it('progress FIRST (stub) THEN created → still exactly ONE profile, both events stored', async () => {
    await runPlanInWorkspaceTx(admin, ws, planProcessing(progress()));
    await runPlanInWorkspaceTx(admin, ws, planProcessing(created()));

    const p = await admin.query(
      'SELECT count(*)::int AS n, max(attributes->>$2) AS plan FROM profiles WHERE workspace_id = $1 AND email = $3',
      [ws, 'plan', externalId],
    );
    expect(p.rows[0].n).toBe(1);
    // the later profile_created merged its attributes onto the stub
    expect(p.rows[0].plan).toBe('pro');
    const e = await admin.query('SELECT count(*)::int AS n FROM events WHERE workspace_id = $1', [ws]);
    expect(e.rows[0].n).toBe(2);
  });
});
