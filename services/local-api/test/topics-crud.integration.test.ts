// Topics admin CRUD + tenant isolation (CLAUDE.md topic-subscriptions). Topics
// are workspace-scoped; a cross-workspace topic id 404s (inv.1/2); archived
// topics are hidden from the default list; a broadcast can be tagged with a topic
// and a foreign topic id is rejected. Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ec2-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ec2-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ec2-0000-4000-8000-0000000000b1';
const OWNER_B = '0c0d0ec2-0000-4000-8000-0000000000b2';
const SEG = '0c0d0ec2-0000-4000-8000-0000000000d1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('topics CRUD + isolation (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const tok = (u: string, w: string) => tokenFor(u, w);

  const call = (
    method: string,
    path: string,
    who: { u: string; w: string },
    body: Record<string, unknown> = {},
    query: Record<string, string> = {},
  ) => dispatch({ method, path, authorization: tok(who.u, who.w), query, body }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active'),($2,'WB','active')", [WS, WS_B]);
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner'),($3,$4,'owner')",
      [WS, OWNER, WS_B, OWNER_B],
    );
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM topic_subscriptions WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM channel_optouts WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM topics WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  it('create → list → rename → archive lifecycle', async () => {
    const c = await call('POST', '/topics', { u: OWNER, w: WS }, { name: 'Product news', description: 'd' });
    expect(c.status).toBe(201);
    const id = (c.body as { topic: { id: string; name: string } }).topic.id;
    expect((c.body as { topic: { name: string } }).topic.name).toBe('Product news');

    const l = await call('GET', '/topics', { u: OWNER, w: WS });
    expect((l.body as { topics: unknown[] }).topics).toHaveLength(1);

    const r = await call('PATCH', `/topics/${id}`, { u: OWNER, w: WS }, { name: 'Weekly digest' });
    expect(r.status).toBe(200);
    expect((r.body as { topic: { name: string } }).topic.name).toBe('Weekly digest');

    // Archive hides it from the default list, but include_archived shows it.
    const a = await call('PATCH', `/topics/${id}`, { u: OWNER, w: WS }, { archived: true });
    expect((a.body as { topic: { archived: boolean } }).topic.archived).toBe(true);
    const lDefault = await call('GET', '/topics', { u: OWNER, w: WS });
    expect((lDefault.body as { topics: unknown[] }).topics).toHaveLength(0);
    const lAll = await call('GET', '/topics', { u: OWNER, w: WS }, {}, { include_archived: 'true' });
    expect((lAll.body as { topics: unknown[] }).topics).toHaveLength(1);
  });

  it('rejects a blank name (400)', async () => {
    const c = await call('POST', '/topics', { u: OWNER, w: WS }, { name: '   ' });
    expect(c.status).toBe(400);
  });

  it('ISOLATION: workspace B does not see workspace A topics', async () => {
    await call('POST', '/topics', { u: OWNER, w: WS }, { name: 'A-only' });
    const lB = await call('GET', '/topics', { u: OWNER_B, w: WS_B });
    expect((lB.body as { topics: { name: string }[] }).topics.find((t) => t.name === 'A-only')).toBeUndefined();
  });

  it("ISOLATION: B cannot PATCH/DELETE A's topic (404)", async () => {
    const c = await call('POST', '/topics', { u: OWNER, w: WS }, { name: 'cross' });
    const id = (c.body as { topic: { id: string } }).topic.id;
    const p = await call('PATCH', `/topics/${id}`, { u: OWNER_B, w: WS_B }, { name: 'hacked' });
    expect(p.status).toBe(404);
    const d = await call('DELETE', `/topics/${id}`, { u: OWNER_B, w: WS_B });
    expect(d.status).toBe(404);
    // Still intact + unrenamed in A.
    const g = await call('GET', '/topics', { u: OWNER, w: WS });
    expect((g.body as { topics: { name: string }[] }).topics.some((t) => t.name === 'cross')).toBe(true);
  });

  it('DELETE removes a topic (and its subscription rows cascade)', async () => {
    const c = await call('POST', '/topics', { u: OWNER, w: WS }, { name: 'to-delete' });
    const id = (c.body as { topic: { id: string } }).topic.id;
    const d = await call('DELETE', `/topics/${id}`, { u: OWNER, w: WS });
    expect(d.status).toBe(200);
    expect((d.body as { deleted: number }).deleted).toBe(1);
  });

  it('broadcast accepts a workspace topic_id and round-trips it; rejects a foreign one', async () => {
    const c = await call('POST', '/topics', { u: OWNER, w: WS }, { name: 'bc-topic' });
    const topicId = (c.body as { topic: { id: string } }).topic.id;
    const created = await call(
      'POST',
      '/broadcasts',
      { u: OWNER, w: WS },
      { name: 'B', medium: 'email', audience_kind: 'manual', audience_ref: SEG, topic_id: topicId },
    );
    expect(created.status).toBe(201);
    const bid = (created.body as { broadcast: { id: string } }).broadcast.id;
    const got = await call('GET', `/broadcasts/${bid}`, { u: OWNER, w: WS });
    expect((got.body as { broadcast: { topic_id: string } }).broadcast.topic_id).toBe(topicId);

    // A foreign (workspace B) topic on a WS broadcast is rejected.
    const cB = await call('POST', '/topics', { u: OWNER_B, w: WS_B }, { name: 'b-topic' });
    const foreignTopic = (cB.body as { topic: { id: string } }).topic.id;
    const bad = await call(
      'POST',
      '/broadcasts',
      { u: OWNER, w: WS },
      { name: 'X', medium: 'email', audience_kind: 'manual', audience_ref: SEG, topic_id: foreignTopic },
    );
    expect(bad.status).toBe(400);
  });
});
