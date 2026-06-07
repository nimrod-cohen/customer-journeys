// Cross-workspace WRITE/ACTION isolation (§13, §18 "Tenant isolation"), proven
// against REAL Postgres. Unlike workspace-scope.integration (which proves READS
// are scoped), this proves a workspace-A token cannot ACT ON or MUTATE a
// workspace-B resource by guessing its id — even with a capability (manage_content)
// that is perfectly valid inside its OWN workspace.
//
// Regression guard for the confirmed bug: POST /broadcasts/:id/send ignored the
// auth context and ran runBroadcast() on any id (runBroadcast loads workspace_id
// FROM the row), letting a WS-A marketer trigger a WS-B send. The fix verifies the
// broadcast belongs to ctx.workspaceId (token, never body) and returns 404 otherwise.
//
// SES/SQS/DNS are mocked at the deps boundary; Postgres is NEVER mocked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS_A = '0c0d0e05-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e05-0000-4000-8000-000000000a02';
// A WS-A owner and a WS-A marketer — both have manage_content INSIDE WS-A only.
const OWNER_A = '0c0d0e05-0000-4000-8000-0000000000b1';
const MKT_A = '0c0d0e05-0000-4000-8000-0000000000b2';

// WS-B resources the attacker (WS-A token) will try to act on by id.
const SEG_B = '0c0d0e05-0000-4000-8000-0000000000c2';
const TPL_B = '0c0d0e05-0000-4000-8000-0000000000d2';
const PROF_B = '0c0d0e05-0000-4000-8000-0000000000e2';
const BCAST_B = '0c0d0e05-0000-4000-8000-0000000000f2';
const CAMP_B = '0c0d0e05-0000-4000-8000-0000000000a9';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('cross-workspace action isolation (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query(
        "INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')",
        [ws],
      );
    }
    // The attacker users belong ONLY to WS-A (not WS-B).
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_A, OWNER_A],
    );
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')",
      [WS_A, MKT_A],
    );

    // --- Seed WS-B's content: a manual segment with one member, a template, and a
    // sendable (draft, has template) broadcast targeting that segment. ---
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'B Manual VIPs','manual')",
      [SEG_B, WS_B],
    );
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'b-1','b1@example.com')",
      [PROF_B, WS_B],
    );
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_B, PROF_B, WS_B],
    );
    await world.pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'B tpl','<mjml/>','<html/>')",
      [TPL_B, WS_B],
    );
    await world.pool.query(
      `INSERT INTO broadcasts (id, workspace_id, name, template_id, audience_kind, audience_ref, status)
       VALUES ($1,$2,'B blast',$3,'segment',$4,'draft')`,
      [BCAST_B, WS_B, TPL_B, SEG_B],
    );
    await world.pool.query(
      `INSERT INTO campaigns (id, workspace_id, name, definition, status)
       VALUES ($1,$2,'B campaign','{}'::jsonb,'draft')`,
      [CAMP_B, WS_B],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    // outbox/memberships first (FKs), then content, then memberships, then ws.
    await world.pool.query('DELETE FROM outbox WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await world.pool.query('DELETE FROM broadcasts WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await world.pool.query('DELETE FROM campaigns WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = ANY($1)', [
      [WS_A, WS_B],
    ]);
    await world.pool.query('DELETE FROM email_templates WHERE workspace_id = ANY($1)', [
      [WS_A, WS_B],
    ]);
    await world.pool.query('DELETE FROM segments WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [
      [WS_A, WS_B],
    ]);
    await world.pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);
  }

  async function bcastStatus(): Promise<string | undefined> {
    const { rows } = await world.pool.query<{ status: string }>(
      'SELECT status FROM broadcasts WHERE id = $1',
      [BCAST_B],
    );
    return rows[0]?.status;
  }
  async function outboxCount(): Promise<number> {
    const { rows } = await world.pool.query<{ c: string }>(
      'SELECT count(*)::int AS c FROM outbox WHERE workspace_id = $1',
      [WS_B],
    );
    return Number(rows[0]?.c ?? 0);
  }

  it('WS-A marketer CANNOT send a WS-B broadcast by id → 404, no send, status unchanged', async () => {
    expect(await bcastStatus()).toBe('draft');
    const before = await outboxCount();

    const r = await call(world.env, 'POST', `/broadcasts/${BCAST_B}/send`, {
      token: tokenFor(MKT_A, WS_A),
    });

    // Do NOT reveal existence: 404, not 403.
    expect(r.status).toBe(404);
    // The broadcast core must NOT have run: status stays draft, no outbox created.
    expect(await bcastStatus()).toBe('draft');
    expect(await outboxCount()).toBe(before);
  });

  it('WS-A owner ALSO cannot send a WS-B broadcast by id (capability is per-workspace)', async () => {
    const r = await call(world.env, 'POST', `/broadcasts/${BCAST_B}/send`, {
      token: tokenFor(OWNER_A, WS_A),
    });
    expect(r.status).toBe(404);
    expect(await bcastStatus()).toBe('draft');
    expect(await outboxCount()).toBe(0);
  });

  it('a WS-A owner CAN send their OWN broadcast (positive control: guard does not over-block)', async () => {
    const SEG_A = '0c0d0e05-0000-4000-8000-0000000000c1';
    const TPL_A = '0c0d0e05-0000-4000-8000-0000000000d1';
    const PROF_A = '0c0d0e05-0000-4000-8000-0000000000e1';
    const BCAST_A = '0c0d0e05-0000-4000-8000-0000000000f1';
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'A Manual VIPs','manual')",
      [SEG_A, WS_A],
    );
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'a-1','a1@example.com')",
      [PROF_A, WS_A],
    );
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_A, PROF_A, WS_A],
    );
    await world.pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'A tpl','<mjml/>','<html/>')",
      [TPL_A, WS_A],
    );
    await world.pool.query(
      `INSERT INTO broadcasts (id, workspace_id, name, template_id, audience_kind, audience_ref, status)
       VALUES ($1,$2,'A blast',$3,'segment',$4,'draft')`,
      [BCAST_A, WS_A, TPL_A, SEG_A],
    );

    const r = await call(world.env, 'POST', `/broadcasts/${BCAST_A}/send`, {
      token: tokenFor(OWNER_A, WS_A),
    });
    expect(r.status).toBe(200);
    expect((r.body as { result: { result: string } }).result.result).toBe('sent');
    // WS-A got its own outbox row; WS-B was never touched.
    const { rows } = await world.pool.query<{ c: string }>(
      'SELECT count(*)::int AS c FROM outbox WHERE workspace_id = $1',
      [WS_A],
    );
    expect(Number(rows[0]?.c)).toBe(1);
    expect(await outboxCount()).toBe(0);
  });

  it('WS-A token CANNOT mutate a WS-B campaign by id (PUT) → row unchanged', async () => {
    const r = await call(world.env, 'PUT', `/campaigns/${CAMP_B}`, {
      token: tokenFor(MKT_A, WS_A),
      body: { name: 'HIJACKED', status: 'archived' },
    });
    // scopedQuery confines the UPDATE to WS-A → zero rows touched.
    expect(r.status).toBe(200);
    expect((r.body as { updated: number }).updated).toBe(0);
    const { rows } = await world.pool.query<{ name: string; status: string }>(
      'SELECT name, status FROM campaigns WHERE id = $1',
      [CAMP_B],
    );
    expect(rows[0]?.name).toBe('B campaign');
    expect(rows[0]?.status).toBe('draft');
  });

  it('WS-A token CANNOT mutate a WS-B segment by id (PUT) → row unchanged', async () => {
    const r = await call(world.env, 'PUT', `/segments/${SEG_B}`, {
      token: tokenFor(MKT_A, WS_A),
      body: { name: 'HIJACKED' },
    });
    expect(r.status).toBe(200);
    expect((r.body as { updated: number }).updated).toBe(0);
    const { rows } = await world.pool.query<{ name: string }>(
      'SELECT name FROM segments WHERE id = $1',
      [SEG_B],
    );
    expect(rows[0]?.name).toBe('B Manual VIPs');
  });

  it('WS-A token CANNOT add members to a WS-B segment by id → 404, no membership written', async () => {
    // Even though the manual-members builder tags rows with the TOKEN workspace,
    // the segment row itself belongs to WS-B, so the action must be refused.
    const PROF_A2 = '0c0d0e05-0000-4000-8000-0000000000e3';
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'a-2','a2@example.com')",
      [PROF_A2, WS_A],
    );
    const before = await world.pool.query<{ c: string }>(
      'SELECT count(*)::int AS c FROM segment_memberships WHERE segment_id = $1',
      [SEG_B],
    );
    const r = await call(world.env, 'POST', `/segments/${SEG_B}/members`, {
      token: tokenFor(MKT_A, WS_A),
      body: { profile_ids: [PROF_A2] },
    });
    expect(r.status).toBe(404);
    const after = await world.pool.query<{ c: string }>(
      'SELECT count(*)::int AS c FROM segment_memberships WHERE segment_id = $1',
      [SEG_B],
    );
    expect(Number(after.rows[0]?.c)).toBe(Number(before.rows[0]?.c));
  });
});
