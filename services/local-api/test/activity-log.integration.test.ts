// Activity log (§12): a unified feed over events + email_events + messages_log,
// newest-first, with filters (from/to, type, outcome, source). REAL Postgres.
// Proves the feed is workspace-scoped IN CODE (a cross-tenant row never appears),
// the outcome derivation, and each filter.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS_A = '0a0b0c04-0000-4000-8000-000000000a01';
const WS_B = '0a0b0c04-0000-4000-8000-000000000a02';
const USER = '0a0b0c04-0000-4000-8000-0000000000b1'; // owner of A only
const P_A = '0a0b0c04-0000-4000-8000-0000000000c1';
const P_B = '0a0b0c04-0000-4000-8000-0000000000c2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

interface Row {
  source: string;
  type: string;
  outcome: string;
  email: string | null;
}

describeMaybe('activity log (real Postgres)', () => {
  let world: TestWorld;
  const tokA = () => tokenFor(USER, WS_A);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_A, USER],
    );
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'a1','a1@acme.com')",
      [P_A, WS_A],
    );
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'b1','b1@beta.com')",
      [P_B, WS_B],
    );
    // A behavioural event (info), an email delivery (success) + bounce (failure),
    // and a send (success) for A — at increasing times so order is deterministic.
    await world.pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at) VALUES (gen_random_uuid(),$1,$2,'page_view','2026-01-01T00:00:00Z')",
      [WS_A, P_A],
    );
    await world.pool.query(
      "INSERT INTO email_events (workspace_id, profile_id, type, occurred_at) VALUES ($1,$2,'delivery','2026-01-02T00:00:00Z')",
      [WS_A, P_A],
    );
    await world.pool.query(
      "INSERT INTO email_events (workspace_id, profile_id, type, sub_type, occurred_at) VALUES ($1,$2,'bounce','Permanent','2026-01-03T00:00:00Z')",
      [WS_A, P_A],
    );
    await world.pool.query(
      "INSERT INTO messages_log (workspace_id, profile_id, status, sent_at) VALUES ($1,$2,'sent','2026-01-04T00:00:00Z')",
      [WS_A, P_A],
    );
    // B activity — must NEVER appear in A's feed.
    await world.pool.query(
      "INSERT INTO email_events (workspace_id, profile_id, type, occurred_at) VALUES ($1,$2,'complaint','2026-01-05T00:00:00Z')",
      [WS_B, P_B],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      await world.pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function activity(query: Record<string, string> = {}): Promise<Row[]> {
    const r = await call(world.env, 'GET', '/activity', { token: tokA(), query });
    expect(r.status).toBe(200);
    return (r.body as { activity: Row[] }).activity;
  }

  it('merges all sources, newest-first, and never shows another tenant', async () => {
    const rows = await activity();
    expect(rows.map((r) => `${r.source}:${r.type}`)).toEqual([
      'send:send',
      'email:bounce',
      'email:delivery',
      'event:page_view',
    ]);
    // No B row (the complaint) leaks in.
    expect(rows.some((r) => r.type === 'complaint')).toBe(false);
    // profile email is resolved.
    expect(rows[0]?.email).toBe('a1@acme.com');
  });

  it('derives outcome (success/failure/info)', async () => {
    const byType = Object.fromEntries((await activity()).map((r) => [r.type, r.outcome]));
    expect(byType['delivery']).toBe('success');
    expect(byType['send']).toBe('success');
    expect(byType['bounce']).toBe('failure');
    expect(byType['page_view']).toBe('info');
  });

  it('filters by outcome=failure', async () => {
    const rows = await activity({ outcome: 'failure' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('bounce');
  });

  it('filters by source=email', async () => {
    const rows = await activity({ source: 'email' });
    expect(rows.every((r) => r.source === 'email')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('filters by a datetime window', async () => {
    const rows = await activity({ from: '2026-01-02T00:00:00Z', to: '2026-01-03T12:00:00Z' });
    expect(rows.map((r) => r.type).sort()).toEqual(['bounce', 'delivery']);
  });

  it('a different workspace sees an empty feed (isolation)', async () => {
    // A token active on B (USER is not a member of B) is rejected upstream; assert
    // instead that A's feed excludes B and that the type filter is scoped.
    const rows = await activity({ type: 'complaint' });
    expect(rows).toHaveLength(0);
  });
});
