// Company LOGO (CLAUDE.md company-settings). REAL Postgres. Proves:
//   - GET/PUT/DELETE /company/logo manage companies.logo_asset_id per COMPANY,
//     resolved workspace → company from the token ctx (never the body);
//   - PUT rejects an asset that doesn't belong to one of the company's workspaces
//     (tenant isolation) and a malformed asset_id;
//   - company isolation: company B can't set company A's logo via a foreign asset;
//   - the PUBLIC unsubscribe AND manage-subscription pages INCLUDE the logo <img>
//     (…/assets/<id>) when a logo is set, and OMIT it when not — asserted on the
//     rendered HTML. The tokenized-link gate still applies.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { signUnsubscribeToken, unsubscribeLinkSecret } from '@cdp/email';
import { makePgLookups, makeLocalDeps, dispatch, createApp, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0efa';
const CO_A = `${P}-0000-4000-8000-0000000000c1`;
const CO_B = `${P}-0000-4000-8000-0000000000c2`;
const WS_A = `${P}-0000-4000-8000-000000000a01`;
const WS_B = `${P}-0000-4000-8000-000000000a02`;
const OWNER_A = `${P}-0000-4000-8000-0000000000b1`;
const OWNER_B = `${P}-0000-4000-8000-0000000000b2`;
const EMAIL = 'logo-recipient@example.com';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

function env(pool: Pool): DispatchEnv {
  return { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
}

const tok = (ws: string, e: string) => signUnsubscribeToken(unsubscribeLinkSecret(), ws, e);

describeMaybe('company logo via API + public pages (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let assetA: string; // an asset uploaded in CO_A's workspace
  let assetB: string; // an asset uploaded in CO_B's workspace

  const e = (): DispatchEnv => env(pool);
  const getLogo = (t: string) =>
    dispatch({ method: 'GET', path: '/company/logo', authorization: t, query: {}, body: {} }, e());
  const putLogo = (t: string, body: unknown) =>
    dispatch({ method: 'PUT', path: '/company/logo', authorization: t, query: {}, body }, e());
  const delLogo = (t: string) =>
    dispatch({ method: 'DELETE', path: '/company/logo', authorization: t, query: {}, body: {} }, e());

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    for (const [co, ws, owner] of [
      [CO_A, WS_A, OWNER_A],
      [CO_B, WS_B, OWNER_B],
    ] as const) {
      await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [co]);
      await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [ws, co]);
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, owner]);
    }
    // A profile (so the public-page lookups have a recipient) + an asset per company.
    await pool.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,'{}'::jsonb)", [WS_A, EMAIL]);
    const a = await pool.query<{ id: string }>(
      "INSERT INTO assets (workspace_id, filename, mime, data, folder) VALUES ($1,'logo.png','image/png','AAAA','') RETURNING id",
      [WS_A],
    );
    assetA = a.rows[0]!.id;
    const b = await pool.query<{ id: string }>(
      "INSERT INTO assets (workspace_id, filename, mime, data, folder) VALUES ($1,'logo.png','image/png','BBBB','') RETURNING id",
      [WS_B],
    );
    assetB = b.rows[0]!.id;
  });

  beforeEach(async () => {
    await pool.query('UPDATE companies SET logo_asset_id = NULL WHERE id = ANY($1)', [[CO_A, CO_B]]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      await pool.query('DELETE FROM assets WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    for (const co of [CO_A, CO_B]) await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  }

  it('GET returns null before any logo is set', async () => {
    const r = await getLogo(tokenFor(OWNER_A, WS_A));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ logo_url: null });
  });

  it('PUT sets the logo (company-scoped) and GET returns the public asset path', async () => {
    const set = await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetA });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ logo_url: `/assets/${assetA}` });
    const got = await getLogo(tokenFor(OWNER_A, WS_A));
    expect(got.body).toMatchObject({ logo_url: `/assets/${assetA}`, asset_id: assetA });
    // Persisted on the company row.
    const row = await pool.query<{ logo_asset_id: string }>('SELECT logo_asset_id FROM companies WHERE id = $1', [CO_A]);
    expect(row.rows[0]!.logo_asset_id).toBe(assetA);
  });

  it('PUT rejects a malformed asset_id (400)', async () => {
    expect((await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: 'not-a-uuid' })).status).toBe(400);
    expect((await putLogo(tokenFor(OWNER_A, WS_A), {})).status).toBe(400);
  });

  it('PUT rejects a FOREIGN asset (belongs to another company) — 400, sets nothing', async () => {
    const r = await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetB });
    expect(r.status).toBe(400);
    const row = await pool.query<{ logo_asset_id: string | null }>('SELECT logo_asset_id FROM companies WHERE id = $1', [
      CO_A,
    ]);
    expect(row.rows[0]!.logo_asset_id).toBe(null);
  });

  it('company isolation: B cannot point at A — and B setting its own asset never touches A', async () => {
    await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetA });
    // B tries A's asset → rejected.
    expect((await putLogo(tokenFor(OWNER_B, WS_B), { asset_id: assetA })).status).toBe(400);
    // B sets its own → only CO_B changes.
    expect((await putLogo(tokenFor(OWNER_B, WS_B), { asset_id: assetB })).status).toBe(200);
    const a = await pool.query<{ logo_asset_id: string }>('SELECT logo_asset_id FROM companies WHERE id = $1', [CO_A]);
    const b = await pool.query<{ logo_asset_id: string }>('SELECT logo_asset_id FROM companies WHERE id = $1', [CO_B]);
    expect(a.rows[0]!.logo_asset_id).toBe(assetA);
    expect(b.rows[0]!.logo_asset_id).toBe(assetB);
  });

  it('DELETE clears the logo', async () => {
    await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetA });
    const d = await delLogo(tokenFor(OWNER_A, WS_A));
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ deleted: 1 });
    expect((await getLogo(tokenFor(OWNER_A, WS_A))).body).toMatchObject({ logo_url: null });
  });

  // --- public pages ---------------------------------------------------------
  const unsubLink = `/unsubscribe?workspace_id=${WS_A}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS_A, EMAIL)}`;
  const manageLink = `/manage-subscription?workspace_id=${WS_A}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS_A, EMAIL)}`;

  it('UNSUBSCRIBE page OMITS the logo when none is set, INCLUDES it when set', async () => {
    // No logo → no <img>.
    const none = await app.request(unsubLink);
    expect(none.status).toBe(200);
    const noneHtml = await none.text();
    expect(noneHtml).toContain('confirm-unsubscribe');
    expect(noneHtml).not.toContain('data-testid="page-logo"');

    // Set a logo → the <img …/assets/<id>…> renders atop the card.
    await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetA });
    const withLogo = await app.request(unsubLink);
    const html = await withLogo.text();
    expect(html).toContain('data-testid="page-logo"');
    expect(html).toContain(`/assets/${assetA}`);
  });

  it('MANAGE-SUBSCRIPTION page OMITS the logo when none is set, INCLUDES it when set', async () => {
    const none = await app.request(manageLink);
    expect(none.status).toBe(200);
    const noneHtml = await none.text();
    expect(noneHtml).not.toContain('data-testid="page-logo"');

    await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetA });
    const withLogo = await app.request(manageLink);
    const html = await withLogo.text();
    expect(html).toContain('data-testid="page-logo"');
    expect(html).toContain(`/assets/${assetA}`);
  });

  it('the logo does NOT render on a 403 (forged/missing token) page', async () => {
    await putLogo(tokenFor(OWNER_A, WS_A), { asset_id: assetA });
    const forged = `/manage-subscription?workspace_id=${WS_A}&email=${encodeURIComponent(EMAIL)}`; // no token
    const res = await app.request(forged);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('data-testid="page-logo"');
  });
});
