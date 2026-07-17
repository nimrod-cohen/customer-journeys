// Cross-phase automation-journey integration (§9B, §9, §16A, §18).
//
// Proves phase 10 works TOGETHER with the dispatcher (phase 7) against a REAL
// local Postgres, driving the ACTUAL production cores in sequence (no
// re-implementation):
//   segment entry (segment_change_log 'entered')
//     -> enrollFromSegmentChange (automation enrollment, 'once')
//     -> runEnrollment tick 1: trigger -> wait -> PARK (next_run_at)
//     -> the REAL sweep query honors next_run_at (deferral)
//     -> runEnrollment tick 2 (after the wait): condition -> action(send) -> exit
//     -> the enqueued {outbox_id} is dispatched by the REAL dispatchOutbox
//        (gate -> suppression -> cap -> quiet-hours -> SES), SES mocked.
//
// Every service runs as the SERVICE ROLE (bypasses RLS) so isolation is proven
// IN CODE (workspace_id bound at $1) — we run on adminPool() and never SET ROLE.
// Only SES + SQS are mocked at the boundary; the DB is real.
//
// Gated on DATABASE_URL; skips cleanly when no Postgres is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, applyMigrations, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, SendEmailInput, SendEmailResult } from '@cdp/email';
import {
  enrollFromSegmentChange,
  runEnrollment,
  buildSweepQuery,
  runStatementsInWorkspaceTx,
  type EnrollDeps,
  type RunDeps,
  type SegmentChangeLogRow,
  type AutomationDefinition,
} from '@cdp/service-automation-runner';
import {
  dispatchOutbox,
  parseOutboxIdFromSqsRecord,
  runStatementsInWorkspaceTx as dispatcherTx,
  type DispatchDeps,
} from '@cdp/service-dispatcher';

type Pool = ReturnType<typeof adminPool>;

// File-local namespace — unique workspace/automation/profile/segment/template ids.
const WS = 'c12e0010-0000-4000-8000-000000000001';
const SEG = 'c12e0010-0000-4000-8000-0000000000a1';
const CAMP = 'c12e0010-0000-4000-8000-0000000000c1';
const PROF = 'c12e0010-0000-4000-8000-0000000000d1';
const TPL = 'c12e0010-0000-4000-8000-0000000000e1';

const DEF: AutomationDefinition = {
  startNode: 'trig',
  nodes: {
    trig: { type: 'trigger', kind: 'segment_entry', next: 'wait1' },
    wait1: { type: 'wait', delay: { seconds: 86400 }, next: 'cond' }, // 1 day
    cond: {
      type: 'condition',
      ast: { field: 'features.counters.purchase', operator: '>=', value: 1 },
      onTrue: 'send',
      onFalse: 'done',
    },
    send: { type: 'action', kind: 'send', template_id: TPL, next: 'done' },
    done: { type: 'exit' },
  },
};

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

