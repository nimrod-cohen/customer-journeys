// Per-profile subscription management (admin override) — the consolidated read +
// the per-topic / per-channel-group PUTs. Mirrors the public preference-center
// semantics (default-on topics; channel_optouts row = opted out) but for an admin
// editing one profile. Workspace-scoped (a cross-workspace profile/topic 404s).
// Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const WS = '0c0d0ef3-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ef3-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ef3-0000-4000-8000-0000000000b1';
const OWNER_B = '0c0d0ef3-0000-4000-8000-0000000000b2';

describeMaybe('per-profile subscriptions (real Postgres)', () => {
  let pool: Pool;
  let profileId: string;
  let topicNews: string;
  let topicArchived: string;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const call = (method: string, path: string, who: { u: string; w: string }, body: Record<string, unknown> = {}) =>
    dispatch({ method, path, authorization: tokenFor(who.u, who.w), query: {}, body }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active'),($2,'WB','active')", [WS, WS_B]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')", [WS, OWNER, WS_B, OWNER_B]);
    const p = await pool.query("INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,'sub@x.com','{}'::jsonb) RETURNING id", [WS]);
    profileId = p.rows[0].id;
    const t1 = await pool.query("INSERT INTO topics (workspace_id, name) VALUES ($1,'Product news') RETURNING id", [WS]);
    topicNews = t1.rows[0].id;
    const t2 = await pool.query("INSERT INTO topics (workspace_id, name, archived) VALUES ($1,'Old topic', true) RETURNING id", [WS]);
    topicArchived = t2.rows[0].id;
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
      await pool.query('DELETE FROM workspace_users WHERE workspace_id=$1', [w]);
      await pool.query('DELETE FROM workspaces WHERE id=$1', [w]);
    }
  }

  type Subs = {
    globalUnsubscribed: boolean;
    topics: { id: string; name: string; subscribed: boolean }[];
    channels: { group: string; subscribed: boolean }[];
  };
  const getSubs = async (who = { u: OWNER, w: WS }): Promise<Subs> =>
    (await call('GET', `/profiles/${profileId}/subscriptions`, who)).body as Subs;

  it('GET returns default-on topics (archived excluded), both channels on, flag false', async () => {
    const s = await getSubs();
    expect(s.globalUnsubscribed).toBe(false);
    // The archived topic is excluded; the active one is default-subscribed.
    expect(s.topics.map((t) => t.id)).toEqual([topicNews]);
    expect(s.topics[0]!.subscribed).toBe(true);
    expect(s.channels.find((c) => c.group === 'email')!.subscribed).toBe(true);
    expect(s.channels.find((c) => c.group === 'sms_whatsapp')!.subscribed).toBe(true);
  });

  it('reflects a global unsubscribe flag', async () => {
    await pool.query("UPDATE profiles SET attributes='{\"unsubscribed\":true}'::jsonb WHERE workspace_id=$1 AND id=$2", [WS, profileId]);
    expect((await getSubs()).globalUnsubscribed).toBe(true);
  });

  it('PUT topic-subscriptions toggles one topic (default-on → off → on)', async () => {
    const off = await call('PUT', `/profiles/${profileId}/topic-subscriptions/${topicNews}`, { u: OWNER, w: WS }, { subscribed: false });
    expect(off.status).toBe(200);
    expect((await getSubs()).topics[0]!.subscribed).toBe(false);
    await call('PUT', `/profiles/${profileId}/topic-subscriptions/${topicNews}`, { u: OWNER, w: WS }, { subscribed: true });
    expect((await getSubs()).topics[0]!.subscribed).toBe(true);
  });

  it('PUT channel-subscriptions opts a group out (row written) then back in (row deleted)', async () => {
    await call('PUT', `/profiles/${profileId}/channel-subscriptions/email`, { u: OWNER, w: WS }, { subscribed: false });
    expect((await getSubs()).channels.find((c) => c.group === 'email')!.subscribed).toBe(false);
    const rows = await pool.query('SELECT 1 FROM channel_optouts WHERE workspace_id=$1 AND profile_id=$2 AND medium_group=$3', [WS, profileId, 'email']);
    expect(rows.rowCount).toBe(1);
    await call('PUT', `/profiles/${profileId}/channel-subscriptions/email`, { u: OWNER, w: WS }, { subscribed: true });
    expect((await getSubs()).channels.find((c) => c.group === 'email')!.subscribed).toBe(true);
    const after = await pool.query('SELECT 1 FROM channel_optouts WHERE workspace_id=$1 AND profile_id=$2 AND medium_group=$3', [WS, profileId, 'email']);
    expect(after.rowCount).toBe(0);
  });

  it('validates input: non-boolean subscribed → 400; unknown medium group → 400', async () => {
    const bad = await call('PUT', `/profiles/${profileId}/channel-subscriptions/email`, { u: OWNER, w: WS }, { subscribed: 'yes' });
    expect(bad.status).toBe(400);
    const badGroup = await call('PUT', `/profiles/${profileId}/channel-subscriptions/push`, { u: OWNER, w: WS }, { subscribed: false });
    expect(badGroup.status).toBe(400);
  });

  it('tenant isolation: workspace B cannot read or write this profile (404)', async () => {
    expect((await call('GET', `/profiles/${profileId}/subscriptions`, { u: OWNER_B, w: WS_B })).status).toBe(404);
    const w = await call('PUT', `/profiles/${profileId}/channel-subscriptions/email`, { u: OWNER_B, w: WS_B }, { subscribed: false });
    expect(w.status).toBe(404);
    const t = await call('PUT', `/profiles/${profileId}/topic-subscriptions/${topicNews}`, { u: OWNER_B, w: WS_B }, { subscribed: false });
    expect(t.status).toBe(404);
  });

  // --- the FULL-state endpoint (admin Subscriptions tab) enforces the invariants ---
  const putSubs = (channels: { email: boolean; sms_whatsapp: boolean }, topics: { id: string; subscribed: boolean }[]) =>
    call('PUT', `/profiles/${profileId}/subscriptions`, { u: OWNER, w: WS }, { channels, topics });
  const suppressed = async () =>
    ((await pool.query("SELECT 1 FROM suppressions WHERE workspace_id=$1 AND email=(SELECT email FROM profiles WHERE id=$2) AND reason='unsubscribe'", [WS, profileId])).rowCount ?? 0) > 0;
  const attrUnsub = async () =>
    (await pool.query("SELECT attributes->>'unsubscribed' AS u FROM profiles WHERE id=$1", [profileId])).rows[0]?.u ?? null;

  it('PUT full state: a topic ON with both channels off AUTO-ENABLES both channels (a topic needs a channel)', async () => {
    const res = await putSubs({ email: false, sms_whatsapp: false }, [{ id: topicNews, subscribed: true }]);
    expect(res.status).toBe(200);
    const s = await getSubs();
    expect(s.channels.find((c) => c.group === 'email')!.subscribed).toBe(true);
    expect(s.channels.find((c) => c.group === 'sms_whatsapp')!.subscribed).toBe(true);
    expect(s.topics.find((t) => t.id === topicNews)!.subscribed).toBe(true);
    expect(s.globalUnsubscribed).toBe(false);
    expect(await suppressed()).toBe(false);
  });

  it('PUT full state: EVERYTHING off is a global unsubscribe (suppression + flag, all topics off)', async () => {
    const res = await putSubs({ email: false, sms_whatsapp: false }, [{ id: topicNews, subscribed: false }]);
    expect(res.status).toBe(200);
    const s = await getSubs();
    expect(s.globalUnsubscribed).toBe(true);
    expect(s.channels.every((c) => !c.subscribed)).toBe(true);
    expect(s.topics.every((t) => !t.subscribed)).toBe(true);
    expect(await suppressed()).toBe(true);
    expect(await attrUnsub()).toBe('true');
  });

  it('PUT full state: all topics off with channels ON is a global unsubscribe (a topic is required)', async () => {
    const res = await putSubs({ email: true, sms_whatsapp: true }, [{ id: topicNews, subscribed: false }]);
    expect(res.status).toBe(200);
    const s = await getSubs();
    expect(s.globalUnsubscribed).toBe(true); // no topic → nothing deliverable → unsubscribed
    expect(s.channels.every((c) => !c.subscribed)).toBe(true); // uniformly everything-off
    expect(await suppressed()).toBe(true);
  });

  it('PUT full state: resuming needs BOTH a channel and a topic — lifts the unsubscribe', async () => {
    await putSubs({ email: false, sms_whatsapp: false }, [{ id: topicNews, subscribed: false }]); // unsubscribe
    expect(await suppressed()).toBe(true);
    // A channel alone is NOT enough (no topic) → still unsubscribed.
    await putSubs({ email: true, sms_whatsapp: false }, [{ id: topicNews, subscribed: false }]);
    expect((await getSubs()).globalUnsubscribed).toBe(true);
    // A channel + a topic → subscribed.
    const res = await putSubs({ email: true, sms_whatsapp: false }, [{ id: topicNews, subscribed: true }]);
    expect(res.status).toBe(200);
    expect((await getSubs()).globalUnsubscribed).toBe(false);
    expect(await suppressed()).toBe(false);
    expect(await attrUnsub()).toBe('false');
  });

  it('PUT full state: one channel off with the other on is a partial opt-out (NOT unsubscribed)', async () => {
    const res = await putSubs({ email: false, sms_whatsapp: true }, [{ id: topicNews, subscribed: true }]);
    expect(res.status).toBe(200);
    const s = await getSubs();
    expect(s.channels.find((c) => c.group === 'email')!.subscribed).toBe(false);
    expect(s.channels.find((c) => c.group === 'sms_whatsapp')!.subscribed).toBe(true);
    expect(s.globalUnsubscribed).toBe(false);
    expect(await suppressed()).toBe(false);
  });

  it('PUT full state: a re-subscribe never deletes a bounce suppression (only the unsubscribe one)', async () => {
    await pool.query("INSERT INTO suppressions (workspace_id, email, reason, source) SELECT $1, email, 'bounce', 'ses' FROM profiles WHERE id=$2", [WS, profileId]);
    await putSubs({ email: true, sms_whatsapp: true }, [{ id: topicNews, subscribed: true }]);
    const r = await pool.query("SELECT reason FROM suppressions WHERE workspace_id=$1 AND email=(SELECT email FROM profiles WHERE id=$2)", [WS, profileId]);
    expect(r.rows.map((x) => x.reason)).toEqual(['bounce']); // bounce kept
  });

  // --- the GLOBAL (un)subscribe endpoint (the Attributes-tab toggle) ---
  const setGlobal = (unsubscribed: boolean) =>
    call('PUT', `/profiles/${profileId}/global-subscription`, { u: OWNER, w: WS }, { unsubscribed });

  it('global-subscription true: opts out EVERY channel + topic + suppression + flag', async () => {
    // Start subscribed (some explicit on-state).
    await putSubs({ email: true, sms_whatsapp: true }, [{ id: topicNews, subscribed: true }]);
    const res = await setGlobal(true);
    expect(res.status).toBe(200);
    const s = await getSubs();
    expect(s.globalUnsubscribed).toBe(true);
    expect(s.channels.every((c) => !c.subscribed)).toBe(true);
    expect(s.topics.every((t) => !t.subscribed)).toBe(true);
    expect(await suppressed()).toBe(true);
    expect(await attrUnsub()).toBe('true');
  });

  it('global-subscription false: RESUMES to default-on (no opt-out rows, no suppression, flag false)', async () => {
    await setGlobal(true); // unsubscribe first
    expect(await suppressed()).toBe(true);
    const res = await setGlobal(false);
    expect(res.status).toBe(200);
    const s = await getSubs();
    expect(s.globalUnsubscribed).toBe(false);
    expect(s.channels.every((c) => c.subscribed)).toBe(true); // default-on (rows deleted)
    expect(s.topics.every((t) => t.subscribed)).toBe(true);
    expect(await suppressed()).toBe(false);
    expect(await attrUnsub()).toBe('false');
  });

  it('global-subscription: 400 on a non-boolean, 404 cross-workspace', async () => {
    expect((await call('PUT', `/profiles/${profileId}/global-subscription`, { u: OWNER, w: WS }, { unsubscribed: 'yes' })).status).toBe(400);
    expect((await call('PUT', `/profiles/${profileId}/global-subscription`, { u: OWNER_B, w: WS_B }, { unsubscribed: true })).status).toBe(404);
  });
});
