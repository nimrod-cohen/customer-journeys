import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import { dispatchOutbox, type DispatchDeps, type Reader } from '../src/dispatch.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// REGRESSION (CLAUDE.md inv.7 + the per-domain sending model): the send-gate must
// treat a workspace as verified when it has a VERIFIED row in `sending_domains` —
// the current source of truth — NOT only the legacy `workspaces.sending_identity`
// jsonb (which the per-domain onboarding flow never populates). Without this a
// fully-verified workspace's broadcast was silently REFUSED (outbox → 'refused',
// no SES call), so the email never went out.
const RUN = hasDatabaseUrl();
const ws = 'd9000000-0000-0000-0000-0000000000a9';

class CountingSes implements SesEmailClient {
  public sends: SendEmailInput[] = [];
  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    this.sends.push(input);
    return { sesMessageId: `ses-${this.sends.length}` };
  }
  async createDomainIdentity() {
    return { identity: '', dkimTokens: [] };
  }
  async getIdentityVerificationAttributes() {
    return { dkimStatus: 'SUCCESS' as const, signingEnabled: true, dkimTokens: [] };
  }
  async createConfigurationSet() {
    /* no-op */
  }
  async provisionDedicatedIp() {
    /* no-op */
  }
}

describe.skipIf(!RUN)('dispatcher send-gate uses verified sending_domains (real Postgres)', () => {
  let admin: Pool;
  let profileId: string;
  let templateId: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    // NOTE: no sending_identity → it defaults to '{}' (the per-domain flow never
    // sets it). Verification lives entirely in sending_domains.
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    await admin.query(
      "INSERT INTO sending_domains (workspace_id, domain, verified) VALUES ($1,'mail.acme.com',true)",
      [ws],
    );
    const p = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'vd','vd@example.com') RETURNING id",
      [ws],
    );
    profileId = p.rows[0].id;
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html, subject) VALUES ($1,'t','<m/>','<html>Hi {{unsubscribe}}</html>','Hello') RETURNING id",
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
    await admin.query("UPDATE sending_domains SET verified = true WHERE workspace_id = $1", [ws]);
  });

  async function cleanup(): Promise<void> {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM sending_domains WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  function makeDeps(ses: CountingSes): DispatchDeps {
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    return {
      reader,
      ses,
      runInWorkspaceTx: (workspaceId, statements) => runStatementsInWorkspaceTx(admin, workspaceId, statements),
      now: () => new Date('2026-06-10T12:00:00.000Z'),
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
      linkTrackingBaseUrl: 'https://api.cdp.example',
    };
  }

  async function seedOutbox(dedupeKey: string): Promise<string> {
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, template_id, dedupe_key, status, payload) VALUES ($1,$2,$3,$4,'pending',$5::jsonb) RETURNING id",
      [ws, profileId, templateId, dedupeKey, JSON.stringify({})],
    );
    return o.rows[0].id;
  }

  it('a verified sending_domain (empty sending_identity) lets the send through', async () => {
    const ses = new CountingSes();
    const outboxId = await seedOutbox('dk-verified-domain');
    const out = await dispatchOutbox(makeDeps(ses), outboxId);

    expect(out.result).toBe('send');
    expect(ses.sends).toHaveLength(1);
    // From falls back to no-reply@<verified domain> (no named sender on the template).
    expect(ses.sends[0]!.from).toBe('no-reply@mail.acme.com');
    // {{unsubscribe}} rendered into this recipient's workspace-scoped PREFERENCE
    // CENTER link (manage your subscription — topics + channel groups + opt-out-all).
    expect(ses.sends[0]!.html).toContain('manage-subscription?workspace_id=');
    expect(ses.sends[0]!.html).toContain('email=vd%40example.com');
    const ob = await admin.query('SELECT status FROM outbox WHERE id = $1', [outboxId]);
    expect(ob.rows[0].status).toBe('sent');
  });

  it('with NO verified domain it is refused (gate still holds)', async () => {
    await admin.query('UPDATE sending_domains SET verified = false WHERE workspace_id = $1', [ws]);
    const ses = new CountingSes();
    const outboxId = await seedOutbox('dk-unverified');
    const out = await dispatchOutbox(makeDeps(ses), outboxId);

    expect(out.result).toBe('refuse');
    expect(ses.sends).toHaveLength(0);
    const ob = await admin.query('SELECT status FROM outbox WHERE id = $1', [outboxId]);
    expect(ob.rows[0].status).toBe('refused');
  });
});
