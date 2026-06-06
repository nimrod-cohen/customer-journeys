import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runPlanInWorkspaceTx } from '../src/deps.js';
import { planProcessing } from '../src/core.js';
import type { ProcessorMessage } from '@cdp/shared';

// AC5 — processor workspace isolation (§3, §7, CLAUDE.md invariant 1). The
// Processor runs as the SERVICE ROLE which BYPASSES RLS. Its isolation therefore
// comes from in-code workspace_id scoping + the (workspace_id, external_id) key,
// NOT RLS. This test runs on the admin/service-role pool (mirrors
// services/api/test/service-role-scoping.integration.test.ts) and proves two
// workspaces with the SAME external_id stay fully separate. We do NOT SET ROLE to
// the non-BYPASSRLS test role for the processor path.
const RUN = hasDatabaseUrl();

// Unique fixture namespace for THIS file.
const wsA = 'd3d3d3d3-0000-0000-0000-00000000000a';
const wsB = 'd3d3d3d3-0000-0000-0000-00000000000b';
const externalId = 'shared-cust';

function ev(ws: string, eventId: string): ProcessorMessage {
  return {
    workspace_id: ws,
    profile_id: '',
    envelope: { event_id: eventId, external_id: externalId, type: 'profile_created', occurred_at: '2026-06-06T00:00:00.000Z', attributes: { ws } },
  };
}

describe.skipIf(!RUN)('processor in-code workspace isolation (AC5)', () => {
  let admin: Pool;
  beforeAll(async () => {
    admin = adminPool();
    for (const ws of [wsA, wsB]) {
      await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
  });
  afterAll(async () => {
    if (admin) {
      for (const ws of [wsA, wsB]) {
        await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
        await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
        await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      }
      await admin.end();
    }
  });

  it('the admin/service-role pool BYPASSES RLS (sees both workspaces) — RLS is no safety net', async () => {
    const { rows } = await admin.query('SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(rows[0].rolbypassrls).toBe(true);
  });

  it('same external_id in two workspaces yields two SEPARATE profiles (in-code scoping)', async () => {
    await runPlanInWorkspaceTx(admin, wsA, planProcessing(ev(wsA, 'fa000001-0000-0000-0000-000000000001')));
    await runPlanInWorkspaceTx(admin, wsB, planProcessing(ev(wsB, 'fb000001-0000-0000-0000-000000000001')));

    const a = await admin.query('SELECT id, attributes->>$2 AS w FROM profiles WHERE workspace_id = $1 AND external_id = $3', [wsA, 'ws', externalId]);
    const b = await admin.query('SELECT id, attributes->>$2 AS w FROM profiles WHERE workspace_id = $1 AND external_id = $3', [wsB, 'ws', externalId]);
    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(1);
    expect(a.rows[0].id).not.toBe(b.rows[0].id);
    expect(a.rows[0].w).toBe(wsA);
    expect(b.rows[0].w).toBe(wsB);
  });

  it('an event written under ws-A is never visible under ws-B scoping', async () => {
    const onlyA = await admin.query('SELECT count(*)::int AS n FROM events WHERE workspace_id = $1', [wsA]);
    const onlyB = await admin.query('SELECT count(*)::int AS n FROM events WHERE workspace_id = $1', [wsB]);
    expect(onlyA.rows[0].n).toBe(1);
    expect(onlyB.rows[0].n).toBe(1);
  });
});
