// The mail server is rebooting. What happens to the mail?
//
// This is the failure the retry machinery exists for, driven end to end against
// real Postgres: a transport that refuses connections, then recovers. The message
// must survive the outage, be sent once when the box comes back, and — if the box
// never comes back — end as a visible failure rather than a row nobody looks at.
//
// REAL Postgres because the whole mechanism IS the row's state transitions:
// pending → sending → pending(next_attempt_at) → sent, under a claim that must stay
// single-winner throughout.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { dispatchOutbox } from '../src/dispatch.js';
import { buildDueOutboxQuery, MAX_SEND_ATTEMPTS, retryDelayMs, type DispatchDeps } from '../src/index.js';
import type { SendEmailInput, SendEmailResult, SesEmailClient } from '@cdp/email';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0db022-0000-4000-8000-000000000c01';
const WS = '0c0db022-0000-4000-8000-000000000a01';
const PROFILE = '0c0db022-0000-4000-8000-0000000000f1';
const TPL = '0c0db022-0000-4000-8000-0000000000e1';
const OB = '0c0db022-0000-4000-8000-00000000ab01';

/** What nodemailer throws while the mail server is down. */
const connRefused = Object.assign(new Error('connect ECONNREFUSED 2.28.76.169:587'), { code: 'ECONNREFUSED' });
/** What it throws when the server refuses the recipient outright. */
const rejected = Object.assign(new Error('550 5.1.1 No such user'), { responseCode: 550 });

