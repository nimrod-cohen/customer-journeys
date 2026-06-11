// Saving a DYNAMIC segment materializes its membership immediately, so the
// segment's members AND each matching profile's Segments tab are consistent with
// the rule right away (not only after the next event/sweep). REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e0e-0000-4000-8000-000000000a01';
const USER = '0c0d0e0e-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('dynamic segment materializes on save (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);
  const vipRule = { field: 'attributes.tier', operator: '=', value: 'vip' };
  let vip1 = '';
  let std1 = '';

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    const mk = async (email: string, tier: string) => {
      const r = await world.pool.query<{ id: string }>(
        `INSERT INTO profiles (workspace_id, email, email_status, attributes)
         VALUES ($1,$2,'active', jsonb_build_object('tier',$3::text)) RETURNING id`,
        [WS, email, tier],
      );
      return r.rows[0]!.id;
    };
    vip1 = await mk('vip1@acme.com', 'vip');
    await mk('vip2@acme.com', 'vip');
    std1 = await mk('std1@acme.com', 'std');
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('creating the segment populates membership for matching profiles', async () => {
    const create = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'VIP members', kind: 'dynamic_realtime', definition: vipRule },
    });
    const sid = (create.body as { segment: { id: string } }).segment.id;

    // The segment's members list shows the two VIPs (materialized, source evaluator).
    const mem = await call(world.env, 'GET', `/segments/${sid}/members`, { token: tok() });
    expect((mem.body as { size: number }).size).toBe(2);

    // The matching profile's Segments tab includes it (evaluated LIVE → source 'live');
    // the non-matching one doesn't.
    const segs = await call(world.env, 'GET', `/profiles/${vip1}/segments`, { token: tok() });
    const names = (segs.body as { segments: Array<{ name: string; source: string }> }).segments;
    expect(names.some((s) => s.name === 'VIP members' && s.source === 'live')).toBe(true);

    const other = await call(world.env, 'GET', `/profiles/${std1}/segments`, { token: tok() });
    expect((other.body as { segments: Array<{ name: string }> }).segments.some((s) => s.name === 'VIP members')).toBe(
      false,
    );
  });

  it('emptying the rules (draft) removes the materialized membership', async () => {
    const create = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'Toggle', kind: 'dynamic_realtime', definition: vipRule },
    });
    const sid = (create.body as { segment: { id: string } }).segment.id;
    expect((await call(world.env, 'GET', `/segments/${sid}/members`, { token: tok() })).body as { size: number }).toMatchObject({ size: 2 });

    // Remove all rules → draft → membership cleared.
    await call(world.env, 'PUT', `/segments/${sid}`, { token: tok(), body: { name: 'Toggle', definition: null } });
    expect((await call(world.env, 'GET', `/segments/${sid}/members`, { token: tok() })).body as { size: number }).toMatchObject({ size: 0 });

    // Re-add the rule → membership repopulates.
    await call(world.env, 'PUT', `/segments/${sid}`, { token: tok(), body: { name: 'Toggle', definition: vipRule } });
    expect((await call(world.env, 'GET', `/segments/${sid}/members`, { token: tok() })).body as { size: number }).toMatchObject({ size: 2 });
  });
});
