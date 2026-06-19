// Workspace TIMEZONE setting (§9B clock): persisted on workspaces.settings.timezone
// via the existing PUT /workspace/settings (owner-gated, capability
// 'manage_workspace_users'), default 'UTC', invalid IANA zone rejected (400),
// workspace_id taken from ctx NEVER the body, jsonb merge preserves siblings.
// REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0e5e7711-0000-4000-8000-000000000a01';
const OTHER_WS = '0e5e7711-0000-4000-8000-000000000a02';
const USER = '0e5e7711-0000-4000-8000-0000000000b1'; // owner

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('workspace settings: timezone (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, OTHER_WS]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query(
        "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [ws, USER],
      );
    }
  });
  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    for (const ws of [WS, OTHER_WS]) {
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }
  const settingsOf = async (ws: string): Promise<Record<string, unknown>> => {
    const r = await world.pool.query('SELECT settings FROM workspaces WHERE id = $1', [ws]);
    return (r.rows[0]?.settings as Record<string, unknown>) ?? {};
  };

  it('defaults timezone to UTC for a fresh workspace', async () => {
    const r = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    expect(r.status).toBe(200);
    expect((r.body as { settings: { timezone: string } }).settings.timezone).toBe('UTC');
  });

  it('persists a valid IANA timezone and reads it back', async () => {
    const put = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { timezone: 'America/New_York' },
    });
    expect(put.status).toBe(200);
    expect((put.body as { settings: { timezone: string } }).settings.timezone).toBe('America/New_York');

    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    expect((get.body as { settings: { timezone: string } }).settings.timezone).toBe('America/New_York');
  });

  it('accepts an odd-but-valid zone (Asia/Jerusalem)', async () => {
    const put = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { timezone: 'Asia/Jerusalem' },
    });
    expect(put.status).toBe(200);
    expect((put.body as { settings: { timezone: string } }).settings.timezone).toBe('Asia/Jerusalem');
  });

  it('rejects an invalid IANA zone (400) and writes nothing', async () => {
    // set a known-good value first
    await call(world.env, 'PUT', '/workspace/settings', { token: tok(), body: { timezone: 'Europe/Paris' } });
    const bad = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { timezone: 'Not/AZone' },
    });
    expect(bad.status).toBe(400);
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    expect((get.body as { settings: { timezone: string } }).settings.timezone).toBe('Europe/Paris');
  });

  it('ignores a stray workspace_id in the body — updates ctx workspace only', async () => {
    await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { timezone: 'Europe/London', workspace_id: OTHER_WS },
    });
    expect((await settingsOf(WS)).timezone).toBe('Europe/London');
    // OTHER_WS must be untouched by the stray id.
    expect((await settingsOf(OTHER_WS)).timezone).toBeUndefined();
  });

  it('merges timezone without clobbering link_tracking / lowercase_emails', async () => {
    await call(world.env, 'PUT', '/workspace/settings', { token: tok(), body: { link_tracking: true } });
    await call(world.env, 'PUT', '/workspace/settings', { token: tok(), body: { timezone: 'Asia/Tokyo' } });
    const s = await settingsOf(WS);
    expect(s.timezone).toBe('Asia/Tokyo');
    expect(s.link_tracking).toBe(true);
  });
});
