// Retry a FAILED send from the activity log (real Postgres). A failed send leaves
// its outbox row terminal with the original payload; POST /messages/:id/retry resets
// it to pending and re-dispatches (here a WhatsApp text via the offline MOCK provider,
// so no creds are needed). Includes the double-send guard.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import type { Pool } from 'pg';
import { makePgLookups, makeLocalDeps, type DispatchEnv } from '../src/index.js';
import { tokenFor, call } from './seed.js';

const P = '0c0d0e0f-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;
const PROF = `${P}0000000000c1`;
const BC = `${P}0000000000d1`;

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('retry a failed send (real Postgres)', () => {
  let pool: Pool;
  let env: DispatchEnv;

  beforeAll(async () => {
    pool = adminPool();
    env = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WS','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO, OWNER]);
    await pool.query(
      `INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,'r@acme.test', '{"phone":"+972529461566"}'::jsonb)`,
      [PROF, WS],
    );
    await pool.query(
      "INSERT INTO broadcasts (id, workspace_id, name, status, medium, text_body) VALUES ($1,$2,'WA','sent','whatsapp','Hi {{customer.email}}')",
      [BC, WS],
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM usage_counters WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM broadcasts WHERE id = $1', [BC]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  // Seed a failed send: a terminal outbox row + a 'failed' messages_log row.
  async function seedFailedSend(): Promise<string> {
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query(
      `INSERT INTO outbox (workspace_id, profile_id, dedupe_key, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'failed')`,
      [WS, PROF, `broadcast:${BC}:${PROF}`, JSON.stringify({ broadcast_id: BC, medium: 'whatsapp', text_body: 'Hi {{customer.email}}' })],
    );
    const ml = await pool.query<{ id: string }>(
      `INSERT INTO messages_log (workspace_id, profile_id, broadcast_id, medium, status, reason)
       VALUES ($1,$2,$3,'whatsapp','failed','Meta WhatsApp 403') RETURNING id`,
      [WS, PROF, BC],
    );
    return ml.rows[0]!.id;
  }

  it('re-queues a failed WhatsApp send and delivers via the mock', async () => {
    const mlId = await seedFailedSend();
    const r = await call(env, 'POST', `/messages/${mlId}/retry`, { token: tokenFor(OWNER, WS) });
    expect(r.status).toBe(200);
    expect((r.body as { retried: boolean; result: string }).retried).toBe(true);
    expect((r.body as { result: string }).result).toBe('send');
    // The outbox row is terminal again (sent) and a new 'sent' messages_log exists.
    const sent = await pool.query("SELECT 1 FROM messages_log WHERE workspace_id=$1 AND profile_id=$2 AND status='sent'", [WS, PROF]);
    expect(sent.rowCount).toBe(1);
  });

  it('refuses to retry once the recipient has already received it (409)', async () => {
    // From the previous test a 'sent' row exists. Seed a fresh 'failed' entry and try again.
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query(
      `INSERT INTO outbox (workspace_id, profile_id, dedupe_key, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'failed')`,
      [WS, PROF, `broadcast:${BC}:${PROF}:x`, JSON.stringify({ broadcast_id: BC, medium: 'whatsapp', text_body: 'Hi' })],
    );
    const ml = await pool.query<{ id: string }>(
      `INSERT INTO messages_log (workspace_id, profile_id, broadcast_id, medium, status, reason)
       VALUES ($1,$2,$3,'whatsapp','failed','again') RETURNING id`,
      [WS, PROF, BC],
    );
    const r = await call(env, 'POST', `/messages/${ml.rows[0]!.id}/retry`, { token: tokenFor(OWNER, WS) });
    expect(r.status).toBe(409); // already delivered to this recipient
  });

  it('a non-failed send id is 400; a foreign id is 404', async () => {
    const okSend = await pool.query<{ id: string }>(
      `INSERT INTO messages_log (workspace_id, profile_id, broadcast_id, medium, status)
       VALUES ($1,$2,$3,'whatsapp','sent') RETURNING id`,
      [WS, PROF, BC],
    );
    expect((await call(env, 'POST', `/messages/${okSend.rows[0]!.id}/retry`, { token: tokenFor(OWNER, WS) })).status).toBe(400);
    expect((await call(env, 'POST', `/messages/${PROF}/retry`, { token: tokenFor(OWNER, WS) })).status).toBe(404);
  });
});
