// Broadcast COMPREHENSIVE AUDIENCE (§9A, CLAUDE.md): a broadcast's audience is a
// segment-style rule AST that mixes attribute/event conditions with segment-membership
// leaves ("is / is NOT a member of segment X") under AND/OR. DYNAMIC referenced segments
// resolve LIVE (their rule inlined), MANUAL ones via membership; compileWhere prepends
// workspace_id = $1 (inv. 6). A foreign segment id in the rule is rejected (inv. 2). The
// audience-preview gives a live count; a full SMS send (mock provider, no SES) proves the
// composed rule resolves to exactly the right recipients. Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ee5-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ee5-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ee5-0000-4000-8000-0000000000b1';
const SEG_GOLD = '0c0d0ee5-0000-4000-8000-0000000000d1'; // dynamic: tier = gold
const SEG_EXCL = '0c0d0ee5-0000-4000-8000-0000000000d2'; // manual: { pGoldExcl }
const SEG_FOREIGN = '0c0d0ee5-0000-4000-8000-0000000000d9'; // belongs to WS_B
const P_GOLD = '0c0d0ee5-0000-4000-8000-0000000000f1'; // gold, NOT excluded → the only match
const P_GOLD_EXCL = '0c0d0ee5-0000-4000-8000-0000000000f2'; // gold but in the exclude segment
const P_SILVER = '0c0d0ee5-0000-4000-8000-0000000000f3'; // silver → not gold

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// The audience: (in dynamic gold segment) AND (NOT in manual exclude segment).
const AUDIENCE = {
  op: 'and',
  conditions: [{ segment: SEG_GOLD }, { segment: SEG_EXCL, negate: true }],
};

describeMaybe('broadcast comprehensive audience rule (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const tok = () => tokenFor(OWNER, WS);
  const createBc = (body: Record<string, unknown>) =>
    dispatch({ method: 'POST', path: '/broadcasts', authorization: tok(), query: {}, body }, e());
  const sendBc = (id: string) =>
    dispatch({ method: 'POST', path: `/broadcasts/${id}/send`, authorization: tok(), query: {}, body: {} }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const w of [WS, WS_B]) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    // SEG_GOLD: dynamic rule tier = gold (inlined LIVE at send). SEG_EXCL: manual list.
    await pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind, definition, status) VALUES ($1,$2,'Gold','dynamic_realtime',$3::jsonb,'active')",
      [SEG_GOLD, WS, JSON.stringify({ field: 'attributes.tier', operator: '=', value: 'gold' })],
    );
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'Excluded','manual')", [SEG_EXCL, WS]);
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'Foreign','manual')", [SEG_FOREIGN, WS_B]);
    // Three profiles, all with a phone (so a matched recipient actually sends via the mock).
    for (const [pid, tier] of [
      [P_GOLD, 'gold'],
      [P_GOLD_EXCL, 'gold'],
      [P_SILVER, 'silver'],
    ] as const) {
      await pool.query(
        "INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,$3,$4::jsonb)",
        [pid, WS, `${pid}@example.com`, JSON.stringify({ tier, phone: '+972529461566', first_name: 'X' })],
      );
    }
    // Only P_GOLD_EXCL is in the exclude segment.
    await pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_EXCL, P_GOLD_EXCL, WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      for (const t of ['messages_log', 'usage_counters', 'outbox', 'broadcasts', 'segment_memberships', 'segments', 'profiles', 'workspace_users']) {
        await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [w]);
      }
      await pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  it('rejects an audience referencing a FOREIGN segment (inv. 2) → 400', async () => {
    const c = await createBc({
      name: 'Foreign',
      medium: 'sms',
      text_body: 'hi',
      audience: { op: 'and', conditions: [{ segment: SEG_FOREIGN }] },
    });
    expect(c.status).toBe(400);
    expect((c.body as { error: string }).error).toMatch(/unknown segment/i);
  });

  it('stores + round-trips the audience rule (audience_kind=rule), via getBroadcast', async () => {
    const c = await createBc({ name: 'Rule', medium: 'sms', text_body: 'hi', audience: AUDIENCE });
    expect(c.status).toBe(201);
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const g = await dispatch({ method: 'GET', path: `/broadcasts/${id}`, authorization: tok(), query: {}, body: {} }, e());
    const b = (g.body as { broadcast: { audience: unknown; audience_kind: string; audience_ref: string | null } }).broadcast;
    expect(b.audience).toEqual(AUDIENCE);
    expect(b.audience_kind).toBe('rule');
    expect(b.audience_ref).toBeNull();
  });

  it('audience-preview gives a LIVE count: only the gold, non-excluded profile', async () => {
    const p = await dispatch(
      { method: 'POST', path: '/broadcasts/audience-preview', authorization: tok(), query: {}, body: { audience: AUDIENCE } },
      e(),
    );
    expect(p.status).toBe(200);
    const body = p.body as { count: number; sample: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.sample.map((s) => s.id)).toEqual([P_GOLD]);
  });

  it('sends to EXACTLY the composed audience (gold AND not-excluded) — dynamic inlined live, manual via membership', async () => {
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    const c = await createBc({ name: 'Go', medium: 'sms', text_body: 'Hi {{customer.first_name}}', audience: AUDIENCE });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await sendBc(id);
    expect(r.status).toBe(200);
    // Exactly ONE recipient (P_GOLD): gold + not excluded. P_GOLD_EXCL excluded, P_SILVER not gold.
    const ml = await pool.query<{ profile_id: string; status: string; medium: string }>(
      'SELECT profile_id, status, medium FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0]!.profile_id).toBe(P_GOLD);
    expect(ml.rows[0]!.status).toBe('sent');
    expect(ml.rows[0]!.medium).toBe('sms');
  });
});