class CapturingSqs {
  public bodies: string[] = [];
  async send(c: { input?: { MessageBody?: string } }) {
    this.bodies.push(c.input?.MessageBody ?? '');
    return {};
  }
}

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('cross-phase automation journey (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    // Apply migrations only on a fresh DB; the shared local DB is already migrated.
    const { rows } = await admin.query(
      "SELECT to_regclass('public.automations') IS NOT NULL AS exists",
    );
    if (!rows[0].exists) await applyMigrations(admin);
    await cleanup();
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [WS, JSON.stringify({ verified: true, from_domain: 'mail.acme.com', config_set: 'cs' })],
    );
    await admin.query(
      "INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'s','dynamic_realtime')",
      [SEG, WS],
    );
    await admin.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html) VALUES ($1,$2,'t','<m/>','<html>Hi</html>')",
      [TPL, WS],
    );
    await admin.query(
      'INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,$3,$4)',
      [PROF, WS, 'ext', 'journey@example.com'],
    );
    await admin.query(
      "INSERT INTO profile_features (profile_id, workspace_id, counters) VALUES ($1,$2,$3::jsonb)",
      [PROF, WS, JSON.stringify({ purchase: 2 })],
    );
    await admin.query(
      "INSERT INTO automations (id, workspace_id, name, definition, trigger_segment_id, status) VALUES ($1,$2,'C',$3::jsonb,$4,'active')",
      [CAMP, WS, JSON.stringify(DEF), SEG],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM automations WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profile_features WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  function enrollDeps(): EnrollDeps {
    return {
      reader: { query: (t, v) => admin.query(t, v as unknown[]) as never },
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
    };
  }

  function runDeps(now: Date, sqs: CapturingSqs): RunDeps {
    return {
      reader: { query: (t, v) => admin.query(t, v as unknown[]) as never },
      sqs: sqs as never,
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => now,
      dispatchQueueUrl: 'https://sqs/dispatch',
    };
  }

  function dispatchDeps(now: Date, ses: SesEmailClient): DispatchDeps {
    return {
      reader: { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) } as never,
      ses,
      runInWorkspaceTx: (w, s) => dispatcherTx(admin, w, s),
      now: () => now,
      unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
      linkTrackingBaseUrl: 'https://api.cdp.example',
    };
  }

  it('segment entry → enroll → wait → branch → send through the real dispatcher', async () => {
    // 1. Segment entry drives enrollment.
    const change: SegmentChangeLogRow = {
      workspace_id: WS,
      segment_id: SEG,
      profile_id: PROF,
      action: 'entered',
    };
    const enrolled = await enrollFromSegmentChange(enrollDeps(), change);
    expect(enrolled.enrolled).toBe(1);

    const enr = await admin.query(
      'SELECT id FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2 AND profile_id = $3',
      [WS, CAMP, PROF],
    );
    const enrollmentId = enr.rows[0].id;

    // 2. Tick 1 @ T0: trigger → wait → PARK (next_run_at = T0 + 1d).
    const t0 = new Date('2026-06-07T12:00:00.000Z');
    const r1 = await runEnrollment(runDeps(t0, new CapturingSqs()), enrollmentId);
    expect(r1.result).toBe('parked');

    // 3. Real sweep before the wait elapses: NOT due.
    const early = buildSweepQuery(new Date('2026-06-07T18:00:00.000Z'));
    const dueEarly = await admin.query(early.text, early.values);
    expect(dueEarly.rows.find((x) => x.id === enrollmentId)).toBeUndefined();

    // 4. Real sweep after the wait: due.
    const t2 = new Date('2026-06-08T12:00:01.000Z');
    const late = buildSweepQuery(t2);
    const dueLate = await admin.query(late.text, late.values);
    expect(dueLate.rows.find((x) => x.id === enrollmentId)).toBeDefined();

    // 5. Tick 2: condition(true, purchase=2) → action(send) → exit.
    const sqs = new CapturingSqs();
    const r2 = await runEnrollment(runDeps(t2, sqs), enrollmentId);
    expect(r2.result).toBe('completed');
    expect(sqs.bodies).toHaveLength(1);

    // 6. Dispatch the enqueued {outbox_id} through the REAL dispatcher.
    const ses = new CountingSes();
    const outcome = await dispatchOutbox(
      dispatchDeps(t2, ses),
      parseOutboxIdFromSqsRecord(sqs.bodies[0]!),
    );
    expect(outcome.result).toBe('send');
    expect(ses.sends).toHaveLength(1);
    expect(ses.sends[0]!.to).toBe('journey@example.com');

    // 7. messages_log + enrollment terminal state reconcile.
    const ml = await admin.query(
      'SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1 AND automation_id = $2',
      [WS, CAMP],
    );
    expect(ml.rows[0].n).toBe(1);
    const fin = await admin.query('SELECT status FROM automation_enrollments WHERE id = $1', [
      enrollmentId,
    ]);
    expect(fin.rows[0].status).toBe('completed');
  });
});
