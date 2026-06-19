import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { WebhookHttpClient, WebhookRequest } from '@cdp/runner-webhook';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { CampaignDefinition } from '../src/dsl.js';

// §9B AC: a webhook action fires POST-COMMIT (mirrors enqueueSends) via the
// INJECTED client (never a real host); the outcome is recorded in activity_log
// (source='webhook') with the per-(campaign,profile,node) dedupe key; a failure /
// blocked target is ISOLATED (tick never crashes, enrollment continues).
const RUN = hasDatabaseUrl();
const WS = 'ca110000-0000-0000-0000-00000000dd01';
const CAMP = 'ca110000-0000-0000-0000-00000000dd02';
const PROF = 'ca110000-0000-0000-0000-00000000dd03';
const ALLOWED = 'hooks.example.com';

function def(url: string, maxRetries = 0): CampaignDefinition {
  return {
    startNode: 't',
    nodes: {
      t: { type: 'trigger', kind: 'manual', next: 'wh' },
      wh: {
        type: 'action',
        kind: 'webhook',
        url,
        method: 'POST',
        headers: { 'X-Auth': 'enc:SECRET', 'Content-Type': 'application/json' },
        bodyTemplate: '{"email":"{{customer.email}}","tier":"{{customer.tier}}"}',
        maxRetries,
        next: 'x',
      },
      x: { type: 'exit' },
    },
  };
}

const noopSqs = { async send() { return {}; } } as unknown as RunDeps['sqs'];

/** A recording fake HTTP client — returns a fixed status (or throws). Never a host. */
function fakeClient(opts: { status?: number; throwErr?: string }): WebhookHttpClient & { calls: WebhookRequest[] } {
  const calls: WebhookRequest[] = [];
  return {
    calls,
    async request(req: WebhookRequest): Promise<{ status: number }> {
      calls.push(req);
      if (opts.throwErr) throw new Error(opts.throwErr);
      return { status: opts.status ?? 200 };
    },
  };
}

describe.skipIf(!RUN)('webhook node executes in the tick (real Postgres, injected client)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, settings) VALUES ($1,'W','active',$2::jsonb)",
      [WS, JSON.stringify({ webhook_allowlist: [ALLOWED] })],
    );
    await admin.query(
      "INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,$3,$4::jsonb)",
      [PROF, WS, 'rec@e.test', JSON.stringify({ tier: 'gold' })],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  beforeEach(async () => {
    await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
  });

  async function seedCampaign(d: CampaignDefinition): Promise<void> {
    await admin.query(
      "INSERT INTO campaigns (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(d)],
    );
  }

  async function enroll(): Promise<string> {
    const r = await admin.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now()) RETURNING id",
      [WS, CAMP, PROF],
    );
    return r.rows[0].id as string;
  }

  function deps(client: WebhookHttpClient): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: noopSqs,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => new Date('2026-06-19T12:00:00.000Z'),
      dispatchQueueUrl: 'q',
      webhookClient: client,
      // Decrypt the X-Auth secret at call time only; never persisted.
      decryptSecret: (env: string) => (env === 'enc:SECRET' ? 'PLAINTEXT-TOKEN' : env),
      isEncryptedSecret: (v: string) => v.startsWith('enc:'),
    };
  }

  it('success: injected client called once with rendered body + decrypted header; advances; activity row records success', async () => {
    await seedCampaign(def(`https://${ALLOWED}/hook`));
    const id = await enroll();
    const client = fakeClient({ status: 200 });

    const r = await runEnrollment(deps(client), id);
    expect(r.result).toBe('completed');

    // Called exactly once with the merge-rendered body + decrypted header.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe('POST');
    expect(client.calls[0].url).toBe(`https://${ALLOWED}/hook`);
    expect(client.calls[0].body).toBe('{"email":"rec@e.test","tier":"gold"}');
    expect(client.calls[0].headers['X-Auth']).toBe('PLAINTEXT-TOKEN');

    // One activity_log row, success, scoped to ws+profile; detail/redacted (no secret).
    const act = await admin.query(
      "SELECT source, type, outcome, detail, profile_id, dedupe_key FROM activity_log WHERE workspace_id = $1 AND source = 'webhook'",
      [WS],
    );
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].source).toBe('webhook');
    expect(act.rows[0].type).toBe('webhook');
    expect(act.rows[0].outcome).toBe('success');
    expect(act.rows[0].profile_id).toBe(PROF);
    expect(act.rows[0].dedupe_key).toBe(`campaign:${CAMP}:${PROF}:wh`);
    expect(act.rows[0].detail).not.toContain('PLAINTEXT-TOKEN');
    expect(act.rows[0].detail).not.toContain('SECRET');
  });

  it('failure isolation: 500 with maxRetries=1 → client called twice, no throw, activity=failed, enrollment continues', async () => {
    await seedCampaign(def(`https://${ALLOWED}/hook`, 1));
    const id = await enroll();
    const client = fakeClient({ status: 500 });

    const r = await runEnrollment(deps(client), id);
    expect(r.result).toBe('completed'); // continue-on-failure: a webhook is not a gate
    expect(client.calls).toHaveLength(2); // 1 + 1 retry

    const act = await admin.query(
      "SELECT outcome, detail FROM activity_log WHERE workspace_id = $1 AND source = 'webhook'",
      [WS],
    );
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].outcome).toBe('failed');
    expect(act.rows[0].detail).toContain('500');
  });

  it('SSRF refusal: metadata target → client NEVER called, activity=blocked, no crash, advances', async () => {
    await seedCampaign(def('http://169.254.169.254/latest/meta-data'));
    const id = await enroll();
    const client = fakeClient({ status: 200 });

    const r = await runEnrollment(deps(client), id);
    expect(r.result).toBe('completed');
    expect(client.calls).toHaveLength(0); // refused BEFORE any call

    const act = await admin.query(
      "SELECT outcome FROM activity_log WHERE workspace_id = $1 AND source = 'webhook'",
      [WS],
    );
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].outcome).toBe('blocked');
  });

  it('off-allowlist host → refused without a call (deny-by-default)', async () => {
    await seedCampaign(def('https://api.evil.com/steal'));
    const id = await enroll();
    const client = fakeClient({ status: 200 });

    const r = await runEnrollment(deps(client), id);
    expect(r.result).toBe('completed');
    expect(client.calls).toHaveLength(0);
    const act = await admin.query(
      "SELECT outcome FROM activity_log WHERE workspace_id = $1 AND source = 'webhook'",
      [WS],
    );
    expect(act.rows[0].outcome).toBe('blocked');
  });

  it('idempotency: re-running the same already-advanced enrollment does NOT re-fire the webhook', async () => {
    await seedCampaign(def(`https://${ALLOWED}/hook`));
    const id = await enroll();
    const client = fakeClient({ status: 200 });

    const r1 = await runEnrollment(deps(client), id);
    expect(r1.result).toBe('completed');
    expect(client.calls).toHaveLength(1);

    // A second run: enrollment is no longer 'active' (completed) → skipped, no call.
    const r2 = await runEnrollment(deps(client), id);
    expect(r2.result).toBe('skipped');
    expect(client.calls).toHaveLength(1); // unchanged

    const act = await admin.query(
      "SELECT count(*)::int AS n FROM activity_log WHERE workspace_id = $1 AND source = 'webhook' AND dedupe_key = $2",
      [WS, `campaign:${CAMP}:${PROF}:wh`],
    );
    expect(act.rows[0].n).toBe(1); // exactly one webhook activity row
  });
});
