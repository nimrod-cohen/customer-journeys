// The public /o/<token> open-tracking pixel (§10): returns a 1x1 transparent GIF
// and records the open (bump opens + first/last_open_at) on a known token; an
// unknown/foreign/invalid token still returns the gif (a pixel must NEVER error)
// and records nothing. Real Postgres. Fresh ws prefix 0c0d0f**.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const WS = '0c0d0f02-0000-4000-8000-000000000a01';
const WS_B = '0c0d0f02-0000-4000-8000-000000000a02';
const BCAST = '0c0d0f02-0000-4000-8000-0000000000e1';
const P1 = '0c0d0f02-0000-4000-8000-0000000000f1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('GET /o/:token open pixel (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const ws of [WS, WS_B]) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await pool.query("INSERT INTO broadcasts (id, workspace_id, name, audience_kind, audience_ref, status) VALUES ($1,$2,'B','manual',$1,'sent')", [BCAST, WS]);
    await pool.query("INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,'p1@x.test')", [P1, WS]);
    // Pre-created at send (opens=0), attributed to WS + broadcast + profile.
    await pool.query(
      "INSERT INTO tracked_opens (token, workspace_id, broadcast_id, profile_id, opens) VALUES ('opentok123456',$1,$2,$3,0)",
      [WS, BCAST, P1],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await pool.query('DELETE FROM tracked_opens WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('returns a 1x1 transparent gif and records the open (attributed to ws+broadcast+profile)', async () => {
    const app = createApp({ pool });
    const res = await app.request('/o/opentok123456');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(String.fromCharCode(...bytes.slice(0, 3))).toBe('GIF'); // GIF magic

    // A second load bumps opens again; first_open_at stays, last_open_at moves.
    await app.request('/o/opentok123456');
    const { rows } = await pool.query<{ workspace_id: string; broadcast_id: string; profile_id: string; opens: number; first_open_at: string | null }>(
      'SELECT workspace_id, broadcast_id, profile_id, opens, first_open_at FROM tracked_opens WHERE token = $1',
      ['opentok123456'],
    );
    expect(rows[0]!.workspace_id).toBe(WS);
    expect(rows[0]!.broadcast_id).toBe(BCAST);
    expect(rows[0]!.profile_id).toBe(P1);
    expect(rows[0]!.opens).toBe(2);
    expect(rows[0]!.first_open_at).not.toBeNull();
  });

  it('an unknown token still returns the gif and records nothing', async () => {
    const app = createApp({ pool });
    const res = await app.request('/o/unknownnope99');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM tracked_opens WHERE token = 'unknownnope99'");
    expect(rows[0]!.n).toBe(0);
  });

  it('an invalid token shape returns the gif and never throws', async () => {
    const app = createApp({ pool });
    const res = await app.request('/o/bad token!');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
  });
});
