// On-the-fly profile filtering (CLAUDE.md): POST /profiles/query takes an AD-HOC §8 rule
// (the SAME RuleBuilder shape segments + broadcast audiences use) and returns the matching
// profiles + a count. Attribute/event conditions AND segment-membership leaves under AND/OR;
// dynamic referenced segments inlined LIVE, manual via membership; workspace_id = $1 always
// (inv. 6); a foreign segment ref is rejected (inv. 2). Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ee6-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ee6-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ee6-0000-4000-8000-0000000000b1';
const SEG_DYN = '0c0d0ee6-0000-4000-8000-0000000000d1'; // dynamic tier=gold
const SEG_FOREIGN = '0c0d0ee6-0000-4000-8000-0000000000d9'; // in WS_B
const P_GOLD = '0c0d0ee6-0000-4000-8000-0000000000f1';
const P_GOLD2 = '0c0d0ee6-0000-4000-8000-0000000000f2';
const P_SILVER = '0c0d0ee6-0000-4000-8000-0000000000f3';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('POST /profiles/query — ad-hoc profile filter (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const query = (definition: unknown) =>
    dispatch({ method: 'POST', path: '/profiles/query', authorization: tokenFor(OWNER, WS), query: {}, body: { definition } }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const w of [WS, WS_B]) await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind, definition, status) VALUES ($1,$2,'Gold','dynamic_realtime',$3::jsonb,'active')",
      [SEG_DYN, WS, JSON.stringify({ field: 'attributes.tier', operator: '=', value: 'gold' })],
    );
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'Foreign','manual')", [SEG_FOREIGN, WS_B]);
    for (const [pid, tier] of [[P_GOLD, 'gold'], [P_GOLD2, 'gold'], [P_SILVER, 'silver']] as const) {
      await pool.query("INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,$3,$4::jsonb)", [
        pid,
        WS,
        `${pid}@x.com`,
        JSON.stringify({ tier }),
      ]);
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      for (const t of ['segment_memberships', 'segments', 'profiles', 'workspace_users']) {
        await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [w]);
      }
      await pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  it('a NULL rule returns the whole workspace (newest-first)', async () => {
    const r = await query(null);
    expect(r.status).toBe(200);
    const body = r.body as { profiles: Array<{ id: string }>; size: number };
    expect(body.size).toBe(3);
    expect(body.profiles).toHaveLength(3);
  });

  it('an attribute rule filters server-side (tier = gold → 2 profiles)', async () => {
    const r = await query({ field: 'attributes.tier', operator: '=', value: 'gold' });
    const body = r.body as { profiles: Array<{ id: string }>; size: number };
    expect(body.size).toBe(2);
    expect(body.profiles.map((p) => p.id).sort()).toEqual([P_GOLD, P_GOLD2].sort());
  });

  it('a segment-membership rule inlines a DYNAMIC segment LIVE', async () => {
    const r = await query({ segment: SEG_DYN });
    const body = r.body as { profiles: Array<{ id: string }>; size: number };
    expect(body.size).toBe(2); // tier=gold, resolved live (no materialized membership needed)
    expect(body.profiles.map((p) => p.id).sort()).toEqual([P_GOLD, P_GOLD2].sort());
  });

  it('returns the FULL profile shape (id, email, attributes, …)', async () => {
    const r = await query({ field: 'attributes.tier', operator: '=', value: 'silver' });
    const p = (r.body as { profiles: Array<Record<string, unknown>> }).profiles[0]!;
    expect(p).toMatchObject({ id: P_SILVER, email: `${P_SILVER}@x.com` });
    expect(p).toHaveProperty('external_id');
    expect(p).toHaveProperty('created_at_unix');
    expect((p.attributes as { tier: string }).tier).toBe('silver');
  });

  it('rejects a FOREIGN segment id in the rule (inv. 2) → 400', async () => {
    const r = await query({ segment: SEG_FOREIGN });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/unknown segment/i);
  });
});
