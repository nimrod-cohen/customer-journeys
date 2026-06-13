// Domain senders + sending domains through the API (§10). REAL Postgres. Proves:
// a workspace can list several sending domains (added unverified, then verified);
// a domain_sender requires a VERIFIED domain; the address's domain is derived and
// validated; duplicates 409; deletes are workspace-scoped; a domain with senders
// can't be removed.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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

describeMaybe('sending domains + senders via API (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => env(pool);
  const tok = (): string => tokenFor(OWNER, WS);

  const addSender = (token: string, name: string, email: string) =>
    dispatch({ method: 'POST', path: '/domain-senders', authorization: token, query: {}, body: { name, email } }, e());
  const listSenders = (token: string) =>
    dispatch({ method: 'GET', path: '/domain-senders', authorization: token, query: {}, body: {} }, e());
  const addDomain = (token: string, domain: string) =>
    dispatch({ method: 'POST', path: '/sending-domains', authorization: token, query: {}, body: { domain } }, e());
  const listDomains = (token: string) =>
    dispatch({ method: 'GET', path: '/sending-domains', authorization: token, query: {}, body: {} }, e());
  const verifyDomain = (token: string, id: string) =>
    dispatch({ method: 'POST', path: `/sending-domains/${id}/verify`, authorization: token, query: {}, body: {} }, e());
  const delDomain = (token: string, id: string) =>
    dispatch({ method: 'DELETE', path: `/sending-domains/${id}`, authorization: token, query: {}, body: {} }, e());

  /** Add `domain` and verify it; returns its id. */
  async function verifiedDomain(domain: string): Promise<string> {
    const created = await addDomain(tok(), domain);
    const id = (created.body as { domain: { id: string } }).domain.id;
    await verifyDomain(tok(), id);
    return id;
  }

  beforeAll(async () => {
    pool = adminPool();
    await dropWorkspaces();
    for (const [ws, owner] of [[WS, OWNER], [OTHER, OTHER_OWNER]] as const) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await pool.query(
        "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [ws, owner],
      );
    }
  });

  beforeEach(async () => {
    for (const ws of [WS, OTHER]) {
      await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
    }
  });

  afterAll(async () => {
    if (pool) {
      await dropWorkspaces();
      await pool.end();
    }
  });

  async function dropWorkspaces(): Promise<void> {
    for (const ws of [WS, OTHER]) {
      await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('a domain is added UNVERIFIED, then verified; a bad domain is rejected', async () => {
    const created = await addDomain(tok(), 'mail.acme.com');
    expect(created.status).toBe(201);
    expect((created.body as { domain: { verified: boolean } }).domain.verified).toBe(false);

    expect((await addDomain(tok(), 'not a domain')).status).toBe(400);
    expect((await addDomain(tok(), 'mail.acme.com')).status).toBe(409); // duplicate

    const id = (created.body as { domain: { id: string } }).domain.id;
    expect((await verifyDomain(tok(), id)).status).toBe(200);
    const after = (await listDomains(tok())).body as { domains: Array<{ verified: boolean }> };
    expect(after.domains[0]!.verified).toBe(true);
  });

  it('a sender requires a VERIFIED sending domain', async () => {
    // No domain → rejected.
    expect((await addSender(tok(), 'Support', 'support@mail.acme.com')).status).toBe(400);
    // Added but unverified → still rejected.
    const created = await addDomain(tok(), 'mail.acme.com');
    const id = (created.body as { domain: { id: string } }).domain.id;
    expect((await addSender(tok(), 'Support', 'support@mail.acme.com')).status).toBe(400);
    // Verified → allowed; domain derived from the address.
    await verifyDomain(tok(), id);
    const ok = await addSender(tok(), 'Support', 'support@mail.acme.com');
    expect(ok.status).toBe(201);
    expect((ok.body as { sender: { domain: string } }).sender.domain).toBe('mail.acme.com');
  });

  it('adds senders, lists them, rejects bad input + duplicate address', async () => {
    await verifiedDomain('mail.acme.com');
    expect((await addSender(tok(), 'Support', 'support@mail.acme.com')).status).toBe(201);
    await addSender(tok(), 'Sales', 'sales@mail.acme.com');

    const senders = (await listSenders(tok())).body as { senders: unknown[] };
    expect(senders.senders).toHaveLength(2);

    expect((await addSender(tok(), '', 'x@mail.acme.com')).status).toBe(400); // no name
    expect((await addSender(tok(), 'Bad', 'not-an-email')).status).toBe(400); // bad email
    expect((await addSender(tok(), 'Dup', 'support@mail.acme.com')).status).toBe(409); // duplicate
  });

  it("a domain with senders can't be deleted until they're removed", async () => {
    const id = await verifiedDomain('mail.acme.com');
    await addSender(tok(), 'Support', 'support@mail.acme.com');
    expect((await delDomain(tok(), id)).status).toBe(409); // in use

    const senders = (await listSenders(tok())).body as { senders: Array<{ id: string }> };
    await dispatch(
      { method: 'DELETE', path: `/domain-senders/${senders.senders[0]!.id}`, authorization: tok(), query: {}, body: {} },
      e(),
    );
    expect((await delDomain(tok(), id)).status).toBe(200); // now removable
  });

  it('is workspace-scoped: another workspace neither sees nor can mutate these', async () => {
    const id = await verifiedDomain('mail.acme.com');
    await addSender(tok(), 'Support', 'support@mail.acme.com');

    const otherTok = tokenFor(OTHER_OWNER, OTHER);
    expect(((await listDomains(otherTok)).body as { domains: unknown[] }).domains).toHaveLength(0);
    expect(((await listSenders(otherTok)).body as { senders: unknown[] }).senders).toHaveLength(0);
    // The other owner can't verify or delete WS's domain (scoped → 404).
    expect((await verifyDomain(otherTok, id)).status).toBe(404);
    expect((await delDomain(otherTok, id)).status).toBe(404);
  });
});