describeMaybe('a mail server outage delays sends, it does not lose them (real Postgres)', () => {
  let pool: Pool;
  let now = new Date('2026-08-31T12:00:00.000Z');
  let failWith: unknown = null;
  let sent = 0;

  const ses: SesEmailClient = {
    async sendEmail(_input: SendEmailInput): Promise<SendEmailResult> {
      if (failWith) throw failWith;
      sent++;
      return { sesMessageId: `ok-${sent}` };
    },
    createDomainIdentity: async () => ({ identity: 'x', dkimTokens: [] }),
    getIdentityVerificationAttributes: async () => ({ dkimStatus: 'SUCCESS', signingEnabled: true, dkimTokens: [] }),
    createConfigurationSet: async () => {},
    provisionDedicatedIp: async () => {},
  };

  const deps = (): DispatchDeps => ({
    reader: {
      query: async <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const r = await pool.query(text, values ? [...values] : undefined);
        return { rows: r.rows as T[] };
      },
    },
    ses,
    emailTrusted: true,
    runInWorkspaceTx: async (workspaceId, statements) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const st of statements) {
          if (st.values[0] !== workspaceId) throw new Error('statement not workspace-scoped');
          await c.query(st.text, [...st.values]);
        }
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    now: () => now,
    unsubscribeBaseUrl: 'https://x/unsubscribe',
    linkTrackingBaseUrl: 'https://x',
  });

  const row = async () =>
    (
      await pool.query<{ status: string; attempts: number; next_attempt_at: string | null }>(
        'SELECT status, attempts, next_attempt_at FROM outbox WHERE id = $1',
        [OB],
      )
    ).rows[0]!;

  /** Is this row offered to the sweep at time `t`? */
  const isDue = async (t: Date): Promise<boolean> => {
    const q = buildDueOutboxQuery(t);
    const { rows } = await pool.query<{ id: string }>(q.text, q.values);
    return rows.some((r) => r.id === OB);
  };

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM usage_counters WHERE workspace_id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]).catch(() => {});
  }

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Outage')", [CO]);
    await pool.query(
      `INSERT INTO workspaces (id, company_id, name, status, sending_identity)
       VALUES ($1,$2,'W','active','{"verified":true,"from_domain":"acme.com"}'::jsonb)`,
      [WS, CO],
    );
    await pool.query("INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,'person@example.com')", [PROFILE, WS]);
    await pool.query(
      `INSERT INTO email_templates (id, workspace_id, name, kind, mjml, subject, to_address, compiled_html)
       VALUES ($1,$2,'T','library','<mjml/>','Hi','{{customer.email}}','<p>Hi</p>')`,
      [TPL, WS],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  beforeEach(async () => {
    now = new Date('2026-08-31T12:00:00.000Z');
    failWith = null;
    sent = 0;
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query(
      `INSERT INTO outbox (id, workspace_id, profile_id, template_id, status, payload)
       VALUES ($1,$2,$3,$4,'pending','{"medium":"email"}'::jsonb)`,
      [OB, WS, PROFILE, TPL],
    );
  });

  it('holds the message and retries later while the server refuses connections', async () => {
    failWith = connRefused;
    const r = await dispatchOutbox(deps(), OB);
    expect(r.result).toBe('retryable-failure');

    const after = await row();
    expect(after.status).toBe('pending'); // NOT failed — the message still stands
    expect(after.attempts).toBe(1);
    expect(new Date(after.next_attempt_at!).getTime()).toBe(now.getTime() + retryDelayMs(1));

    // Not offered again until the backoff elapses — an instant retry would spend the
    // whole budget inside the reboot window.
    expect(await isDue(new Date(now.getTime() + 30_000))).toBe(false);
    expect(await isDue(new Date(now.getTime() + retryDelayMs(1)))).toBe(true);

    // Nothing is recorded as sent or failed while it is merely waiting.
    const { rows: logs } = await pool.query('SELECT 1 FROM messages_log WHERE workspace_id = $1', [WS]);
    expect(logs).toHaveLength(0);
  });

  it('sends it exactly once when the server comes back', async () => {
    failWith = connRefused;
    await dispatchOutbox(deps(), OB); // outage
    await dispatchOutbox(deps(), OB); // still down
    expect((await row()).attempts).toBe(2);

    failWith = null; // the box is back
    now = new Date(now.getTime() + retryDelayMs(2));
    const r = await dispatchOutbox(deps(), OB);
    expect(r.result).toBe('send');
    expect(sent).toBe(1);

    const after = await row();
    expect(after.status).toBe('sent');
    const { rows: logs } = await pool.query<{ status: string }>(
      'SELECT status FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(logs.map((l) => l.status)).toEqual(['sent']); // one send, not three
  });

  // The backoff grows, so an outage lasting hours is still ridden out.
  it('backs off further with each failure', async () => {
    failWith = connRefused;
    for (const attempt of [1, 2, 3]) {
      const at = now;
      await dispatchOutbox(deps(), OB);
      const r = await row();
      expect(r.attempts).toBe(attempt);
      expect(new Date(r.next_attempt_at!).getTime()).toBe(at.getTime() + retryDelayMs(attempt));
      now = new Date(at.getTime() + retryDelayMs(attempt));
    }
  });

  // A refusal is not an outage: retrying cannot help, and the reason must be visible.
  it('does not retry a 5xx rejection — it records the failure', async () => {
    failWith = rejected;
    const r = await dispatchOutbox(deps(), OB);
    expect(r.result).toBe('failure');

    expect((await row()).status).toBe('failed');
    const { rows: logs } = await pool.query<{ status: string; reason: string }>(
      'SELECT status, reason FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(logs[0]!.status).toBe('failed');
    expect(logs[0]!.reason).toMatch(/No such user/);
  });

  // Retrying forever would leave a recipient silently un-mailed, with nothing in the
  // UI to explain it. The budget ends in a visible failure instead.
  it('gives up after the attempt budget, recording why', async () => {
    failWith = connRefused;
    await pool.query('UPDATE outbox SET attempts = $2 WHERE id = $1', [OB, MAX_SEND_ATTEMPTS - 1]);

    const r = await dispatchOutbox(deps(), OB);
    expect(r.result).toBe('failure');
    expect((await row()).status).toBe('failed');

    const { rows: logs } = await pool.query<{ reason: string }>(
      'SELECT reason FROM messages_log WHERE workspace_id = $1',
      [WS],
    );
    expect(logs[0]!.reason).toMatch(/gave up after \d+ attempts.*ECONNREFUSED/);
    expect(await isDue(new Date(now.getTime() + 86_400_000))).toBe(false); // never again
  });

  // A worker killed mid-send leaves the row claimed. Nothing else recovers it.
  it('reclaims a row abandoned in sending', async () => {
    await pool.query("UPDATE outbox SET status = 'sending', created_at = now() - interval '1 hour' WHERE id = $1", [OB]);
    expect(await isDue(new Date())).toBe(true);
  });
});
