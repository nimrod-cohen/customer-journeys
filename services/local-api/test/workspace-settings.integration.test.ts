// Workspace settings (§12): the `lowercase_emails` policy governs the STORED
// casing of customer emails on write (manual create/edit). REAL Postgres. Proves
// GET/PUT and that creating a profile honours the policy (on → lowercased; off →
// preserved). Email matching is case-insensitive (citext) regardless.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0e5e7700-0000-4000-8000-000000000a01';
const USER = '0e5e7700-0000-4000-8000-0000000000b1'; // owner

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('workspace settings: lowercase_emails (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS, USER],
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
  const storedEmail = async (ext: string): Promise<string | null> => {
    const r = await world.pool.query('SELECT email FROM profiles WHERE workspace_id = $1 AND external_id = $2', [WS, ext]);
    return (r.rows[0]?.email as string | undefined) ?? null;
  };

  it('defaults to lowercase_emails = true', async () => {
    const r = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    expect(r.status).toBe(200);
    expect((r.body as { settings: { lowercase_emails: boolean } }).settings.lowercase_emails).toBe(true);
  });

  it('with the policy ON, a created email is stored lowercased', async () => {
    const c = await call(world.env, 'POST', '/profiles', {
      token: tok(),
      body: { email: 'Upper.Case@Acme.com', external_id: 'p-on' },
    });
    expect(c.status).toBe(201);
    expect(await storedEmail('p-on')).toBe('upper.case@acme.com');
  });

  it('turning the policy OFF preserves the entered casing', async () => {
    const put = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { lowercase_emails: false },
    });
    expect(put.status).toBe(200);
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    expect((get.body as { settings: { lowercase_emails: boolean } }).settings.lowercase_emails).toBe(false);

    const c = await call(world.env, 'POST', '/profiles', {
      token: tok(),
      body: { email: 'Mixed.Case@Acme.com', external_id: 'p-off' },
    });
    expect(c.status).toBe(201);
    expect(await storedEmail('p-off')).toBe('Mixed.Case@Acme.com');
  });

  // Sending guardrails (CLAUDE.md inv.7): frequency cap + quiet-hours window that
  // the dispatcher reads from workspaces.settings.
  type Guard = { frequency_cap_per_days: number; quiet_hours: { startHour: number; endHour: number } | null };

  it('defaults the guardrails to 0 cap / no quiet hours', async () => {
    const r = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    const s = (r.body as { settings: Guard }).settings;
    expect(s.frequency_cap_per_days).toBe(0);
    expect(s.quiet_hours).toBeNull();
  });

  it('persists a valid cap + quiet-hours window and round-trips it', async () => {
    const put = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { frequency_cap_per_days: 3, quiet_hours: { startHour: 22, endHour: 8 } },
    });
    expect(put.status).toBe(200);
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    const s = (get.body as { settings: Guard }).settings;
    expect(s.frequency_cap_per_days).toBe(3);
    expect(s.quiet_hours).toEqual({ startHour: 22, endHour: 8 });
  });

  it('clears quiet hours when passed null', async () => {
    await call(world.env, 'PUT', '/workspace/settings', { token: tok(), body: { quiet_hours: null } });
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    expect((get.body as { settings: Guard }).settings.quiet_hours).toBeNull();
  });

  it('rejects an invalid cap (negative) and an out-of-range quiet hour (400)', async () => {
    const badCap = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { frequency_cap_per_days: -1 },
    });
    expect(badCap.status).toBe(400);
    const badHour = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { quiet_hours: { startHour: 24, endHour: 8 } },
    });
    expect(badHour.status).toBe(400);
  });
});
