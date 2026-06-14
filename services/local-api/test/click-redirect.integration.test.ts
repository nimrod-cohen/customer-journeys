// The public /t/<token> click-tracking redirect (§10): 302s to the original URL
// and increments the click count; unknown/invalid tokens 404. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const WS = '0c0d0e70-0000-4000-8000-000000000a01';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('GET /t/:token click redirect (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query(
      "INSERT INTO tracked_links (token, workspace_id, url, clicks) VALUES ('abc123def456',$1,'https://acme.com/sale',0)",
      [WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM tracked_links WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('302-redirects to the destination and counts the click', async () => {
    const app = createApp({ pool });
    const res = await app.request('/t/abc123def456', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://acme.com/sale');

    // A second hit increments again.
    await app.request('/t/abc123def456', { redirect: 'manual' });
    const { rows } = await pool.query<{ clicks: number }>('SELECT clicks FROM tracked_links WHERE token = $1', ['abc123def456']);
    expect(rows[0]!.clicks).toBe(2);
  });

  it('unknown or invalid tokens 404', async () => {
    const app = createApp({ pool });
    expect((await app.request('/t/nope999nope')).status).toBe(404);
    expect((await app.request('/t/bad token')).status).toBe(404);
  });
});
