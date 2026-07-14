// Public tracking write-keys (§7) + the key-authed /v1/identify + /v1/track ingest.
// A key is minted via the session-authed management API, then used WITHOUT any
// session to upsert a profile + record an event — scoped to the key's workspace
// (never a body field, inv.2). Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { ingestTrack, ingestIdentify } from '../src/handlers.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ef9-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ef9-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ef9-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('ingest write keys + /v1 track/identify (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const call = (method: string, path: string, body: Record<string, unknown> = {}) =>
    dispatch({ method, path, authorization: tokenFor(OWNER, WS), query: {}, body }, e());
  const body = (r: { body: unknown }) => r.body as Record<string, unknown>;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active'),($2,'WB','active')", [WS, WS_B]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await pool.query('DELETE FROM activity_log WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM events WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM profile_features WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM ingest_keys WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM workspaces WHERE id=$1', [w]);
    }
  }

  it('mints a key, ingests identify + track scoped to the workspace, then revokes it', async () => {
    const created = await call('POST', '/ingest-keys', { label: 'website' });
    expect(created.status).toBe(201);
    const rawKey = body(created).key as string;
    expect(rawKey.startsWith('pk_live_')).toBe(true);

    // identify → upserts a profile with traits
    const idr = await ingestIdentify(pool, rawKey, { email: 'jane@example.com', traits: { first_name: 'Jane', tier: 'pro' } });
    expect(idr.status).toBe(202);
    const pid = body(idr).profile_id as string;
    const prof = await pool.query('SELECT workspace_id, email, attributes FROM profiles WHERE id=$1', [pid]);
    expect(prof.rows[0].workspace_id).toBe(WS);
    expect(prof.rows[0].email).toBe('jane@example.com');
    expect(prof.rows[0].attributes.first_name).toBe('Jane');

    // track → records an event on the SAME profile (resolved by email)
    const tr = await ingestTrack(pool, rawKey, { email: 'jane@example.com', event: 'purchase', properties: { amount: 49.9 } });
    expect(tr.status).toBe(202);
    expect(body(tr).profile_id).toBe(pid);
    const ev = await pool.query('SELECT workspace_id, type, payload FROM events WHERE profile_id=$1', [pid]);
    expect(ev.rows.length).toBe(1);
    expect(ev.rows[0].workspace_id).toBe(WS);
    expect(ev.rows[0].type).toBe('purchase');
    expect(Number(ev.rows[0].payload.amount)).toBe(49.9);

    // nothing leaked into WS_B
    const bCount = await pool.query('SELECT count(*)::int n FROM profiles WHERE workspace_id=$1', [WS_B]);
    expect(bCount.rows[0].n).toBe(0);

    // list shows the key MASKED (never the raw key)
    const list = await call('GET', '/ingest-keys');
    const keys = body(list).keys as Array<Record<string, unknown>>;
    expect(keys.length).toBe(1);
    expect(keys[0].key).toBeUndefined();
    expect(keys[0].key_prefix).toBe(rawKey.slice(0, 16));

    // revoke → the key immediately stops working
    const del = await call('DELETE', `/ingest-keys/${keys[0].id as string}`);
    expect(del.status).toBe(200);
    const afterRevoke = await ingestTrack(pool, rawKey, { email: 'jane@example.com', event: 'x' });
    expect(afterRevoke.status).toBe(401);
  });

  it('logs profile_created in the Activity log on FIRST ingest (parity with the UI), exactly once', async () => {
    const created = await call('POST', '/ingest-keys', { label: 'api' });
    const rawKey = body(created).key as string;

    // First identify for a NEW email → profile created → one activity_log row.
    const idr = await ingestIdentify(pool, rawKey, { email: 'newby@example.com', traits: { tier: 'pro' } });
    expect(idr.status).toBe(202);
    const pid = body(idr).profile_id as string;
    const act1 = await pool.query(
      "SELECT source, type FROM activity_log WHERE workspace_id=$1 AND profile_id=$2 AND type='profile_created'",
      [WS, pid],
    );
    expect(act1.rowCount).toBe(1);
    expect(act1.rows[0].source).toBe('profile');

    // Subsequent track/identify for the SAME email are UPDATES, not creates → no
    // second profile_created row (activity isn't flooded per event).
    await ingestTrack(pool, rawKey, { email: 'newby@example.com', event: 'purchase' });
    await ingestIdentify(pool, rawKey, { email: 'newby@example.com', traits: { tier: 'vip' } });
    const act2 = await pool.query(
      "SELECT count(*)::int n FROM activity_log WHERE workspace_id=$1 AND profile_id=$2 AND type='profile_created'",
      [WS, pid],
    );
    expect(act2.rows[0].n).toBe(1);
  });

  it('a track that CREATES a new profile also logs profile_created', async () => {
    const created = await call('POST', '/ingest-keys', {});
    const rawKey = body(created).key as string;
    const tr = await ingestTrack(pool, rawKey, { email: 'tracker@example.com', event: 'signup' });
    expect(tr.status).toBe(202);
    const pid = body(tr).profile_id as string;
    const act = await pool.query(
      "SELECT count(*)::int n FROM activity_log WHERE workspace_id=$1 AND profile_id=$2 AND type='profile_created'",
      [WS, pid],
    );
    expect(act.rows[0].n).toBe(1);
  });

  it('rejects an unknown or malformed key', async () => {
    expect((await ingestTrack(pool, 'pk_live_totallyfake', { email: 'x@y.com', event: 'e' })).status).toBe(401);
    expect((await ingestTrack(pool, 'not-even-a-key', { email: 'x@y.com', event: 'e' })).status).toBe(401);
    expect((await ingestIdentify(pool, '', { email: 'x@y.com' })).status).toBe(401);
  });

  it('validates the email and event fields', async () => {
    const created = await call('POST', '/ingest-keys', {});
    const rawKey = body(created).key as string;
    expect((await ingestTrack(pool, rawKey, { email: 'not-an-email', event: 'e' })).status).toBe(400);
    expect((await ingestTrack(pool, rawKey, { email: 'ok@ex.com' })).status).toBe(400); // no event name
    expect((await ingestIdentify(pool, rawKey, { email: 'bad' })).status).toBe(400);
  });
});
