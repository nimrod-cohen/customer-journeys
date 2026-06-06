import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runPlanInWorkspaceTx } from '../src/deps.js';
import { planProcessing } from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// AC4 — idempotency (§7/§18, CLAUDE.md invariant 5). The SAME event_id processed
// TWICE must be applied ONCE (INSERT events ON CONFLICT DO NOTHING). Real Postgres
// only — the dedupe guarantee lives in the DB. The processor runs as the SERVICE
// ROLE (BYPASSRLS) on the admin pool; isolation comes from in-code scoping, not RLS.
const RUN = hasDatabaseUrl();

// Unique fixture namespace for THIS file (cold-cache cross-file determinism).
const ws = 'd1d1d1d1-0000-0000-0000-000000000001';

function msg(eventId: string): ProcessorMessage {
  return {
    workspace_id: ws,
    profile_id: '', // resolved by upsert; not used directly here
    envelope: {
      event_id: eventId,
      external_id: 'dedup-cust',
      type: 'progress',
      occurred_at: '2026-06-06T00:00:00.000Z',
      attributes: { n: 1 },
    },
  };
}

describe.skipIf(!RUN)('processor idempotency on real Postgres (AC4)', () => {
  let admin: Pool;
  const eventId = 'eeee0001-0000-0000-0000-000000000001';

  beforeAll(async () => {
    admin = adminPool();
    await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'dedup')", [ws]);
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

  it('the same event_id applied twice results in exactly one events row', async () => {
    await runPlanInWorkspaceTx(admin, ws, planProcessing(msg(eventId)));
    await runPlanInWorkspaceTx(admin, ws, planProcessing(msg(eventId)));

    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND event_id = $2',
      [ws, eventId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('and exactly one profile exists for the external_id', async () => {
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND external_id = $2',
      [ws, 'dedup-cust'],
    );
    expect(rows[0].n).toBe(1);
  });
});
