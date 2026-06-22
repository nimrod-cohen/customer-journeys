// Front-facing language on the PUBLIC pages (CLAUDE.md front_facing_language).
// A workspace picks settings.front_facing_language = 'auto'|'en'|'he':
//   - 'he' FORCES Hebrew (RTL) on /unsubscribe + /manage-subscription;
//   - 'en' FORCES English/LTR;
//   - 'auto' (default) reads the recipient's Accept-Language header (Hebrew if it
//     expresses he/he-IL, else English).
// The tokenized `?t=` link is still required. PUT /workspace/settings validates
// the value. Real Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { signUnsubscribeToken, unsubscribeLinkSecret } from '@cdp/email';
import { createApp } from '../src/index.js';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0efc-0000-4000-8000-000000000a01';
const EMAIL = 'lang@example.com';

const tok = (ws: string, e: string) => signUnsubscribeToken(unsubscribeLinkSecret(), ws, e);

describeMaybe('front-facing language on public pages (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const unsubLink = `/unsubscribe?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS, EMAIL)}`;
  const mgrLink = `/manage-subscription?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS, EMAIL)}`;

  const setLang = (v: string | null) =>
    v === null
      ? pool.query("UPDATE workspaces SET settings='{}'::jsonb WHERE id=$1", [WS])
      : pool.query(`UPDATE workspaces SET settings = jsonb_build_object('front_facing_language', $2::text) WHERE id=$1`, [WS, v]);

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,'{}'::jsonb)", [WS, EMAIL]);
    // Active topics so /manage-subscription renders the topics center (not the simple page).
    await pool.query("INSERT INTO topics (workspace_id, name) VALUES ($1,'Product news')", [WS]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM topic_subscriptions WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM topics WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  const get = (path: string, acceptLanguage?: string) =>
    app.request(path, acceptLanguage ? { headers: { 'accept-language': acceptLanguage } } : undefined);

  it("front_facing_language='he' → /unsubscribe renders Hebrew RTL", async () => {
    await setLang('he');
    const res = await get(unsubLink);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('lang="he"');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('לבטל את ההרשמה לדיוור?'); // Hebrew heading
    expect(html).toContain('כן, בטלו את הרשמתי'); // Hebrew button
    expect(html).not.toContain('Unsubscribe from these emails?');
  });

  it("front_facing_language='he' → /manage-subscription renders Hebrew RTL", async () => {
    await setLang('he');
    const res = await get(mgrLink);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('lang="he"');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('ניהול ההרשמה'); // Hebrew heading
    expect(html).toContain('וואטסאפ ו-SMS'); // Hebrew channel label
    expect(html).toContain('ביטול הרשמה מהכול'); // Hebrew "unsubscribe from everything"
    expect(html).toContain('Product news'); // topic name verbatim (workspace data)
  });

  it("front_facing_language='en' → English/LTR on both pages", async () => {
    await setLang('en');
    const u = await (await get(unsubLink)).text();
    expect(u).toContain('lang="en"');
    expect(u).toContain('dir="ltr"');
    expect(u).toContain('Unsubscribe from these emails?');
    expect(u).not.toContain('לבטל את ההרשמה');
    const m = await (await get(mgrLink)).text();
    expect(m).toContain('lang="en"');
    expect(m).toContain('Manage your subscription');
    expect(m).toContain('WhatsApp &amp; SMS'); // the & is HTML-escaped in the rendered page
    expect(m).not.toContain('וואטסאפ');
  });

  it("front_facing_language='auto' + Accept-Language: he-IL → Hebrew", async () => {
    await setLang('auto');
    const u = await (await get(unsubLink, 'he-IL,he;q=0.9,en-US;q=0.8')).text();
    expect(u).toContain('lang="he"');
    expect(u).toContain('לבטל את ההרשמה לדיוור?');
    const m = await (await get(mgrLink, 'he-IL,he;q=0.9')).text();
    expect(m).toContain('lang="he"');
    expect(m).toContain('ניהול ההרשמה');
  });

  it("front_facing_language='auto' + Accept-Language: en-US → English", async () => {
    await setLang('auto');
    const u = await (await get(unsubLink, 'en-US,en;q=0.9')).text();
    expect(u).toContain('lang="en"');
    expect(u).toContain('Unsubscribe from these emails?');
  });

  it("unset setting (no key) defaults to 'auto' → follows Accept-Language", async () => {
    await setLang(null);
    const he = await (await get(unsubLink, 'he')).text();
    expect(he).toContain('lang="he"');
    const en = await (await get(unsubLink, 'en-GB')).text();
    expect(en).toContain('lang="en"');
    // No header → English (the prior behaviour, unchanged).
    const none = await (await get(unsubLink)).text();
    expect(none).toContain('lang="en"');
    expect(none).toContain('Unsubscribe from these emails?');
  });

  it('a Hebrew page still requires the tokenized link (a forged/missing token is rejected)', async () => {
    await setLang('he');
    const noTok = `/unsubscribe?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}`;
    expect((await get(noTok)).status).toBe(403);
    const forged = `/unsubscribe?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS, 'other@x.com')}`;
    expect((await get(forged)).status).toBe(403);
  });
});

