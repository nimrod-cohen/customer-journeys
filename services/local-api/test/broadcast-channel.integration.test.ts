// MULTI-CHANNEL broadcasts (CLAUDE.md): an sms/whatsapp broadcast sends to the
// recipient PHONE via the MOCK channel provider — NO envelope, NO verified-domain
// gate (those are email-only). The ONLY gate is a non-blank text_body (409 "Add a
// message body…" when blank). Unlike email (which needs real SES creds locally),
// the text channels ALWAYS deliver locally via the deterministic mock, so this
// exercises the FULL local path: send → outbox → dispatchBroadcastNow(mock) →
// messages_log(medium, provider id), skipping a recipient with no phone. Email's
// own gating is asserted unchanged. Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ec0-0000-4000-8000-000000000a01';
const WS_B = '0c0d0ec0-0000-4000-8000-000000000a02';
const OWNER = '0c0d0ec0-0000-4000-8000-0000000000b1';
const SEG = '0c0d0ec0-0000-4000-8000-0000000000d1';
const P_PHONE = '0c0d0ec0-0000-4000-8000-0000000000f1';
const P_NOPHONE = '0c0d0ec0-0000-4000-8000-0000000000f2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('multi-channel broadcasts (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const ownerTok = () => tokenFor(OWNER, WS);

  const createBc = (body: Record<string, unknown>) =>
    dispatch({ method: 'POST', path: '/broadcasts', authorization: ownerTok(), query: {}, body }, e());
  const sendBc = (id: string) =>
    dispatch({ method: 'POST', path: `/broadcasts/${id}/send`, authorization: ownerTok(), query: {}, body: {} }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const w of [WS, WS_B]) {
      await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    // One recipient WITH a phone (attributes.phone) + first_name; one WITHOUT.
    await pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'ph','ph@example.com',$3::jsonb)",
      [P_PHONE, WS, JSON.stringify({ phone: '+15557654321', first_name: 'Sam' })],
    );
    await pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'nph','nph@example.com',$3::jsonb)",
      [P_NOPHONE, WS, JSON.stringify({ first_name: 'Nora' })],
    );
    for (const p of [P_PHONE, P_NOPHONE]) {
      await pool.query(
        "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
        [SEG, p, WS],
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
    for (const w of [WS, WS_B]) {
      await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM usage_counters WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  it('SMS broadcast with a BLANK body → 409 "Add a message body…"; stays draft', async () => {
    const c = await createBc({ name: 'SMS', medium: 'sms', text_body: '   ', audience_kind: 'manual', audience_ref: SEG });
    expect(c.status).toBe(201);
    const id = (c.body as { broadcast: { id: string; medium: string } }).broadcast.id;
    expect((c.body as { broadcast: { medium: string } }).broadcast.medium).toBe('sms');
    const r = await sendBc(id);
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/message body/i);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM broadcasts WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('draft');
  });

  it('SMS broadcast with a body sends via the MOCK provider (no domain), recording messages_log(medium=sms)', async () => {
    const c = await createBc({
      name: 'SMS go',
      medium: 'sms',
      text_body: 'Hi {{customer.first_name}}!',
      audience_kind: 'manual',
      audience_ref: SEG,
    });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    // No verified sending domain exists for WS — text must NOT require one.
    const r = await sendBc(id);
    expect(r.status).toBe(200);
    expect((r.body as { result: { result: string } }).result.result).toBe('sent');

    // messages_log: one SENT row (medium=sms, mock provider id) for the phone
    // recipient + one SKIPPED row for the no-phone recipient. Workspace-scoped.
    const ml = await pool.query<{ medium: string; status: string; ses_message_id: string | null }>(
      'SELECT medium, status, ses_message_id FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(ml.rows).toHaveLength(2);
    const sent = ml.rows.find((x) => x.status === 'sent')!;
    const skipped = ml.rows.find((x) => x.status === 'skipped')!;
    expect(sent.medium).toBe('sms');
    expect(sent.ses_message_id).toMatch(/^mock-sms-/);
    expect(skipped.medium).toBe('sms');
    expect(skipped.ses_message_id).toBeNull();

    // Idempotent: re-send is a no-op (already sent), no new messages_log rows.
    await sendBc(id); // broadcast already 'sent' → runBroadcast skips; dispatch finds nothing pending
    const ml2 = await pool.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [WS]);
    expect(ml2.rows[0].n).toBe(2);
  });

  it('WhatsApp broadcast records messages_log(medium=whatsapp) via the mock', async () => {
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    const c = await createBc({
      name: 'WA go',
      medium: 'whatsapp',
      text_body: 'Hello {{customer.first_name}}',
      audience_kind: 'manual',
      audience_ref: SEG,
    });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await sendBc(id);
    expect(r.status).toBe(200);
    const ml = await pool.query<{ medium: string; ses_message_id: string }>(
      "SELECT medium, ses_message_id FROM messages_log WHERE workspace_id = $1 AND status = 'sent'",
      [WS],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0].medium).toBe('whatsapp');
    expect(ml.rows[0].ses_message_id).toMatch(/^mock-wa-/);
  });

  it('EMAIL broadcast is UNCHANGED: still gated on a verified sending domain (409 without one)', async () => {
    // An email broadcast with an envelope-complete template but no verified domain
    // must still be refused — the email path/gates are intact.
    const tpl = await pool.query<{ id: string }>(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, subject, to_address) VALUES ($1,'T','<mjml/>','<html/>','Hi','{{customer.email}}') RETURNING id",
      [WS],
    );
    const snd = await pool.query<{ id: string }>(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'mail.x.test','T','t@mail.x.test') RETURNING id",
      [WS],
    );
    await pool.query('UPDATE email_templates SET sender_id = $2 WHERE id = $1', [tpl.rows[0]!.id, snd.rows[0]!.id]);
    const c = await createBc({
      name: 'Email',
      medium: 'email',
      template_id: tpl.rows[0]!.id,
      audience_kind: 'manual',
      audience_ref: SEG,
    });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await sendBc(id);
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/verified sending domain/i);
  });

  it('tenant isolation: sending a broadcast from another workspace 404s (workspace_id never from the body)', async () => {
    const other = await pool.query<{ id: string }>(
      "INSERT INTO broadcasts (workspace_id, name, medium, text_body, audience_kind, audience_ref, status) VALUES ($1,'X','sms','hi','manual',$2,'draft') RETURNING id",
      [WS_B, SEG],
    );
    const r = await sendBc(other.rows[0]!.id); // owner's token is for WS, not WS_B
    expect(r.status).toBe(404);
  });
});
