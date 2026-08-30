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

  // Sending guardrails (CLAUDE.md inv.7): frequency cap { max, days } + a per-weekday
  // quiet-hours schedule, read by the dispatcher from workspaces.settings.
  type Guard = {
    frequency_cap: { max: number; days: number } | null;
    quiet_hours: Array<{ startDay: number; startMinute: number; endDay: number; endMinute: number }> | null;
  };

  it('defaults the guardrails to no cap / no quiet hours', async () => {
    const r = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    const s = (r.body as { settings: Guard }).settings;
    expect(s.frequency_cap).toBeNull();
    expect(s.quiet_hours).toBeNull();
  });

  it('persists a valid cap + quiet-window list and round-trips it', async () => {
    const windows = [
      { startDay: 5, startMinute: 960, endDay: 6, endMinute: 1260 }, // Fri 16:00 → Sat 21:00
      { startDay: 0, startMinute: 1320, endDay: 1, endMinute: 0 }, // Sun 22:00 → Mon 00:00
    ];
    const put = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { frequency_cap: { max: 2, days: 3 }, quiet_hours: windows },
    });
    expect(put.status).toBe(200);
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    const s = (get.body as { settings: Guard }).settings;
    expect(s.frequency_cap).toEqual({ max: 2, days: 3 });
    expect(s.quiet_hours).toEqual(windows);
  });

  it('clears the cap + quiet hours when passed null', async () => {
    await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { quiet_hours: null, frequency_cap: null },
    });
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
    const s = (get.body as { settings: Guard }).settings;
    expect(s.quiet_hours).toBeNull();
    expect(s.frequency_cap).toBeNull();
  });

  // The From is WORKSPACE-level: sending domains and named senders are per
  // workspace, so a company-wide value would make every workspace send as one
  // address regardless of the domain it actually verified.
  describe('default_from', () => {
    const put = (default_from: unknown) =>
      call(world.env, 'PUT', '/workspace/settings', { token: tok(), body: { default_from } });
    const read = async (): Promise<string | null> => {
      const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
      return (get.body as { settings: { default_from: string | null } }).settings.default_from;
    };

    it('accepts a bare address and a display form', async () => {
      await put('hello@acme.com');
      expect(await read()).toBe('hello@acme.com');
      await put('Acme Ltd. <hello@acme.com>');
      expect(await read()).toBe('Acme Ltd. <hello@acme.com>');
    });

    it('trims, and clears with null or an empty string', async () => {
      await put('  hello@acme.com  ');
      expect(await read()).toBe('hello@acme.com');
      await put(null);
      expect(await read()).toBeNull();
      await put('x@y.co');
      await put('');
      expect(await read()).toBeNull();
    });

    // A malformed From produces mail every provider bounces, so catch it here
    // rather than at send time.
    it('rejects a malformed address and writes nothing', async () => {
      await put('good@acme.com');
      for (const bad of ['not-an-email', 'a@b', 'Name <not-an-email>', '@acme.com', 42]) {
        expect((await put(bad)).status, `${String(bad)} should be rejected`).toBe(400);
      }
      expect(await read()).toBe('good@acme.com');
    });

    // The merge must not disturb siblings (CLAUDE.md: sibling-preserving jsonb merge).
    it('leaves other settings untouched', async () => {
      await call(world.env, 'PUT', '/workspace/settings', { token: tok(), body: { timezone: 'Asia/Jerusalem' } });
      await put('hello@acme.com');
      const get = await call(world.env, 'GET', '/workspace/settings', { token: tok() });
      expect((get.body as { settings: { timezone: string } }).settings.timezone).toBe('Asia/Jerusalem');
    });
  });

  it('rejects an invalid cap and an out-of-range quiet hour (400)', async () => {
    const badCap = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { frequency_cap: { max: 0, days: 3 } },
    });
    expect(badCap.status).toBe(400);
    const badWindow = await call(world.env, 'PUT', '/workspace/settings', {
      token: tok(),
      body: { quiet_hours: [{ startDay: 1, startMinute: 1500, endDay: 1, endMinute: 480 }] }, // startMinute > 1439
    });
    expect(badWindow.status).toBe(400);
  });
});
