import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import { dispatchOutbox, type DispatchDeps, type Reader } from '../src/dispatch.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// CRITICAL invariant: dedupe / idempotency. The atomic outbox claim
// (UPDATE ... WHERE status='pending' RETURNING) means retries AND concurrent
// invocations send EXACTLY ONCE. Real Postgres (the atomicity lives in the DB);
// SES is a counting fake (never real mail). Also proves the all-pass send writes
// messages_log + usage_counters and marks the outbox row sent — in one tx.
const RUN = hasDatabaseUrl();

const ws = 'd8000000-0000-0000-0000-0000000000a8';

/** A counting fake SES client — records every sendEmail call. */
class CountingSes implements SesEmailClient {
  public sends: SendEmailInput[] = [];
  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { sesMessageId: `ses-${this.sends.length}` };
  }
  // Unused by the dispatcher path:
  async createDomainIdentity() {
    return { identity: '', dkimTokens: [] };
  }
  async getIdentityVerificationAttributes() {
    return { dkimStatus: 'SUCCESS' as const, signingEnabled: true, dkimTokens: [] };
  }
  async createConfigurationSet() {
    /* no-op */
  }
}

describe.skipIf(!RUN)('dispatcher dedupe / idempotency (real Postgres)', () => {
  let admin: Pool;
  let profileId: string;
  let templateId: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [ws, JSON.stringify({ verified: true, from_domain: 'mail.acme.com', config_set: 'cs' })],
    );
    const p = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'dd','dd@example.com') RETURNING id",
      [ws],
    );
    profileId = p.rows[0].id;
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html>Hi {{first_name}}</html>') RETURNING id",
      [ws],
    );
    templateId = t.rows[0].id;
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
  });

  async function cleanup(): Promise<void> {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  function makeDeps(ses: CountingSes): DispatchDeps {
    const reader: Reader = {
      query: (text, values) => admin.query(text, values as unknown[]) as never,
    };
    return {
      reader,
      ses,
      runInWorkspaceTx: (workspaceId, statements) =>
        runStatementsInWorkspaceTx(admin, workspaceId, statements),
      now: () => new Date('2026-06-10T12:00:00.000Z'),
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    };
  }

  async function seedOutbox(dedupeKey: string): Promise<string> {
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, template_id, dedupe_key, status, payload) VALUES ($1,$2,$3,$4,'pending',$5::jsonb) RETURNING id",
      [ws, profileId, templateId, dedupeKey, JSON.stringify({ subject: 'Hi', merge: { first_name: 'Ada' } })],
    );
    return o.rows[0].id;
  }

  it('a single dispatch sends once and writes messages_log + usage + marks sent', async () => {
    const ses = new CountingSes();
    const deps = makeDeps(ses);
    const outboxId = await seedOutbox('dk-single');

    const out = await dispatchOutbox(deps, outboxId);
    expect(out.result).toBe('send');
    expect(ses.sends).toHaveLength(1);
    // The rendered body used the compiled template + merge value.
    expect(ses.sends[0]!.html).toBe('<html>Hi Ada</html>');
    expect(ses.sends[0]!.configurationSetName).toBe('cs');

    const ml = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    const uc = await admin.query(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric='emails_sent'",
      [ws],
    );
    const ob = await admin.query('SELECT status, sent_at FROM outbox WHERE id = $1', [outboxId]);
    expect(ml.rows[0].n).toBe(1);
    expect(Number(uc.rows[0].value)).toBe(1);
    expect(ob.rows[0].status).toBe('sent');
    expect(ob.rows[0].sent_at).not.toBeNull();
  });

  it('a replayed dispatch of the same outbox id is a noop (sends once)', async () => {
    const ses = new CountingSes();
    const deps = makeDeps(ses);
    const outboxId = await seedOutbox('dk-replay');

    const first = await dispatchOutbox(deps, outboxId);
    const second = await dispatchOutbox(deps, outboxId);
    expect(first.result).toBe('send');
    expect(second.result).toBe('noop');
    expect(ses.sends).toHaveLength(1);

    const ml = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    expect(ml.rows[0].n).toBe(1);
  });

  it('concurrent dispatches of the same id send EXACTLY once (atomic claim)', async () => {
    const ses = new CountingSes();
    const deps = makeDeps(ses);
    const outboxId = await seedOutbox('dk-concurrent');

    const results = await Promise.all([
      dispatchOutbox(deps, outboxId),
      dispatchOutbox(deps, outboxId),
      dispatchOutbox(deps, outboxId),
    ]);
    const sends = results.filter((r) => r.result === 'send');
    expect(sends).toHaveLength(1);
    expect(ses.sends).toHaveLength(1);

    const ml = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    expect(ml.rows[0].n).toBe(1);
  });
});
