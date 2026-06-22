// The public /unsubscribe route on the local API (§10). Two-step opt-out: GET
// shows a re-affirm page and changes NOTHING (links are prefetchable); POST (the
// page's Confirm button) writes the per-workspace suppression AND sets the
// profile `unsubscribed = true`. Scoped to the workspace carried in the link.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { signUnsubscribeToken, packSubscriptionToken, unsubscribeLinkSecret } from '@cdp/email';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0e30-0000-4000-8000-000000000a31';
const EMAIL = 'optout-local@example.com';
const tok = (ws: string, e: string) => signUnsubscribeToken(unsubscribeLinkSecret(), ws, e);

describeMaybe('public /unsubscribe route (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const link = `/unsubscribe?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS, EMAIL)}`;

  const suppressed = async () =>
    ((await pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=$2', [WS, EMAIL])).rowCount ?? 0) > 0;
  const unsubAttr = async () =>
    (await pool.query("SELECT attributes->>'unsubscribed' AS u FROM profiles WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]))
      .rows[0]?.u ?? null;

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,'{}'::jsonb)", [WS, EMAIL]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  it('GET returns the re-affirm page and does NOT unsubscribe', async () => {
    const res = await app.request(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('confirm-unsubscribe');
    expect(await suppressed()).toBe(false);
    expect(await unsubAttr()).toBe(null);
  });

  it('POST (confirm) writes the suppression AND flags the profile unsubscribed=true', async () => {
    const res = await app.request(link, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/unsubscribed/i);
    expect(await suppressed()).toBe(true);
    expect(await unsubAttr()).toBe('true');
  });

  it('a link missing workspace_id is a 400 (never a guessed workspace)', async () => {
    const res = await app.request(`/unsubscribe?email=${encodeURIComponent(EMAIL)}`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('a link with NO token is 403 (unguessable, signed link required)', async () => {
    const noTok = `/unsubscribe?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}`;
    expect((await app.request(noTok)).status).toBe(403);
    expect((await app.request(noTok, { method: 'POST' })).status).toBe(403);
  });

  // ── NEW: the compact self-contained `?t=` link ──────────────────────────
  it('the compact `?t=` link works end-to-end (GET re-affirm, POST opt-out)', async () => {
    const tLink = `/unsubscribe?t=${packSubscriptionToken(unsubscribeLinkSecret(), WS, EMAIL)}`;
    // GET re-affirms, changes nothing.
    const getRes = await app.request(tLink);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toContain('confirm-unsubscribe');
    // POST opts out.
    const postRes = await app.request(tLink, { method: 'POST' });
    expect(postRes.status).toBe(200);
    expect(await suppressed()).toBe(true);
    expect(await unsubAttr()).toBe('true');
  });

  it('a forged `?t=` token is 403 (cannot opt out someone else)', async () => {
    const forged = packSubscriptionToken('a-different-secret', WS, EMAIL);
    const res = await app.request(`/unsubscribe?t=${forged}`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
