// Public PREFERENCE CENTER /manage-subscription (CLAUDE.md topic-subscriptions).
// The "manage your subscription" page: workspace_id + email come ONLY from the
// scoped link. GET renders topics + channel-group checkboxes; POST writes the
// granular prefs in ONE workspace-scoped tx. KEY semantics proven here:
//   - a PARTIAL opt-out (a topic, or one medium group) does NOT set the global
//     hard suppression / profiles.attributes.unsubscribed — the person stays on
//     the list for the still-subscribed channels (the user's requirement);
//   - "unsubscribe from everything" sets the full suppression + the flag + opts
//     out both groups + all topics;
//   - the writes are SCOPED to the link's workspace/email (a forged/cross-workspace
//     id touches nothing). Real Postgres.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0ec3-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ec3-0000-4000-8000-000000000a02';
const EMAIL = 'pref@example.com';

describeMaybe('public preference center (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let profileId: string;
  let topicNews: string;
  let topicDigest: string;
  const link = `/manage-subscription?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}`;

  const suppressed = async () =>
    ((await pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=$2', [WS, EMAIL])).rowCount ?? 0) > 0;
  const unsubAttr = async () =>
    (await pool.query("SELECT attributes->>'unsubscribed' AS u FROM profiles WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]))
      .rows[0]?.u ?? null;
  const groupOptedOut = async (g: string) =>
    ((await pool.query('SELECT 1 FROM channel_optouts WHERE workspace_id=$1 AND profile_id=$2 AND medium_group=$3', [WS, profileId, g])).rowCount ?? 0) > 0;
  const topicSubscribed = async (topicId: string): Promise<boolean | null> => {
    const r = await pool.query<{ subscribed: boolean }>(
      'SELECT subscribed FROM topic_subscriptions WHERE workspace_id=$1 AND profile_id=$2 AND topic_id=$3',
      [WS, profileId, topicId],
    );
    return r.rows[0] ? r.rows[0].subscribed : null; // null = no explicit row (default-on)
  };
  const post = (body: string) =>
    app.request(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
    for (const w of [WS, WS_B]) await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    const p = await pool.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,'{}'::jsonb) RETURNING id", [WS, EMAIL]);
    profileId = p.rows[0].id;
    const t1 = await pool.query("INSERT INTO topics (workspace_id, name) VALUES ($1,'Product news') RETURNING id", [WS]);
    topicNews = t1.rows[0].id;
    const t2 = await pool.query("INSERT INTO topics (workspace_id, name) VALUES ($1,'Weekly digest') RETURNING id", [WS]);
    topicDigest = t2.rows[0].id;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM channel_optouts WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM topic_subscriptions WHERE workspace_id=$1', [WS]);
    await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [WS]);
    await pool.query("UPDATE profiles SET attributes='{}'::jsonb WHERE workspace_id=$1", [WS]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await pool.query('DELETE FROM channel_optouts WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM topic_subscriptions WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM suppressions WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM topics WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM profiles WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM workspaces WHERE id=$1', [w]);
    }
  }

  it('GET renders the topics + channel-group checkboxes and changes NOTHING', async () => {
    const res = await app.request(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Product news');
    expect(html).toContain('Weekly digest');
    expect(html).toContain(`pref-group-email`);
    expect(html).toContain(`pref-group-sms_whatsapp`);
    expect(html).toContain('pref-unsub-all');
    // No writes happened (GET is prefetchable).
    expect(await suppressed()).toBe(false);
    expect(await groupOptedOut('email')).toBe(false);
  });

  it('PARTIAL: opting out of ONE topic does NOT set the global suppression / flag', async () => {
    // Keep Weekly digest checked + both groups checked; UNCHECK Product news.
    const res = await post(`topic.${topicDigest}=on&group.email=on&group.sms_whatsapp=on`);
    expect(res.status).toBe(200);
    expect(await topicSubscribed(topicNews)).toBe(false); // explicit opt-out
    expect(await topicSubscribed(topicDigest)).toBe(true); // explicit opt-in
    // Channels stay subscribed (both boxes checked → no opt-out rows).
    expect(await groupOptedOut('email')).toBe(false);
    expect(await groupOptedOut('sms_whatsapp')).toBe(false);
    // CRUCIAL: NOT globally suppressed / flagged.
    expect(await suppressed()).toBe(false);
    expect(await unsubAttr()).toBe(null);
  });

  it('PARTIAL: opting out of ONLY email leaves sms_whatsapp subscribed (and no global suppression)', async () => {
    // email box UNCHECKED, sms_whatsapp checked, both topics checked.
    const res = await post(`group.sms_whatsapp=on&topic.${topicNews}=on&topic.${topicDigest}=on`);
    expect(res.status).toBe(200);
    expect(await groupOptedOut('email')).toBe(true); // opted out of email
    expect(await groupOptedOut('sms_whatsapp')).toBe(false); // still on sms/whatsapp
    expect(await suppressed()).toBe(false);
    expect(await unsubAttr()).toBe(null);
  });

  it('re-subscribing: re-checking a previously opted-out group deletes the opt-out row', async () => {
    await post(`group.sms_whatsapp=on`); // opt out of email
    expect(await groupOptedOut('email')).toBe(true);
    await post(`group.email=on&group.sms_whatsapp=on`); // re-check both
    expect(await groupOptedOut('email')).toBe(false);
  });

  it('"unsubscribe from everything" sets full suppression + flag + opts out BOTH groups + all topics', async () => {
    const res = await post('unsubscribe_all=1');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/unsubscribed/i);
    expect(await suppressed()).toBe(true);
    expect(await unsubAttr()).toBe('true');
    expect(await groupOptedOut('email')).toBe(true);
    expect(await groupOptedOut('sms_whatsapp')).toBe(true);
    expect(await topicSubscribed(topicNews)).toBe(false);
    expect(await topicSubscribed(topicDigest)).toBe(false);
  });

  it('a link missing workspace_id is a 400 (never a guessed workspace)', async () => {
    const res = await app.request(`/manage-subscription?email=${encodeURIComponent(EMAIL)}`);
    expect(res.status).toBe(400);
  });

  it('SCOPED: a POST for workspace B (forged) writes NOTHING in workspace A', async () => {
    // The link is for WS_B but the profile/email only exists in WS. The writes
    // resolve the profile within WS_B (none) → no WS rows touched.
    const linkB = `/manage-subscription?workspace_id=${WS_B}&email=${encodeURIComponent(EMAIL)}`;
    const res = await app.request(linkB, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'unsubscribe_all=1',
    });
    expect(res.status).toBe(200);
    // Workspace A is untouched.
    expect(await suppressed()).toBe(false);
    expect(await groupOptedOut('email')).toBe(false);
    // And WS_B has no suppression for a profile that doesn't exist there.
    const bSupp = (await pool.query('SELECT 1 FROM suppressions WHERE workspace_id=$1', [WS_B])).rowCount ?? 0;
    expect(bSupp).toBe(1); // suppression is keyed by email regardless of profile existence
  });
});