const SWS = '0c0d0efc-0000-4000-8000-000000000b01';
const OTHER_WS = '0c0d0efc-0000-4000-8000-000000000b02';
const OWNER = '0c0d0efc-0000-4000-8000-0000000000c1';

describeMaybe('PUT /workspace/settings: front_facing_language (real Postgres)', () => {
  let world: TestWorld;
  const tok2 = () => tokenFor(OWNER, SWS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [SWS, OTHER_WS]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, OWNER]);
    }
  });
  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    for (const ws of [SWS, OTHER_WS]) {
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id=$1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id=$1', [ws]);
    }
  }
  const settingsOf = async (ws: string): Promise<Record<string, unknown>> =>
    ((await world.pool.query('SELECT settings FROM workspaces WHERE id=$1', [ws])).rows[0]?.settings as Record<string, unknown>) ?? {};

  it("defaults front_facing_language to 'auto' for a fresh workspace", async () => {
    const r = await call(world.env, 'GET', '/workspace/settings', { token: tok2() });
    expect(r.status).toBe(200);
    expect((r.body as { settings: { front_facing_language: string } }).settings.front_facing_language).toBe('auto');
  });

  it("round-trips a valid language ('he') and reads it back", async () => {
    const put = await call(world.env, 'PUT', '/workspace/settings', { token: tok2(), body: { front_facing_language: 'he' } });
    expect(put.status).toBe(200);
    expect((put.body as { settings: { front_facing_language: string } }).settings.front_facing_language).toBe('he');
    const get = await call(world.env, 'GET', '/workspace/settings', { token: tok2() });
    expect((get.body as { settings: { front_facing_language: string } }).settings.front_facing_language).toBe('he');
  });

  it('rejects an invalid language (400) and writes nothing', async () => {
    await call(world.env, 'PUT', '/workspace/settings', { token: tok2(), body: { front_facing_language: 'en' } });
    const bad = await call(world.env, 'PUT', '/workspace/settings', { token: tok2(), body: { front_facing_language: 'fr' } });
    expect(bad.status).toBe(400);
    expect((await settingsOf(SWS)).front_facing_language).toBe('en'); // unchanged
  });

  it('merges language without clobbering siblings (timezone)', async () => {
    await call(world.env, 'PUT', '/workspace/settings', { token: tok2(), body: { timezone: 'Asia/Jerusalem' } });
    await call(world.env, 'PUT', '/workspace/settings', { token: tok2(), body: { front_facing_language: 'he' } });
    const s = await settingsOf(SWS);
    expect(s.front_facing_language).toBe('he');
    expect(s.timezone).toBe('Asia/Jerusalem');
  });

  it('ignores a stray workspace_id in the body — updates ctx workspace only', async () => {
    await call(world.env, 'PUT', '/workspace/settings', {
      token: tok2(),
      body: { front_facing_language: 'en', workspace_id: OTHER_WS },
    });
    expect((await settingsOf(SWS)).front_facing_language).toBe('en');
    expect((await settingsOf(OTHER_WS)).front_facing_language).toBeUndefined();
  });
});
