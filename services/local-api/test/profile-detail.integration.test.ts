// Profile detail endpoints (§12): read a profile + its features, edit core
// fields, REPLACE the attributes bag, and read the profile's events + segment
// memberships. REAL Postgres. Proves the writes/reads are scoped to the token's
// workspace IN CODE (CLAUDE.md inv.1/inv.2): a cross-workspace profile id is
// never readable or writable, and the body never chooses the workspace.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS_A = '0d1e2f03-0000-4000-8000-000000000a01';
const WS_B = '0d1e2f03-0000-4000-8000-000000000a02';
const USER = '0d1e2f03-0000-4000-8000-0000000000b1'; // owner of A only
const P_A = '0d1e2f03-0000-4000-8000-0000000000c1';
const P_A2 = '0d1e2f03-0000-4000-8000-0000000000c3'; // in A, NOT in the segment
const P_B = '0d1e2f03-0000-4000-8000-0000000000c2';
const SEG_A = '0d1e2f03-0000-4000-8000-0000000000d1'; // manual, P_A is a member
const SEG_DYN = '0d1e2f03-0000-4000-8000-0000000000d2'; // dynamic: attributes.tier = std
const EV_1 = '0d1e2f03-0000-4000-8000-0000000000e1';
const EV_2 = '0d1e2f03-0000-4000-8000-0000000000e2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('profile detail: read/edit/events/segments (real Postgres)', () => {
  let world: TestWorld;
  const tokA = () => tokenFor(USER, WS_A);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_A, USER],
    );
    // Profile in A (with attributes + features) and a profile in B (must be invisible to A).
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'a1','a1@acme.com','{\"tier\":\"vip\"}'::jsonb)",
      [P_A, WS_A],
    );
    await world.pool.query(
      'INSERT INTO profile_features (profile_id, workspace_id, total_events) VALUES ($1,$2,2)',
      [P_A, WS_A],
    );
    // A second A profile that is NOT in the manual segment (proves exclusion) and
    // carries attributes.tier=std so it matches the DYNAMIC segment by rule alone.
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'a2','a2@acme.com','{\"tier\":\"std\"}'::jsonb)",
      [P_A2, WS_A],
    );
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'b1','b1@beta.com')",
      [P_B, WS_B],
    );
    // Two events for P_A at different times (assert newest-first ordering).
    await world.pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES ($1,$2,$3,'page_view','2026-01-01T10:00:00Z','{}'::jsonb)",
      [EV_1, WS_A, P_A],
    );
    await world.pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES ($1,$2,$3,'purchase','2026-02-01T10:00:00Z','{\"amount\":50}'::jsonb)",
      [EV_2, WS_A, P_A],
    );
    // A manual segment in A with P_A as a member.
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'VIPs','manual')",
      [SEG_A, WS_A],
    );
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_A, P_A, WS_A],
    );
    // A DYNAMIC segment (rule attributes.tier = std) with NO materialized rows.
    await world.pool.query(
      `INSERT INTO segments (id, workspace_id, name, kind, definition)
       VALUES ($1,$2,'Standard tier','dynamic_realtime',
               '{"field":"attributes.tier","operator":"=","value":"std"}'::jsonb)`,
      [SEG_DYN, WS_A],
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
      await world.pool.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('POST /profiles manually creates a profile (seeds unsubscribed=false, listed)', async () => {
    const c = await call(world.env, 'POST', '/profiles', {
      token: tokA(),
      body: { external_id: 'made-1', email: 'made1@acme.com' },
    });
    expect(c.status).toBe(201);
    const list = await call(world.env, 'GET', '/profiles', { token: tokA() });
    const row = (list.body as { profiles: { external_id: string; unsubscribed: boolean }[] }).profiles.find(
      (p) => p.external_id === 'made-1',
    );
    expect(row?.unsubscribed).toBe(false);
  });

  it('POST /profiles with an EXISTING email is a 409 conflict (no silent merge)', async () => {
    const email = 'dupe@acme.com';
    const first = await call(world.env, 'POST', '/profiles', {
      token: tokA(),
      body: { email, attributes: { tier: 'gold' } },
    });
    expect(first.status).toBe(201);
    // A second create with the same email must NOT silently merge.
    const second = await call(world.env, 'POST', '/profiles', {
      token: tokA(),
      body: { email, attributes: { tier: 'silver' } },
    });
    expect(second.status).toBe(409);
    expect((second.body as { profile_id: string }).profile_id).toBeTruthy();
    // The existing profile is untouched (still gold).
    const { rows } = await world.pool.query(
      "SELECT attributes->>'tier' AS tier FROM profiles WHERE workspace_id = $1 AND email = $2",
      [WS_A, email],
    );
    expect(rows[0]?.tier).toBe('gold');
  });

  it('POST /profiles requires a valid email — the identity key (400)', async () => {
    const noEmail = await call(world.env, 'POST', '/profiles', { token: tokA(), body: { external_id: 'x' } });
    expect(noEmail.status).toBe(400);
    const badEmail = await call(world.env, 'POST', '/profiles', { token: tokA(), body: { email: 'not-an-email' } });
    expect(badEmail.status).toBe(400);
  });

  it('GET /profiles/attribute-keys returns DISTINCT keys (excluding unsubscribed)', async () => {
    const r = await call(world.env, 'GET', '/profiles/attribute-keys', { token: tokA() });
    expect(r.status).toBe(200);
    const keys = (r.body as { keys: string[] }).keys;
    expect(keys).toContain('tier'); // P_A2 has attributes.tier
    expect(keys).not.toContain('unsubscribed'); // internal flag is filtered out
  });

  it('exposes created_at as a Unix epoch-ms NUMBER (created_at_unix) alongside the ISO string', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_A}`, { token: tokA() });
    const p = (r.body as { profile: { created_at: string; created_at_unix: number } }).profile;
    expect(typeof p.created_at_unix).toBe('number');
    // The epoch number matches the ISO timestamp.
    expect(p.created_at_unix).toBe(new Date(p.created_at).getTime());
  });

  it('GET /profiles/:id returns the profile + rolling features', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_A}`, { token: tokA() });
    expect(r.status).toBe(200);
    const b = r.body as { profile: { email: string; attributes: Record<string, unknown> }; features: { total_events: number } };
    expect(b.profile.email).toBe('a1@acme.com');
    expect(b.profile.attributes.tier).toBe('vip');
    expect(b.features.total_events).toBe(2);
  });

  it('PATCH /profiles/:id edits status and REPLACES attributes', async () => {
    const r = await call(world.env, 'PATCH', `/profiles/${P_A}`, {
      token: tokA(),
      body: { email_status: 'bounced', attributes: { tier: 'gold', vip: true } },
    });
    expect(r.status).toBe(200);
    // Re-read to confirm persistence: tier changed, old keys gone, new key present.
    const got = await call(world.env, 'GET', `/profiles/${P_A}`, { token: tokA() });
    const p = (got.body as { profile: { email_status: string; attributes: Record<string, unknown> } }).profile;
    expect(p.email_status).toBe('bounced');
    expect(p.attributes).toEqual({ tier: 'gold', vip: true });
  });

  it('PATCH /profiles/:id rejects an invalid email_status (400)', async () => {
    const r = await call(world.env, 'PATCH', `/profiles/${P_A}`, {
      token: tokA(),
      body: { email_status: 'nonsense' },
    });
    expect(r.status).toBe(400);
  });

  it('PATCH to an email already used by another profile is a friendly 409', async () => {
    // P_A is lead@... no — P_A is a1@acme.com, P_A2 is a2@acme.com. Renaming P_A2
    // to P_A's email collides on the per-workspace unique email index.
    const r = await call(world.env, 'PATCH', `/profiles/${P_A2}`, {
      token: tokA(),
      body: { email: 'a1@acme.com' },
    });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/already exists/i);
  });

  it('a manual edit reconciles the suppression list (acts like the pipeline)', async () => {
    const supp = async (): Promise<{ reason: string; source: string } | null> => {
      const r = await world.pool.query(
        'SELECT reason, source FROM suppressions WHERE workspace_id = $1 AND email = $2',
        [WS_A, 'a2@acme.com'],
      );
      return (r.rows[0] as { reason: string; source: string } | undefined) ?? null;
    };
    // Mark bounced → a manual suppression (hard_bounce) appears.
    await call(world.env, 'PATCH', `/profiles/${P_A2}`, { token: tokA(), body: { email_status: 'bounced' } });
    expect(await supp()).toEqual({ reason: 'hard_bounce', source: 'manual' });

    // Back to active → the manual suppression is lifted.
    await call(world.env, 'PATCH', `/profiles/${P_A2}`, { token: tokA(), body: { email_status: 'active' } });
    expect(await supp()).toBeNull();

    // Mark unsubscribed via the attribute → a manual suppression (unsubscribe).
    await call(world.env, 'PATCH', `/profiles/${P_A2}`, {
      token: tokA(),
      body: { attributes: { tier: 'std', unsubscribed: true } },
    });
    expect(await supp()).toEqual({ reason: 'unsubscribe', source: 'manual' });
  });

  it('a cross-workspace profile id is NOT editable (404, tenant isolation)', async () => {
    const r = await call(world.env, 'PATCH', `/profiles/${P_B}`, {
      token: tokA(),
      body: { email_status: 'bounced' },
    });
    expect(r.status).toBe(404);
    // And the B profile is untouched (read with no scope via admin pool).
    const { rows } = await world.pool.query('SELECT email_status FROM profiles WHERE id = $1', [P_B]);
    expect(rows[0]?.email_status).toBe('active');
  });

  it('GET /profiles/:id/events returns the history newest-first (scoped)', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_A}/events`, { token: tokA() });
    expect(r.status).toBe(200);
    const events = (r.body as { events: { type: string }[] }).events;
    expect(events.map((e) => e.type)).toEqual(['purchase', 'page_view']);
  });

  it('a cross-workspace profile id surfaces NO events (scoped to the token)', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_B}/events`, { token: tokA() });
    expect(r.status).toBe(200);
    expect((r.body as { events: unknown[] }).events).toHaveLength(0);
  });

  it('GET /profiles?segment_id=… returns ONLY that segment\'s members (scoped)', async () => {
    const r = await call(world.env, 'GET', '/profiles', {
      token: tokA(),
      query: { segment_id: SEG_A },
    });
    expect(r.status).toBe(200);
    const ids = (r.body as { profiles: { id: string }[] }).profiles.map((p) => p.id);
    expect(ids).toContain(P_A); // a member
    expect(ids).not.toContain(P_A2); // same workspace, NOT a member
  });

  it('GET /profiles?segment_id=… LIVE-evaluates a DYNAMIC segment (no materialized rows)', async () => {
    // SEG_DYN has a rule but zero segment_memberships rows. The filter must still
    // return the profile that matches the rule right now (live compile), proving
    // it does not depend on the evaluator having materialized memberships.
    const r = await call(world.env, 'GET', '/profiles', {
      token: tokA(),
      query: { segment_id: SEG_DYN },
    });
    expect(r.status).toBe(200);
    const ids = (r.body as { profiles: { id: string }[] }).profiles.map((p) => p.id);
    expect(ids).toContain(P_A2); // tier=std matches the rule, despite no membership row
    expect(ids).not.toContain(P_B); // never another tenant's profile
  });

  it('GET /profiles with no filter returns all workspace profiles', async () => {
    const r = await call(world.env, 'GET', '/profiles', { token: tokA() });
    const ids = (r.body as { profiles: { id: string }[] }).profiles.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([P_A, P_A2]));
    expect(ids).not.toContain(P_B); // never another tenant's profile
  });

  it('GET /profiles/:id/segments lists the segments the profile is in', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_A}/segments`, { token: tokA() });
    expect(r.status).toBe(200);
    const segs = (r.body as { segments: { id: string; name: string }[] }).segments;
    expect(segs.map((s) => s.id)).toContain(SEG_A);
    expect(segs.find((s) => s.id === SEG_A)?.name).toBe('VIPs');
  });
});
