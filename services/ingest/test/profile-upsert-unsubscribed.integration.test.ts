// Real-Postgres proof of the `unsubscribed` attribute lifecycle on the profile
// upsert (§7 + §10): a NEW profile seeds unsubscribed=false; a later profile
// event (another upsert) merges its attrs but NEVER resets an unsubscribed=true
// that the unsubscribe flow set in between. This is the property that keeps
// "unsubscribed = true/false" segments truthful.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildProfileUpsert } from '../src/core.js';

const RUN = hasDatabaseUrl();
const WS = 'ab200000-0000-0000-0000-0000000000a1';
const EXT = 'unsub-lifecycle';

async function attr(pool: Pool, key: string): Promise<string | null> {
  const r = await pool.query(
    'SELECT attributes->>$3 AS v FROM profiles WHERE workspace_id = $1 AND external_id = $2',
    [WS, EXT, key],
  );
  return (r.rows[0]?.v as string | undefined) ?? null;
}
async function upsert(pool: Pool, attrs: Record<string, unknown>): Promise<void> {
  const q = buildProfileUpsert(WS, EXT, attrs);
  await pool.query(q.text, q.values);
}

describe.skipIf(!RUN)('profile upsert × unsubscribed attribute (real Postgres)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name) VALUES ($1,'W')", [WS]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('a new profile starts subscribed (unsubscribed=false)', async () => {
    await upsert(pool, { plan: 'pro' });
    expect(await attr(pool, 'unsubscribed')).toBe('false');
    expect(await attr(pool, 'plan')).toBe('pro');
  });

  it('a later profile event does NOT reset unsubscribed=true', async () => {
    // Simulate the unsubscribe flow flipping the attribute to true.
    await pool.query(
      `UPDATE profiles SET attributes = attributes || '{"unsubscribed": true}'::jsonb
        WHERE workspace_id = $1 AND external_id = $2`,
      [WS, EXT],
    );
    expect(await attr(pool, 'unsubscribed')).toBe('true');

    // A subsequent profile event (e.g. profile_created carrying other attrs) must
    // merge its attrs but leave unsubscribed=true intact.
    await upsert(pool, { plan: 'gold' });
    expect(await attr(pool, 'unsubscribed')).toBe('true'); // preserved
    expect(await attr(pool, 'plan')).toBe('gold'); // updated
  });
});
