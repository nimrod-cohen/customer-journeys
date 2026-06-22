import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import { verifyUnsubscribeToken } from '@cdp/email';
import { dispatchOutbox, type DispatchDeps, type Reader } from '../src/dispatch.js';
import { runStatementsInWorkspaceTx } from '../src/deps.js';

// Open tracking + unsubscribe attribution (§10): when link_tracking is ON for a
// workspace, the dispatcher (1) injects a 1x1 /o/<token> open pixel and
// pre-creates a workspace-scoped tracked_opens row attributed to the recipient,
// and (2) builds an unsubscribe link carrying the source broadcast_id. With
// link_tracking OFF, NO pixel and NO tracked_opens row. Real Postgres; SES mocked.
const RUN = hasDatabaseUrl();

const ws = 'da000000-0000-0000-0000-0000000000aa';
const BCAST = 'da000000-0000-0000-0000-0000000000ba';
const LINK_SECRET = 'dispatch-link-secret';

class CapturingSes implements SesEmailClient {
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
  async createConfigurationSet() {}
  async provisionDedicatedIp() {}
}

describe.skipIf(!RUN)('dispatcher open pixel + unsubscribe attribution (real Postgres)', () => {
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
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'opx','opx@example.com') RETURNING id",
      [ws],
    );
    profileId = p.rows[0].id;
    await admin.query(
      "INSERT INTO broadcasts (id, workspace_id, name, audience_kind, audience_ref, status) VALUES ($1,$2,'B','manual',$1,'sending')",
      [BCAST, ws],
    );
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>',$2) RETURNING id",
      [ws, '<html><body><p>Hi <a href="https://acme.com/sale">Sale</a></p></body></html>'],
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
    await admin.query('DELETE FROM tracked_opens WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM tracked_links WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
  });

  async function cleanup(): Promise<void> {
    await admin.query('DELETE FROM tracked_opens WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM tracked_links WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  function makeDeps(ses: CapturingSes): DispatchDeps {
    const reader: Reader = { query: (text, values) => admin.query(text, values as unknown[]) as never };
    return {
      reader,
      ses,
      runInWorkspaceTx: (wsId, statements) => runStatementsInWorkspaceTx(admin, wsId, statements),
      now: () => new Date('2026-06-10T12:00:00.000Z'),
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
      linkTrackingBaseUrl: 'https://api.cdp.example',
      unsubscribeLinkSecret: LINK_SECRET,
    };
  }

  async function setLinkTracking(on: boolean): Promise<void> {
    await admin.query("UPDATE workspaces SET settings = $2::jsonb WHERE id = $1", [
      ws,
      JSON.stringify(on ? { link_tracking: true } : {}),
    ]);
  }

  async function seedOutbox(): Promise<string> {
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, template_id, status, payload) VALUES ($1,$2,$3,'pending',$4::jsonb) RETURNING id",
      [ws, profileId, templateId, JSON.stringify({ broadcast_id: BCAST })],
    );
    return o.rows[0].id;
  }

  it('with link_tracking ON: injects the /o/ pixel + carries broadcast_id on the unsubscribe link + pre-creates a tracked_opens row', async () => {
    await setLinkTracking(true);
    const ses = new CapturingSes();
    const out = await dispatchOutbox(makeDeps(ses), await seedOutbox());
    expect(out.result).toBe('send');
    const html = ses.sends[0]!.html;
    // 1x1 open pixel present, pointing at /o/<token>.
    expect(html).toMatch(/https:\/\/api\.cdp\.example\/o\/[a-f0-9]{24}/);
    expect(html).toContain('width="1"');
    // The List-Unsubscribe header URL carries the source broadcast id.
    expect(ses.sends[0]!.headers!['List-Unsubscribe']).toContain(`broadcast_id=${BCAST}`);

    // The body {{unsubscribe}} link AND the List-Unsubscribe header carry a VALID
    // signed token over (workspace_id, email) — verifiable with the same secret.
    const header = ses.sends[0]!.headers!['List-Unsubscribe'];
    const headerUrl = new URL(header.slice(1, -1)); // strip <>
    const headerTok = headerUrl.searchParams.get('token');
    expect(headerTok).toBeTruthy();
    expect(verifyUnsubscribeToken(LINK_SECRET, ws, 'opx@example.com', headerTok)).toBe(true);
    // The header points at /unsubscribe (RFC 8058 one-click) carrying the token.
    expect(headerUrl.pathname).toBe('/unsubscribe');

    // A tracked_opens row was pre-created for this recipient, workspace-scoped,
    // attributed to the broadcast + profile, opens=0.
    const o = await admin.query<{ broadcast_id: string; profile_id: string; opens: number }>(
      'SELECT broadcast_id, profile_id, opens FROM tracked_opens WHERE workspace_id = $1',
      [ws],
    );
    expect(o.rows).toHaveLength(1);
    expect(o.rows[0]!.broadcast_id).toBe(BCAST);
    expect(o.rows[0]!.profile_id).toBe(profileId);
    expect(o.rows[0]!.opens).toBe(0);
  });

  it('the body {{unsubscribe}} link points at /manage-subscription and carries a VALID token', async () => {
    await setLinkTracking(false);
    // A template that uses the {{unsubscribe}} body token.
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'tu','<m/>',$2) RETURNING id",
      [ws, '<html><body><p>Bye {{unsubscribe}}</p></body></html>'],
    );
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, template_id, status, payload) VALUES ($1,$2,$3,'pending',$4::jsonb) RETURNING id",
      [ws, profileId, t.rows[0].id, JSON.stringify({ broadcast_id: BCAST })],
    );
    const ses = new CapturingSes();
    const out = await dispatchOutbox(makeDeps(ses), o.rows[0].id);
    expect(out.result).toBe('send');
    const html = ses.sends[0]!.html;
    const m = html.match(/href="(https:\/\/api\.cdp\.example\/manage-subscription[^"]*)"/);
    expect(m).toBeTruthy();
    const url = new URL(m![1]!.replace(/&amp;/g, '&'));
    expect(url.pathname).toBe('/manage-subscription');
    expect(verifyUnsubscribeToken(LINK_SECRET, ws, 'opx@example.com', url.searchParams.get('token'))).toBe(true);
  });

  it('with link_tracking OFF: NO open pixel, NO tracked_opens row (opt-in respected)', async () => {
    await setLinkTracking(false);
    const ses = new CapturingSes();
    const out = await dispatchOutbox(makeDeps(ses), await seedOutbox());
    expect(out.result).toBe('send');
    expect(ses.sends[0]!.html).not.toContain('/o/');
    const o = await admin.query('SELECT count(*)::int n FROM tracked_opens WHERE workspace_id = $1', [ws]);
    expect(o.rows[0].n).toBe(0);
  });

  it('a replay reuses the same per-recipient open token (one tracked_opens row)', async () => {
    await setLinkTracking(true);
    const ses = new CapturingSes();
    const deps = makeDeps(ses);
    const id = await seedOutbox();
    await dispatchOutbox(deps, id);
    await dispatchOutbox(deps, id); // noop (already sent) — no second row
    const o = await admin.query('SELECT count(*)::int n FROM tracked_opens WHERE workspace_id = $1', [ws]);
    expect(o.rows[0].n).toBe(1);
  });
});
