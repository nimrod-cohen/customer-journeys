// Workspace scope is enforced SERVER-SIDE via scopedQuery on the token's
// workspace_id, NEVER a client body (§13, §18 "Tenant isolation" + "Multi-
// workspace switching"). REAL Postgres. We seed two workspaces each with their
// own segments/profiles and a user who is a member of BOTH, then prove:
//   - a wsA-active token only ever sees wsA rows (and vice-versa),
//   - a body-supplied workspace_id is IGNORED (the token wins),
//   - switching the active workspace re-scopes with no cross-bleed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { switchWorkspace, makePgLookups } from '../src/index.js';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS_A = '0c0d0e01-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e01-0000-4000-8000-000000000a02';
const USER = '0c0d0e01-0000-4000-8000-0000000000b1';
const SEG_A = '0c0d0e01-0000-4000-8000-0000000000c1';
const SEG_B = '0c0d0e01-0000-4000-8000-0000000000c2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('workspace scope + switching (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query(
        "INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')",
        [ws],
      );
      // The SAME user is an owner of both workspaces (the switcher case).
      await world.pool.query(
        "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [ws, USER],
      );
    }
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'segA','manual')",
      [SEG_A, WS_A],
    );
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'segB','manual')",
      [SEG_B, WS_B],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('a wsA token reads ONLY wsA segments (cannot see wsB)', async () => {
    const r = await call(world.env, 'GET', '/segments', { token: tokenFor(USER, WS_A) });
    expect(r.status).toBe(200);
    const ids = (r.body as { segments: { id: string }[] }).segments.map((s) => s.id);
    expect(ids).toContain(SEG_A);
    expect(ids).not.toContain(SEG_B);
  });

  it('a body-supplied workspace_id is IGNORED — the token scope wins', async () => {
    // Active token = wsA, but the body tries to point at wsB. Must still be wsA.
    const r = await call(world.env, 'GET', '/segments', {
      token: tokenFor(USER, WS_A),
      body: { workspace_id: WS_B },
    });
    const ids = (r.body as { segments: { id: string }[] }).segments.map((s) => s.id);
    expect(ids).toContain(SEG_A);
    expect(ids).not.toContain(SEG_B);
  });

  it('switching the active workspace re-scopes reads (no cross-bleed)', async () => {
    // Start on wsA, switch to wsB, then reads should flip to wsB only.
    const sw = await switchWorkspace(
      makePgLookups(world.pool),
      tokenFor(USER, WS_A),
      { workspace_id: WS_B },
    );
    expect(sw.status).toBe(200);
    const newToken = `Bearer ${(sw.body as { token: string }).token}`;
    const r = await call(world.env, 'GET', '/segments', { token: newToken });
    const ids = (r.body as { segments: { id: string }[] }).segments.map((s) => s.id);
    expect(ids).toContain(SEG_B);
    expect(ids).not.toContain(SEG_A);
  });

  it('a user cannot get a token active on a workspace they do not belong to', async () => {
    const stranger = '0c0d0e01-0000-4000-8000-0000000000ff';
    // Stranger has no membership → authorizer denies an active-wsA token (403).
    const r = await call(world.env, 'GET', '/segments', { token: tokenFor(stranger, WS_A) });
    expect(r.status).toBe(403);
  });
});
