// Pre-send gate (§10/inv.7): POST /broadcasts/:id/send refuses (409) unless the
// workspace has a VERIFIED sending domain — so a broadcast is never queued/marked
// sent with no way to actually send. Once a domain is verified, the send proceeds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0e50-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e50-0000-4000-8000-0000000000b1';
const SEG = '0c0d0e50-0000-4000-8000-0000000000d1';
const BCAST = '0c0d0e50-0000-4000-8000-0000000000e1';
const PROF = '0c0d0e50-0000-4000-8000-0000000000f1';
const TPL = '0c0d0e50-0000-4000-8000-0000000000a2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('broadcast send gate (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const sendIt = () =>
    dispatch({ method: 'POST', path: `/broadcasts/${BCAST}/send`, authorization: tokenFor(OWNER, WS), query: {}, body: {} }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    // A manual segment with one member so the send resolves a real recipient.
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    await pool.query("INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'g-1','g1@example.com')", [
      PROF,
      WS,
    ]);
    await pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG, PROF, WS],
    );
    // The subject lives on the EMAIL (template), not the broadcast.
    await pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, subject, from_selected) VALUES ($1,$2,'T','<mjml/>','<html/>','Hello there',true)",
      [TPL, WS],
    );
    // The email needs a real From sender (no no-reply fallback) to be sendable.
    const snd = await pool.query<{ id: string }>(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'mail.x.test','T','t@mail.x.test') RETURNING id",
      [WS],
    );
    await pool.query('UPDATE email_templates SET sender_id = $2 WHERE id = $1', [TPL, snd.rows[0]!.id]);
    await pool.query(
      `INSERT INTO broadcasts (id, workspace_id, name, template_id, audience_kind, audience_ref, status)
       VALUES ($1,$2,'B',$3,'manual',$4,'draft')`,
      [BCAST, WS, TPL, SEG],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('refuses to send with NO verified sending domain (409), broadcast stays draft', async () => {
    const r = await sendIt();
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/verified sending domain/i);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM broadcasts WHERE id = $1', [BCAST]);
    expect(rows[0]!.status).toBe('draft'); // never claimed/queued
  });

  it('once a domain is verified, the send proceeds', async () => {
    await pool.query(
      "INSERT INTO sending_domains (workspace_id, domain, verified, verified_at) VALUES ($1,'mail.x.test',true,now())",
      [WS],
    );
    const r = await sendIt();
    expect(r.status).toBe(200);
    expect((r.body as { result: { result: string } }).result.result).toBe('sent');
  });
});
