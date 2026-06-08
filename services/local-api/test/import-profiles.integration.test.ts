// Bulk profile CSV import (§7): UPSERT on (workspace_id, email). REAL Postgres.
// Proves new emails are created (seeded unsubscribed=false), existing emails have
// their attributes MERGED (preserving an existing unsubscribed flag unless the
// row supplies it), invalid rows are skipped, and everything is workspace-scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c1d2e09-1100-4000-8000-000000000a01';
const USER = '0c1d2e09-1100-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('bulk profile CSV import (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    // An existing profile that is unsubscribed — a re-import must NOT clobber that.
    await world.pool.query(
      `INSERT INTO profiles (workspace_id, email, attributes)
       VALUES ($1, 'existing@acme.com', '{"unsubscribed": true, "tier": "std"}'::jsonb)`,
      [WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('creates new profiles, merges into existing, and skips invalid rows', async () => {
    const r = await call(world.env, 'POST', '/profiles/import-csv', {
      token: tok(),
      body: {
        rows: [
          { email: 'NewOne@Acme.com', attributes: { tier: 'gold', plan: 'pro' } }, // new (lowercased)
          { email: 'existing@acme.com', attributes: { tier: 'vip' } }, // merge into existing
          { email: 'not-an-email', attributes: { x: 1 } }, // skipped
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, updated: 1, skipped: 1, total: 3 });

    // New profile created, lowercased, seeded unsubscribed=false + a features row.
    const nw = await world.pool.query(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND email = $2',
      [WS, 'newone@acme.com'],
    );
    expect(nw.rows[0].attributes).toEqual({ unsubscribed: false, tier: 'gold', plan: 'pro' });
    const feat = await world.pool.query(
      'SELECT 1 FROM profile_features pf JOIN profiles p ON p.id = pf.profile_id WHERE p.email = $1',
      ['newone@acme.com'],
    );
    expect(feat.rowCount).toBe(1);

    // Existing profile: tier overwritten by the row, unsubscribed PRESERVED.
    const ex = await world.pool.query(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND email = $2',
      [WS, 'existing@acme.com'],
    );
    expect(ex.rows[0].attributes).toEqual({ unsubscribed: true, tier: 'vip' });
  });

  it('rejects an empty import (400)', async () => {
    const r = await call(world.env, 'POST', '/profiles/import-csv', { token: tok(), body: { rows: [] } });
    expect(r.status).toBe(400);
  });
});
