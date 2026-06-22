// Send-result VISIBILITY + recipient ADDRESSING (v0.63.0) — real Postgres.
// Proves the new messages_log.reason + phone-normalization + missing-address skip
// behavior end-to-end through the LOCAL broadcast send path (send → outbox → the
// REAL Dispatcher → messages_log). SES is never reached (text channels use the
// deterministic mock / an injected 019 fake); the DB is real (never mocked).
//
// Asserts:
//  - an SMS recipient with NO phone → messages_log status='skipped', medium='sms',
//    reason='recipient has no phone' (never sent, never crashes the batch);
//  - an SMS recipient with an INVALID phone → reason='invalid phone number';
//  - a NATIONAL phone + the company default_country → the 019 adapter receives the
//    NORMALIZED E.164 number (inject a fake ChannelHttpClient, assert the payload);
//  - an EMAIL recipient with an empty resolved To → skipped, reason='recipient has
//    no email address' (NOT a throw / retry);
//  - listActivity surfaces type=<medium> + detail=<reason> for these rows;
//  - the channel-config CRUD round-trips default_country.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import type { ChannelHttpClient, ChannelHttpResponse } from '@cdp/channels';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import { dispatchOutbox, runStatementsInWorkspaceTx as dispatcherTx, type DispatchDeps } from '@cdp/service-dispatcher';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

// Unused prefix (grep'd 0c0d0e**): 0c0d0ec1.
const CO = '0c0d0ec1-0000-4000-8000-0000000000c1';
const WS = '0c0d0ec1-0000-4000-8000-000000000a01';
const OWNER = '0c0d0ec1-0000-4000-8000-0000000000b1';
const SEG = '0c0d0ec1-0000-4000-8000-0000000000d1';
const P_NOPHONE = '0c0d0ec1-0000-4000-8000-0000000000f1';
const P_BADPHONE = '0c0d0ec1-0000-4000-8000-0000000000f2';
const P_NATIONAL = '0c0d0ec1-0000-4000-8000-0000000000f3';
const P_NOEMAIL = '0c0d0ec1-0000-4000-8000-0000000000f4';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

/** A fake ChannelHttpClient that records every POST and returns a canned 019 OK. */
function makeCapturingHttp(): {
  http: ChannelHttpClient;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const http: ChannelHttpClient = {
    async post(url, headers, body): Promise<ChannelHttpResponse> {
      calls.push({ url, headers, body });
      return { status: 200, body: JSON.stringify({ status: 0, message_id: '019-OK-1' }) };
    },
  };
  return { http, calls };
}

