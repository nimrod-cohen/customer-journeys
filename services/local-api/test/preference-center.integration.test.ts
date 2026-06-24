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
import { signUnsubscribeToken, packSubscriptionToken, unsubscribeLinkSecret } from '@cdp/email';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0ec3-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ec3-0000-4000-8000-000000000a02';
const EMAIL = 'pref@example.com';

// The links are TOKENIZED: the app verifies with unsubscribeLinkSecret() (the
// dev fallback in tests). Sign with the SAME resolver the handler uses.
const tok = (ws: string, e: string) => signUnsubscribeToken(unsubscribeLinkSecret(), ws, e);

describeMaybe('public preference center (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let profileId: string;
  let topicNews: string;
  let topicDigest: string;
  const link = `/manage-subscription?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS, EMAIL)}`;

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

  // Whether the rendered checkbox for `testid` carries the `checked` attribute
  // (markup: `<input ... [checked] data-testid="TESTID">`).
  const isChecked = (html: string, testid: string): boolean => html.includes(`checked data-testid="${testid}"`);

  it('GET reflects a GLOBAL unsubscribe (suppression + flag, no granular rows) — every toggle is OFF', async () => {
    // Simulate a full /unsubscribe one-click: suppression + the flag, but NO
    // channel_optouts / topic_subscriptions rows (the bug repro).
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'unsubscribe','one-click')", [WS, EMAIL]);
    await pool.query("UPDATE profiles SET attributes='{\"unsubscribed\":true}'::jsonb WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]);

    const html = await (await app.request(link)).text();
    // Bug was: default-on granular view showed everything CHECKED. Now every toggle is OFF.
    expect(isChecked(html, 'pref-group-email')).toBe(false);
    expect(isChecked(html, 'pref-group-sms_whatsapp')).toBe(false);
    expect(isChecked(html, `pref-topic-${topicNews}`)).toBe(false);
    expect(isChecked(html, `pref-topic-${topicDigest}`)).toBe(false);
  });

  it('re-enabling a channel while globally unsubscribed LIFTS the master kill switch (so the choice takes effect)', async () => {
    // Globally unsubscribed (no granular rows).
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'unsubscribe','one-click')", [WS, EMAIL]);
    await pool.query("UPDATE profiles SET attributes='{\"unsubscribed\":true}'::jsonb WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]);

    // Re-enable email only (sms stays off) via the preference center.
    const res = await post(`group.email=on&topic.${topicNews}=on&topic.${topicDigest}=on`);
    expect(res.status).toBe(200);
    // The unsubscribe suppression + the flag are LIFTED → reachable again.
    expect(await suppressed()).toBe(false);
    expect(await unsubAttr()).toBe('false');
    expect(await groupOptedOut('email')).toBe(false); // re-subscribed
    expect(await groupOptedOut('sms_whatsapp')).toBe(true); // left off
  });

  it('re-enabling only a TOPIC (no channel) while globally unsubscribed STILL lifts the kill switch + saves the topic', async () => {
    // The reported bug: turning on a topic (channels left off) saved the topic but
    // left the profile globally unsubscribed. Now any positive choice resumes them.
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'unsubscribe','one-click')", [WS, EMAIL]);
    await pool.query("UPDATE profiles SET attributes='{\"unsubscribed\":true}'::jsonb WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]);

    // Turn ON one topic only; both channel boxes left unchecked.
    const res = await post(`topic.${topicNews}=on`);
    expect(res.status).toBe(200);
    expect(await topicSubscribed(topicNews)).toBe(true); // topic preference saved
    // The master kill switch is LIFTED (no longer globally unsubscribed).
    expect(await suppressed()).toBe(false);
    expect(await unsubAttr()).toBe('false');
  });

  it('GET shows the "currently unsubscribed" banner when globally unsubscribed', async () => {
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'unsubscribe','one-click')", [WS, EMAIL]);
    const html = await (await app.request(link)).text();
    expect(html).toContain('pref-unsubscribed-banner');
  });

  it('re-subscribe NEVER deletes a bounce/complaint suppression (only the unsubscribe one)', async () => {
    // A hard bounce suppression must keep blocking even when the user re-subscribes.
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason, source) VALUES ($1,$2,'bounce','ses')", [WS, EMAIL]);
    await pool.query("UPDATE profiles SET attributes='{\"unsubscribed\":true}'::jsonb WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]);
    await post(`group.email=on`);
    // The bounce suppression survives (reason != 'unsubscribe').
    const r = await pool.query("SELECT reason FROM suppressions WHERE workspace_id=$1 AND email=$2", [WS, EMAIL]);
    expect(r.rows.map((x) => x.reason)).toEqual(['bounce']);
  });

  it('a link missing workspace_id is a 400 (never a guessed workspace)', async () => {
    const res = await app.request(`/manage-subscription?email=${encodeURIComponent(EMAIL)}`);
    expect(res.status).toBe(400);
  });

  it('a link with NO token is 403 (unguessable, signed link required)', async () => {
    const noTok = `/manage-subscription?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}`;
    expect((await app.request(noTok)).status).toBe(403);
    const res = await app.request(noTok, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'unsubscribe_all=1',
    });
    expect(res.status).toBe(403);
    expect(await suppressed()).toBe(false); // no write on a 403
  });

  it('a forged token (signed for another email) is 403', async () => {
    const bad = `/manage-subscription?workspace_id=${WS}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS, 'someone-else@x.com')}`;
    expect((await app.request(bad)).status).toBe(403);
  });

  it('ADAPTIVE: topics_enabled=false → the GET shows the SIMPLE unsubscribe page and POST does a full opt-out', async () => {
    await pool.query("UPDATE workspaces SET settings='{\"topics_enabled\":false}'::jsonb WHERE id=$1", [WS]);
    try {
      const get = await app.request(link);
      expect(get.status).toBe(200);
      const html = await get.text();
      // The SIMPLE confirm page (one source of truth) — not the topic checkboxes.
      expect(html).toContain('confirm-unsubscribe');
      expect(html).not.toContain('pref-group-email');
      // POST behaves like a plain unsubscribe: full suppression + flag.
      const res = await post('');
      expect(res.status).toBe(200);
      expect(await suppressed()).toBe(true);
      expect(await unsubAttr()).toBe('true');
    } finally {
      await pool.query("UPDATE workspaces SET settings='{}'::jsonb WHERE id=$1", [WS]);
    }
  });

  it('ADAPTIVE: a workspace with ZERO active topics shows the simple page even when topics_enabled', async () => {
    // Archive both topics so there are no ACTIVE topics → simple page.
    await pool.query("UPDATE topics SET archived=true WHERE workspace_id=$1", [WS]);
    try {
      const get = await app.request(link);
      expect(get.status).toBe(200);
      expect(await get.text()).toContain('confirm-unsubscribe');
    } finally {
      await pool.query("UPDATE topics SET archived=false WHERE workspace_id=$1", [WS]);
    }
  });

  it('ADAPTIVE: topics_enabled (default) + active topics → the topics center renders', async () => {
    const get = await app.request(link);
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain('Product news');
    expect(html).toContain('pref-group-email');
  });

  it('SCOPED: a POST for workspace B (forged) writes NOTHING in workspace A', async () => {
    // The link is for WS_B but the profile/email only exists in WS. The writes
    // resolve the profile within WS_B (none) → no WS rows touched.
    const linkB = `/manage-subscription?workspace_id=${WS_B}&email=${encodeURIComponent(EMAIL)}&token=${tok(WS_B, EMAIL)}`;
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

  // ── NEW: the compact self-contained `?t=` link ──────────────────────────
  describe('compact `?t=` link', () => {
    const tLink = () => `/manage-subscription?t=${packSubscriptionToken(unsubscribeLinkSecret(), WS, EMAIL)}`;
    const tPost = (body: string) =>
      app.request(tLink(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });

    it('GET renders the topics center', async () => {
      const res = await app.request(tLink());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Product news');
      expect(html).toContain('pref-group-email');
    });

    it('PARTIAL opt-out (one group) does NOT set the global suppression', async () => {
      const res = await tPost(`group.sms_whatsapp=on&topic.${topicNews}=on&topic.${topicDigest}=on`);
      expect(res.status).toBe(200);
      expect(await groupOptedOut('email')).toBe(true);
      expect(await groupOptedOut('sms_whatsapp')).toBe(false);
      expect(await suppressed()).toBe(false);
    });

    it('"unsubscribe from everything" sets full suppression + flag', async () => {
      const res = await tPost('unsubscribe_all=1');
      expect(res.status).toBe(200);
      expect(await suppressed()).toBe(true);
      expect(await unsubAttr()).toBe('true');
    });

    it('a forged `?t=` token (wrong secret) is 403 and writes NOTHING', async () => {
      const forged = packSubscriptionToken('a-different-secret', WS, EMAIL);
      const res = await app.request(`/manage-subscription?t=${forged}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'unsubscribe_all=1',
      });
      expect(res.status).toBe(403);
      expect(await suppressed()).toBe(false);
    });
  });
});
