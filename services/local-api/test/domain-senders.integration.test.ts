// Domain senders CRUD through the API (§10). REAL Postgres. Proves: add derives
// the domain from the address and validates it; list is grouped-ready + scoped;
// duplicate address is 409; delete is scoped (a foreign workspace can't touch it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0e20-0000-4000-8000-000000000a01';
const OTHER = '0c0d0e20-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e20-0000-4000-8000-0000000000b1';
const OTHER_OWNER = '0c0d0e20-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

function env(pool: Pool): DispatchEnv {
  return { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
}

describeMaybe('domain senders via API (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => env(pool);
  const tok = (): string => tokenFor(OWNER, WS);

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const [ws, owner] of [[WS, OWNER], [OTHER, OTHER_OWNER]] as const) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await pool.query(
        "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [ws, owner],
      );
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, OTHER]) {
      await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  const add = (token: string, name: string, email: string) =>
    dispatch({ method: 'POST', path: '/domain-senders', authorization: token, query: {}, body: { name, email } }, e());
  const list = (token: string) =>
    dispatch({ method: 'GET', path: '/domain-senders', authorization: token, query: {}, body: {} }, e());

  it('adds senders, derives the domain, lists them; rejects bad input', async () => {
    const r1 = await add(tok(), 'Support', 'support@mail.acme.com');
    expect(r1.status).toBe(201);
    expect((r1.body as { sender: { domain: string } }).sender.domain).toBe('mail.acme.com');
    await add(tok(), 'Sales', 'sales@mail.acme.com');

    const l = await list(tok());
    const senders = (l.body as { senders: Array<{ name: string; domain: string; email: string }> }).senders;
    expect(senders).toHaveLength(2);
    expect(senders.every((s) => s.domain === 'mail.acme.com')).toBe(true);

    // Validation: missing name, malformed email.
    expect((await add(tok(), '', 'x@y.com')).status).toBe(400);
    expect((await add(tok(), 'No Domain', 'not-an-email')).status).toBe(400);
  });

  it('rejects a duplicate address with 409', async () => {
    const dup = await add(tok(), 'Support Again', 'support@mail.acme.com');
    expect(dup.status).toBe(409);
  });

  it('is workspace-scoped: another workspace neither sees nor can delete these', async () => {
    // The other workspace's list is empty (isolation).
    const otherList = await list(tokenFor(OTHER_OWNER, OTHER));
    expect((otherList.body as { senders: unknown[] }).senders).toHaveLength(0);

    // The other owner cannot delete a sender belonging to WS (scoped → 404).
    const mine = (await list(tok())).body as { senders: Array<{ id: string }> };
    const id = mine.senders[0]!.id;
    const del = await dispatch(
      { method: 'DELETE', path: `/domain-senders/${id}`, authorization: tokenFor(OTHER_OWNER, OTHER), query: {}, body: {} },
      e(),
    );
    expect(del.status).toBe(404);

    // The owner can delete it.
    const okDel = await dispatch(
      { method: 'DELETE', path: `/domain-senders/${id}`, authorization: tok(), query: {}, body: {} },
      e(),
    );
    expect(okDel.status).toBe(200);
  });
});
