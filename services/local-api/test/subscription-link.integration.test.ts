// GET /profiles/:id/subscription-link (CLAUDE.md tokenized links): returns the
// TOKENIZED /manage-subscription link for a profile's email, built with the SAME
// secret + base the dispatcher uses. The link must ROUND-TRIP: the public
// /manage-subscription handler ACCEPTS it (the token verifies). Workspace-scoped:
// a cross-workspace/missing profile id 404s; the workspace comes from the token.
// Real Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { createApp } from '../src/index.js';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS_A = '0c0d0ee0-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ee0-0000-4000-8000-000000000a02';
const USER = '0c0d0ee0-0000-4000-8000-0000000000b1'; // owner of A only
const P_A = '0c0d0ee0-0000-4000-8000-0000000000c1';
const P_B = '0c0d0ee0-0000-4000-8000-0000000000c2';
const P_NOEMAIL = '0c0d0ee0-0000-4000-8000-0000000000c3';
const EMAIL_A = 'link-a@acme.com';

describeMaybe('GET /profiles/:id/subscription-link (real Postgres)', () => {
  let world: TestWorld;
  let app: ReturnType<typeof createApp>;
  const tokA = () => tokenFor(USER, WS_A);

  beforeAll(async () => {
    world = makeWorld();
    app = createApp({ pool: world.pool });
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS_A, USER]);
    await world.pool.query("INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,$3,'{}'::jsonb)", [P_A, WS_A, EMAIL_A]);
    await world.pool.query("INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,'link-b@beta.com','{}'::jsonb)", [P_B, WS_B]);
    // A profile with NO email (phone-only) — a subscription link is email-keyed, so it
    // has none. Phone satisfies the identity CHECK.
    await world.pool.query("INSERT INTO profiles (id, workspace_id, external_id, phone, attributes) VALUES ($1,$2,'noemail','+972540000003','{}'::jsonb)", [P_NOEMAIL, WS_A]);
  });

  afterAll(async () => {
    if (world?.pool) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id=$1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id=$1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id=$1', [ws]);
    }
  }

  it('returns a compact `?t=` /manage-subscription url (no raw uuid/email) that the public handler ACCEPTS (round-trip)', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_A}/subscription-link`, { token: tokA() });
    expect(r.status).toBe(200);
    const url = (r.body as { url: string }).url;
    expect(url).toContain('/manage-subscription');
    const parsed = new URL(url);
    // NEW compact form: one opaque `t`, no raw workspace_id/email/token triple.
    expect(parsed.searchParams.get('t')).toBeTruthy();
    expect(parsed.searchParams.get('workspace_id')).toBeNull();
    expect(parsed.searchParams.get('email')).toBeNull();
    expect(parsed.searchParams.get('token')).toBeNull();
    expect(url).not.toContain(WS_A);
    expect(url).not.toContain(EMAIL_A);

    // The link round-trips: hitting the public manage-subscription GET with it is
    // NOT a 403 (the token verifies). Use the path+query the handler emitted.
    const pathWithQuery = parsed.pathname + parsed.search;
    const pub = await app.request(pathWithQuery);
    expect(pub.status).toBe(200);
  });

  it('a profile with NO email is a 400 (nothing to link)', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_NOEMAIL}/subscription-link`, { token: tokA() });
    expect(r.status).toBe(400);
  });

  it('a cross-workspace profile id is a 404 (tenant isolation; workspace from the token only)', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_B}/subscription-link`, { token: tokA() });
    expect(r.status).toBe(404);
  });

  it('a missing profile id is a 404', async () => {
    const r = await call(world.env, 'GET', `/profiles/0c0d0ee0-0000-4000-8000-0000000000ff/subscription-link`, { token: tokA() });
    expect(r.status).toBe(404);
  });

  it('a tampered `t` token on the returned url is rejected by the public handler (403)', async () => {
    const r = await call(world.env, 'GET', `/profiles/${P_A}/subscription-link`, { token: tokA() });
    const parsed = new URL((r.body as { url: string }).url);
    const t = parsed.searchParams.get('t')!;
    parsed.searchParams.set('t', t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'));
    const pub = await app.request(parsed.pathname + parsed.search);
    expect(pub.status).toBe(403);
  });
});
