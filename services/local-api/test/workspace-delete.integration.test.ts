// Deleting a workspace with data in the tables that USED to break it.
//
// The reported failure: "update or delete on table workspaces violates foreign key
// constraint domain_senders_workspace_id_fkey". A workspace that had ever had a
// sending domain, a topic, an asset or a tracked link could not be deleted at all —
// eleven tables were missing from the purge list.
//
// This seeds a row in each of the previously-missing tables and deletes for real.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d2233-0000-4000-8000-000000000c01';
const WS = '0c0d2233-0000-4000-8000-000000000a01'; // the one deleted
const WS_KEEP = '0c0d2233-0000-4000-8000-000000000a02'; // caller's active workspace
const USER = '0c0d2233-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('deleting a workspace with a sending domain, topic and assets', () => {
  let world: TestWorld;
  let pool: Pool;

  async function cleanup(): Promise<void> {
    for (const t of [
      'tracked_links', 'tracked_opens', 'topic_subscriptions', 'channel_optouts',
      'email_templates', 'domain_senders', 'sending_domains', 'text_templates',
      'assets', 'asset_folders', 'topics', 'automations', 'broadcasts',
      'suppressions', 'profiles', 'workspace_users',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1)`, [[WS, WS_KEEP]]).catch(() => {});
    }
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS, WS_KEEP]]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]).catch(() => {});
  }

  beforeAll(async () => {
    world = makeWorld();
    pool = world.pool;
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Del')", [CO]);
    for (const w of [WS, WS_KEEP]) {
      await pool.query(
        "INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,$3,'active')",
        [w, CO, w === WS ? 'Value Investing' : 'Keep'],
      );
      await pool.query(
        "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [w, USER],
      );
    }

    // Exactly the tables that were missing from the purge list.
    await pool.query(
      "INSERT INTO sending_domains (id, workspace_id, domain, verified) VALUES ('0c0d2233-0000-4000-8000-0000000000d1',$1,'acme.com',true)",
      [WS],
    );
    await pool.query(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'acme.com','Acme','hello@acme.com')",
      [WS],
    );
    await pool.query(
      "INSERT INTO topics (id, workspace_id, name) VALUES ('0c0d2233-0000-4000-8000-0000000000e1',$1,'News')",
      [WS],
    );
    await pool.query(
      "INSERT INTO profiles (id, workspace_id, email) VALUES ('0c0d2233-0000-4000-8000-0000000000f1',$1,'p@acme.com')",
      [WS],
    );
    await pool.query(
      "INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed) VALUES ($1,'0c0d2233-0000-4000-8000-0000000000f1','0c0d2233-0000-4000-8000-0000000000e1',false)",
      [WS],
    );
    await pool.query(
      "INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,'0c0d2233-0000-4000-8000-0000000000f1','email')",
      [WS],
    );
    await pool.query("INSERT INTO text_templates (workspace_id, name, body) VALUES ($1,'T','hi')", [WS]);
    await pool.query("INSERT INTO asset_folders (workspace_id, name) VALUES ($1,'f')", [WS]);
    await pool.query(
      "INSERT INTO tracked_links (workspace_id, token, url) VALUES ($1,'tok0c0d2233','https://x.test')",
      [WS],
    );
    await pool.query(
      "INSERT INTO tracked_opens (workspace_id, token, profile_id) VALUES ($1,'opn0c0d2233','0c0d2233-0000-4000-8000-0000000000f1')",
      [WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it('deletes the workspace and every one of its rows', async () => {
    const res = await call(world.env, 'DELETE', `/workspaces/${WS}`, {
      token: tokenFor(USER, WS_KEEP),
      body: { confirm_name: 'Value Investing' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { deleted: boolean }).deleted).toBe(true);

    const gone = await pool.query('SELECT 1 FROM workspaces WHERE id = $1', [WS]);
    expect(gone.rowCount).toBe(0);

    // Nothing orphaned in any of the tables that used to block the delete.
    for (const t of [
      'sending_domains', 'domain_senders', 'topics', 'topic_subscriptions',
      'channel_optouts', 'text_templates', 'asset_folders', 'tracked_links',
      'tracked_opens', 'profiles',
    ]) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE workspace_id = $1`,
        [WS],
      );
      expect(rows[0]!.n, `${t} still has rows for the deleted workspace`).toBe(0);
    }
  });

  it('leaves the sibling workspace untouched', async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM workspaces WHERE id = $1',
      [WS_KEEP],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
