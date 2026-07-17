import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromEvent } from '../src/enroll.js';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import type { AutomationDefinition } from '../src/dsl.js';

// REAL Postgres. An update-profile (set_attribute) step writes a LITERAL value AND
// an EVENT-SOURCED value ({{event.amount}}) taken from the trigger event persisted
// on enrollment.state; the write is workspace-scoped + idempotent on retry; an
// undefined event path resolves safely.
const RUN = hasDatabaseUrl();
const WS = 'ca115e70-0000-0000-0000-0000000000a1';
const WS_OTHER = 'ca115e70-0000-0000-0000-0000000000a2';
const CAMP = 'ca115e70-0000-0000-0000-0000000000c1';

// trigger(event:purchase) -> set_attribute(tier=literal 'gold')
//   -> set_attribute(last_purchase_amount = {{event.amount}})
//   -> set_attribute(missing = {{event.nope}}) -> exit
const DEF: AutomationDefinition = {
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'lit' },
    lit: { type: 'action', kind: 'set_attribute', key: 'tier', value: { kind: 'literal', value: 'gold' }, next: 'amt' },
    amt: {
      type: 'action',
      kind: 'set_attribute',
      key: 'last_purchase_amount',
      value: { kind: 'expression', expression: '{{event.amount}}' },
      next: 'miss',
    },
    miss: {
      type: 'action',
      kind: 'set_attribute',
      key: 'safe_missing',
      value: { kind: 'expression', expression: '{{event.nope}}' },
      next: 'x',
    },
    x: { type: 'exit' },
  },
};

class CapturingSqs {
  public bodies: string[] = [];
  async send(c: { input?: { MessageBody?: string } }) {
    this.bodies.push(c.input?.MessageBody ?? '');
    return {};
  }
}

describe.skipIf(!RUN)('set_attribute event-sourced value (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2026-06-07T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const w of [WS, WS_OTHER]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await admin.query(
      "INSERT INTO automations (id, workspace_id, name, definition, status) VALUES ($1,$2,'C',$3::jsonb,'active')",
      [CAMP, WS, JSON.stringify(DEF)],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup() {
    for (const w of [WS, WS_OTHER]) {
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  function runnerDeps(sqs: CapturingSqs): RunDeps {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: sqs as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => NOW,
      dispatchQueueUrl: 'q',
    };
  }

  const enrollDeps = () => ({
    reader: { query: (t: string, v?: readonly unknown[]) => admin.query(t, v as unknown[]) } as never,
    runInWorkspaceTx: (w: string, s: never) => runStatementsInWorkspaceTx(admin, w, s),
  });

  it('persists state.event, writes literal + event-sourced attrs, undefined-safe, scoped + idempotent', async () => {
    // The SAME email in BOTH workspaces — proves the UPDATE is workspace-scoped.
    const email = 'buyer@example.com';
    const p = await admin.query(
      'INSERT INTO profiles (workspace_id, email) VALUES ($1,$2) RETURNING id',
      [WS, email],
    );
    const profileId = p.rows[0].id as string;
    const other = await admin.query(
      'INSERT INTO profiles (workspace_id, email, attributes) VALUES ($1,$2,$3::jsonb) RETURNING id',
      [WS_OTHER, email, JSON.stringify({ tier: 'bronze' })],
    );
    const otherId = other.rows[0].id as string;

    // Event-trigger enrollment persists the trigger event payload onto state.event.
    const res = await enrollFromEvent(enrollDeps(), {
      workspace_id: WS,
      profile_id: profileId,
      type: 'purchase',
      payload: { amount: 19.99 },
      event_id: 'evt-1',
    });
    expect(res.enrolled).toBe(1);

    const enr = await admin.query<{ id: string; state: { event?: { payload?: Record<string, unknown> } } }>(
      'SELECT id, state FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2',
      [WS, CAMP],
    );
    expect(enr.rows[0]!.state.event?.payload).toEqual({ amount: 19.99 });
    const enrollmentId = enr.rows[0]!.id;

    // Run the tick — chains all three set_attribute nodes to exit.
    const r1 = await runEnrollment(runnerDeps(new CapturingSqs()), enrollmentId);
    expect(r1.result).toBe('completed');

    const after = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS, profileId],
    );
    const attrs = after.rows[0]!.attributes;
    expect(attrs.tier).toBe('gold'); // literal
    expect(attrs.last_purchase_amount).toBe('19.99'); // event-sourced (NOT the raw token)
    expect(attrs.safe_missing).toBe(''); // undefined event path → safe-empty

    // WORKSPACE-SCOPED: the other tenant's identically-emailed profile is untouched.
    const otherAfter = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS_OTHER, otherId],
    );
    expect(otherAfter.rows[0]!.attributes).toEqual({ tier: 'bronze' });

    // IDEMPOTENT on retry: re-arm the enrollment to active@start and re-run; the
    // event re-resolves from the SAME persisted state → identical values.
    await admin.query(
      "UPDATE automation_enrollments SET status='active', current_node='t', next_run_at=now() WHERE id=$1",
      [enrollmentId],
    );
    const r2 = await runEnrollment(runnerDeps(new CapturingSqs()), enrollmentId);
    expect(r2.result).toBe('completed');
    const after2 = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS, profileId],
    );
    expect(after2.rows[0]!.attributes.last_purchase_amount).toBe('19.99');
    expect(after2.rows[0]!.attributes).toEqual(attrs); // unchanged across the retry
  });

  it('a manual/segment enrollment (no state.event) resolves an event.* expression safe-empty', async () => {
    const p = await admin.query(
      'INSERT INTO profiles (workspace_id, email) VALUES ($1,$2) RETURNING id',
      [WS, 'manual@example.com'],
    );
    const profileId = p.rows[0].id as string;
    // Plain insert (no state) — mirrors enrollProfileManually leaving state '{}'.
    await admin.query(
      "INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t','active', now())",
      [WS, CAMP, profileId],
    );
    const enr = await admin.query<{ id: string }>(
      'SELECT id FROM automation_enrollments WHERE workspace_id = $1 AND profile_id = $2',
      [WS, profileId],
    );
    const r = await runEnrollment(runnerDeps(new CapturingSqs()), enr.rows[0]!.id);
    expect(r.result).toBe('completed'); // never crashes
    const after = await admin.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM profiles WHERE workspace_id = $1 AND id = $2',
      [WS, profileId],
    );
    expect(after.rows[0]!.attributes.tier).toBe('gold');
    expect(after.rows[0]!.attributes.last_purchase_amount).toBe(''); // event undefined → safe-empty
  });
});