describeMaybe('send reasons + phone normalization + missing address (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const tok = () => tokenFor(OWNER, WS);
  const createBc = (body: Record<string, unknown>, env: DispatchEnv = e()) =>
    dispatch({ method: 'POST', path: '/broadcasts', authorization: tok(), query: {}, body }, env);
  const sendBc = (id: string, env: DispatchEnv = e()) =>
    dispatch({ method: 'POST', path: `/broadcasts/${id}/send`, authorization: tok(), query: {}, body: {} }, env);
  const putCfg = (body: unknown) =>
    dispatch({ method: 'PUT', path: '/company/channel-config', authorization: tok(), query: {}, body }, e());
  const getCfg = () =>
    dispatch({ method: 'GET', path: '/company/channel-config', authorization: tok(), query: {}, body: {} }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    // Profiles covering each address case. The national number (0529461566, leading
    // 0) needs the company default_country='IL' to normalize → +972529461566.
    const profiles: Array<[string, string, Record<string, unknown>]> = [
      [P_NOPHONE, 'nophone@example.com', { first_name: 'Noa' }],
      [P_BADPHONE, 'badphone@example.com', { first_name: 'Bad', phone: 'not-a-number' }],
      [P_NATIONAL, 'national@example.com', { first_name: 'Nat', phone: '0529461566' }],
    ];
    for (const [id, email, attrs] of profiles) {
      await pool.query(
        'INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [id, WS, email, email, JSON.stringify(attrs)],
      );
    }
    // An email profile with NO email (empty string) — its resolved To is empty.
    await pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'noemail','',$3::jsonb)",
      [P_NOEMAIL, WS, JSON.stringify({ first_name: 'Ned' })],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM company_channel_config WHERE company_id = $1', [CO]);
  });

  async function member(profileId: string): Promise<void> {
    await pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG, profileId, WS],
    );
  }

  async function cleanup(): Promise<void> {
    for (const t of [
      'messages_log',
      'usage_counters',
      'outbox',
      'broadcasts',
      'segment_memberships',
      'segments',
      'email_templates',
      'domain_senders',
      'sending_domains',
      'profiles',
      'workspace_users',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]);
    }
    await pool.query('DELETE FROM company_channel_config WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('SMS to a recipient with NO phone → skipped, reason="recipient has no phone"', async () => {
    await member(P_NOPHONE);
    const c = await createBc({ name: 'no-phone', medium: 'sms', text_body: 'Hi', audience_kind: 'manual', audience_ref: SEG });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    expect((await sendBc(id)).status).toBe(200);
    const { rows } = await pool.query<{ status: string; medium: string; reason: string | null }>(
      'SELECT status, medium, reason FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', medium: 'sms', reason: 'recipient has no phone' });
  });

  it('SMS to a recipient with an INVALID phone → skipped, reason="invalid phone number"', async () => {
    await member(P_BADPHONE);
    const c = await createBc({ name: 'bad-phone', medium: 'sms', text_body: 'Hi', audience_kind: 'manual', audience_ref: SEG });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    expect((await sendBc(id)).status).toBe(200);
    const { rows } = await pool.query<{ status: string; medium: string; reason: string | null }>(
      'SELECT status, medium, reason FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', medium: 'sms', reason: 'invalid phone number' });
  });

  it('a NATIONAL phone + company default_country IL → the 019 adapter receives the E.164 number', async () => {
    // Configure a real 019 gateway with default_country=IL so the national number
    // 0529461566 normalizes to +972529461566 before the provider call.
    expect((await putCfg({ api_url: 'https://019.test/api', username: 'u', source: 'Brand', secret: 'b', default_country: 'IL' })).status).toBe(200);
    await member(P_NATIONAL);

    const { http, calls } = makeCapturingHttp();
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) };
    const c = await createBc({ name: 'national', medium: 'sms', text_body: 'Hi {{customer.first_name}}', audience_kind: 'manual', audience_ref: SEG }, env);
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    expect((await sendBc(id, env)).status).toBe(200);

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]!.body) as { sms: { destinations: { phone: string } } };
    expect(payload.sms.destinations.phone).toBe('+972529461566'); // NORMALIZED to E.164

    const { rows } = await pool.query<{ status: string; reason: string | null; ses_message_id: string | null }>(
      'SELECT status, reason, ses_message_id FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', reason: null, ses_message_id: '019-OK-1' });
  });

  it('EMAIL to a recipient with an empty To → skipped, reason="recipient has no email address" (no throw)', async () => {
    await member(P_NOEMAIL);
    const tpl = await pool.query<{ id: string }>(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, subject, to_address) VALUES ($1,'T','<mjml/>','<html><body>Hi</body></html>','Hi','{{customer.email}}') RETURNING id",
      [WS],
    );
    const snd = await pool.query<{ id: string }>(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'mail.x.test','T','t@mail.x.test') RETURNING id",
      [WS],
    );
    await pool.query("INSERT INTO sending_domains (workspace_id, domain, verified) VALUES ($1,'mail.x.test',true)", [WS]);
    await pool.query('UPDATE email_templates SET sender_id = $2 WHERE id = $1', [tpl.rows[0]!.id, snd.rows[0]!.id]);
    const c = await createBc({ name: 'no-email', medium: 'email', template_id: tpl.rows[0]!.id, audience_kind: 'manual', audience_ref: SEG });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    // The local broadcast path does NOT dispatch EMAIL without real SES creds, so
    // drive the REAL Dispatcher directly against the queued outbox row (SES MOCKED
    // — it must NEVER be called for a no-email recipient, which is skipped first).
    const r = await sendBc(id);
    expect(r.status).toBe(200);
    const ob = await pool.query<{ id: string }>(
      "SELECT id FROM outbox WHERE workspace_id = $1 AND status = 'pending'",
      [WS],
    );
    expect(ob.rows).toHaveLength(1);
    let sesCalls = 0;
    const ses: SesEmailClient = {
      async sendEmail(_input: SendEmailInput): Promise<SendEmailResult> {
        sesCalls++;
        return { sesMessageId: 'should-not-be-called' };
      },
    };
    const deps: DispatchDeps = {
      reader: { query: (text, values) => pool.query(text, values as unknown[]) },
      ses,
      runInWorkspaceTx: (wsId, statements) => dispatcherTx(pool, wsId, statements),
      now: () => new Date('2026-06-22T12:00:00Z'),
      unsubscribeBaseUrl: 'https://x/unsubscribe',
      linkTrackingBaseUrl: 'https://x',
    };
    const outcome = await dispatchOutbox(deps, ob.rows[0]!.id);
    expect(outcome.result).toBe('skip');
    expect((outcome as { reason: string }).reason).toBe('recipient has no email address');
    expect(sesCalls).toBe(0); // SES is never reached — the no-email recipient is skipped first
    const { rows } = await pool.query<{ status: string; medium: string; reason: string | null }>(
      'SELECT status, medium, reason FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', medium: 'email', reason: 'recipient has no email address' });
  });

  it('listActivity surfaces type=<medium> + detail=<reason> for a skipped send', async () => {
    await member(P_NOPHONE);
    const c = await createBc({ name: 'activity', medium: 'sms', text_body: 'Hi', audience_kind: 'manual', audience_ref: SEG });
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    await sendBc(id);
    const r = await dispatch({ method: 'GET', path: '/activity', authorization: tok(), query: { source: 'send' }, body: {} }, e());
    expect(r.status).toBe(200);
    const rows = (r.body as { activity: Array<{ source: string; type: string; outcome: string; detail: string }> }).activity;
    const sms = rows.find((x) => x.source === 'send');
    expect(sms).toBeDefined();
    expect(sms!.type).toBe('sms'); // the MEDIUM, not the literal 'send'
    expect(sms!.detail).toBe('recipient has no phone'); // the REASON, not just 'skipped'
    expect(sms!.outcome).toBe('failure'); // a non-delivery stays clearly visible
  });

  it('channel-config CRUD round-trips default_country', async () => {
    expect((await putCfg({ api_url: 'https://019.test/api', username: 'u', source: 'Brand', secret: 'b', default_country: 'il' })).status).toBe(200);
    expect((await getCfg()).body).toMatchObject({ configured: true, default_country: 'IL' });
    // Clearing it (empty) round-trips to null.
    expect((await putCfg({ api_url: 'https://019.test/api', username: 'u', source: 'Brand', default_country: '' })).status).toBe(200);
    expect((await getCfg()).body).toMatchObject({ configured: true, default_country: null });
    // A non-2-letter code is rejected.
    expect((await putCfg({ api_url: 'https://019.test/api', username: 'u', source: 'Brand', default_country: 'ISR' })).status).toBe(400);
  });
});
