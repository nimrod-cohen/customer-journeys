// REAL Postgres: automation exit rules end-to-end — event / segment / profile
// rules exiting or restarting active enrollments, with the end cases pinned:
// pending sends cancelled, restarted journeys re-send, the enrolling event never
// hits its own enrollment, exit beats restart, paused vs archived, draft rules
// inert, restart cap, completed enrollments untouched, workspace isolation.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { enrollFromEvent, enrollFromSegmentChange, enrollFromProfileChange, type EnrollDeps } from '../src/enroll.js';
import { runEnrollment, type RunDeps, type Reader } from '../src/run.js';
import { runStatementsInWorkspaceTx, withWorkspaceTx } from '../src/deps.js';
import { MAX_RESTARTS } from '../src/exit-rules.js';
import type { ExitRule } from '../src/exit-rules-dsl.js';

const RUN = hasDatabaseUrl();
const CO = 'e7170000-0000-4000-8000-0000000000c0';
const WS = 'e7170000-0000-4000-8000-0000000000a1';
const WS_B = 'e7170000-0000-4000-8000-0000000000a2';
const SEG = 'e7170000-0000-4000-8000-0000000000b1';

// trigger(event cart) → send sms → wait 1 day → send sms → exit
const flow = (exitRules: ExitRule[], trigger: Record<string, unknown> = { kind: 'event', eventType: 'cart' }) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', ...trigger, next: 's1' },
    s1: { type: 'action', kind: 'send', medium: 'sms', text_body: 'hi', next: 'w' },
    w: { type: 'wait', delay: { seconds: 86400 }, next: 's2' },
    s2: { type: 'action', kind: 'send', medium: 'sms', text_body: 'again', next: 'x' },
    x: { type: 'exit' },
  },
  exitRules,
});

class NoopSqs {
  async send() {
    return {};
  }
}

describe.skipIf(!RUN)('automation exit rules (real Postgres)', () => {
  let admin: Pool;
  const NOW = new Date('2099-01-01T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO companies (id, name) VALUES ($1, 'Exit rules co')", [CO]);
    for (const w of [WS, WS_B]) {
      await admin.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [w, CO]);
    }
    await admin.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'seg','dynamic_realtime')", [SEG, WS]);
  });

  beforeEach(async () => {
    for (const w of [WS, WS_B]) {
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
    }
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM activity_log WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
    await admin.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  const enrollDeps = (): EnrollDeps => ({
    reader: { query: (t, v) => admin.query(t, v as unknown[]) as never },
    runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
  });
  const runDeps = (now = NOW): RunDeps => {
    const reader: Reader = { query: (t, v) => admin.query(t, v as unknown[]) as never };
    return {
      reader,
      sqs: new NoopSqs() as never,
      withTx: (fn) => withWorkspaceTx(admin, fn),
      runInWorkspaceTx: (w, s) => runStatementsInWorkspaceTx(admin, w, s),
      now: () => now,
      dispatchQueueUrl: 'q',
    };
  };

  async function profile(ws = WS, attrs: Record<string, unknown> = {}): Promise<string> {
    const r = await admin.query(
      "INSERT INTO profiles (workspace_id, email, phone, attributes) VALUES ($1, gen_random_uuid()::text || '@x.com', NULL, $2::jsonb) RETURNING id",
      [ws, JSON.stringify(attrs)],
    );
    return r.rows[0].id as string;
  }
  async function automation(def: unknown, status = 'active', ws = WS, extra: { draft?: unknown } = {}): Promise<string> {
    const r = await admin.query(
      'INSERT INTO automations (workspace_id, name, definition, status, draft_definition) VALUES ($1,$2,$3::jsonb,$4,$5::jsonb) RETURNING id',
      [ws, 'Cart', JSON.stringify(def), status, extra.draft ? JSON.stringify(extra.draft) : null],
    );
    return r.rows[0].id as string;
  }
  let seq = 0;
  const event = (p: string, type: string, payload: Record<string, unknown> = {}, ws = WS) =>
    enrollFromEvent(enrollDeps(), { workspace_id: ws, profile_id: p, type, payload, event_id: `ev-${(seq += 1)}` });
  async function enrollment(a: string, p: string) {
    const r = await admin.query(
      'SELECT id, status, current_node, restarts, exit_reason, state FROM automation_enrollments WHERE automation_id=$1 AND profile_id=$2',
      [a, p],
    );
    return r.rows[0] as { id: string; status: string; current_node: string; restarts: number; exit_reason: string | null; state: Record<string, unknown> };
  }
  const tick = async (a: string, p: string, now = NOW) => runEnrollment(runDeps(now), (await enrollment(a, p)).id);
  const outbox = async (a: string, p: string) =>
    (await admin.query('SELECT dedupe_key, status, last_error FROM outbox WHERE automation_id=$1 AND profile_id=$2 ORDER BY created_at, dedupe_key', [a, p])).rows as {
      dedupe_key: string;
      status: string;
      last_error: string | null;
    }[];

  const EXIT_ON_PURCHASE: ExitRule = { id: 'buy', action: 'exit', when: { kind: 'event', eventType: 'purchase' } };

  it('an event rule exits, records why, cancels pending sends and leaves in-flight ones alone', async () => {
    const a = await automation(flow([EXIT_ON_PURCHASE]));
    const p = await profile();
    await event(p, 'cart');
    await tick(a, p); // s1 → outbox, parks at w
    await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, automation_id, dedupe_key, payload, status) VALUES ($1,$2,$3,'inflight','{}'::jsonb,'sending')",
      [WS, p, a],
    );
    const res = await event(p, 'purchase');
    expect(res.exited).toBe(1);
    const e = await enrollment(a, p);
    expect(e.status).toBe('exited');
    expect(e.exit_reason).toBe('Exit rule: event "purchase"');
    const ob = await outbox(a, p);
    expect(ob.find((o) => o.dedupe_key === 'inflight')!.status).toBe('sending');
    const pending = ob.find((o) => o.dedupe_key !== 'inflight')!;
    expect(pending.status).toBe('cancelled');
    expect(pending.last_error).toMatch(/exited automation/);
    const log = await admin.query("SELECT type, detail FROM activity_log WHERE workspace_id=$1 AND profile_id=$2 AND source='automation'", [WS, p]);
    expect(log.rows).toEqual([{ type: 'automation_exited', detail: 'Left "Cart" — event "purchase"' }]);
    // A later tick does nothing more.
    expect((await tick(a, p)).result).toBe('skipped');
  });

  it('a payload filter that does not match leaves the journey running', async () => {
    const rule: ExitRule = { id: 'big', action: 'exit', when: { kind: 'event', eventType: 'purchase', filter: { field: 'payload.total', operator: '>', value: 100 } as never } };
    const a = await automation(flow([rule]));
    const p = await profile();
    await event(p, 'cart');
    await event(p, 'purchase', { total: 20 });
    expect((await enrollment(a, p)).status).toBe('active');
    await event(p, 'purchase', { total: 200 });
    expect((await enrollment(a, p)).status).toBe('exited');
  });

  it('restart rewinds to the start, swaps in the new event, clears journey vars and re-sends', async () => {
    const restart: ExitRule = { id: 'again', action: 'restart', when: { kind: 'event', eventType: 'cart' } };
    const a = await automation(flow([restart]));
    const p = await profile();
    const first = await event(p, 'cart', { n: 1 }); // enrolls — must NOT restart itself
    expect(first.enrolled).toBe(1);
    expect(first.restarted).toBe(0);
    await tick(a, p); // s1 sent (run 0), parked at w
    await admin.query(`UPDATE automation_enrollments SET state = state || '{"journey":{"k":1}}'::jsonb WHERE automation_id=$1`, [a]);

    const second = await event(p, 'cart', { n: 2 });
    // 'once' still holds — still exactly one enrollment row (the restarted one).
    expect((await admin.query('SELECT 1 FROM automation_enrollments WHERE automation_id=$1', [a])).rowCount).toBe(1);
    expect(second.restarted).toBe(1);
    const e = await enrollment(a, p);
    expect(e.status).toBe('active');
    expect(e.current_node).toBe('t');
    expect(e.restarts).toBe(1);
    expect(e.state.journey).toBeUndefined();
    expect((e.state.event as { payload: { n: number } }).payload.n).toBe(2);

    await tick(a, p); // walks s1 again under run 1 → a NEW outbox row
    const keys = (await outbox(a, p)).map((o) => o.dedupe_key);
    expect(keys).toContain(`automation:${a}:${p}:s1`);
    expect(keys).toContain(`automation:${a}:${p}:s1:r1`);
    expect((await enrollment(a, p)).current_node).toBe('w');
  });

  it('exit beats restart when both fire on the same signal', async () => {
    const a = await automation(
      flow([
        { id: 'r', action: 'restart', when: { kind: 'event', eventType: 'purchase' } },
        EXIT_ON_PURCHASE,
      ]),
    );
    const p = await profile();
    await event(p, 'cart');
    await event(p, 'purchase');
    expect((await enrollment(a, p)).status).toBe('exited');
  });

  it('segment rules: leaving exits, entering restarts', async () => {
    const a = await automation(flow([{ id: 'left', action: 'exit', when: { kind: 'segment_exit', segmentId: SEG } }]));
    const b = await automation(flow([{ id: 'in', action: 'restart', when: { kind: 'segment_entry', segmentId: SEG } }]));
    const p = await profile();
    await event(p, 'cart');
    const entered = await enrollFromSegmentChange(enrollDeps(), { workspace_id: WS, segment_id: SEG, profile_id: p, action: 'entered' });
    expect(entered.restarted).toBe(1);
    expect((await enrollment(b, p)).restarts).toBe(1);
    expect((await enrollment(a, p)).status).toBe('active');
    const left = await enrollFromSegmentChange(enrollDeps(), { workspace_id: WS, segment_id: SEG, profile_id: p, action: 'exited' });
    expect(left.exited).toBe(1);
    expect((await enrollment(a, p)).status).toBe('exited');
    expect((await enrollment(b, p)).status).toBe('active');
  });

  it('profile_match exit is checked on the tick: someone already matching never gets the first send', async () => {
    const rule: ExitRule = { id: 'paid', action: 'exit', when: { kind: 'profile_match', ast: { field: 'attributes.plan', operator: '=', value: 'paid' } as never } };
    const a = await automation(flow([rule]));
    const p = await profile(WS, { plan: 'paid' });
    await event(p, 'cart'); // enroll; the event-time check runs BEFORE the insert, so nothing yet
    expect((await enrollment(a, p)).status).toBe('active');
    expect((await tick(a, p)).result).toBe('exited');
    expect(await outbox(a, p)).toEqual([]);
  });

  it('an event rule with several types exits on ANY of them', async () => {
    const rule: ExitRule = { id: 'met', action: 'exit', when: { kind: 'event', eventType: 'meeting_scheduled', eventTypes: ['meeting_scheduled', 'meeting_booked'] } };
    const a = await automation(flow([rule]));
    const p = await profile();
    await event(p, 'cart');
    await event(p, 'something_else');
    expect((await enrollment(a, p)).status).toBe('active');
    expect((await event(p, 'meeting_booked')).exited).toBe(1);
    expect((await enrollment(a, p)).exit_reason).toBe('Exit rule: event "meeting_scheduled" or "meeting_booked"');
  });

  it('someone who unsubscribed leaves at the next step — even an automation with no exit rules', async () => {
    const a = await automation(flow([]));
    const p = await profile();
    await event(p, 'cart');
    await tick(a, p); // s1 sent, parks at the wait
    await admin.query(`UPDATE profiles SET attributes = attributes || '{"unsubscribed": true}'::jsonb WHERE id = $1`, [p]);
    expect((await tick(a, p, new Date(NOW.getTime() + 2 * 86_400_000))).result).toBe('exited');
    const e = await enrollment(a, p);
    expect(e.exit_reason).toBe('Exit rule: Unsubscribed');
    expect((await outbox(a, p)).map((o) => o.dedupe_key).some((k) => k.includes('s2'))).toBe(false);
  });

  it('profile_match exit also fires on a profile update', async () => {
    const rule: ExitRule = { id: 'paid', action: 'exit', when: { kind: 'profile_match', ast: { field: 'attributes.plan', operator: '=', value: 'paid' } as never } };
    const a = await automation(flow([rule]));
    const p = await profile();
    await event(p, 'cart');
    await tick(a, p);
    await admin.query(`UPDATE profiles SET attributes = '{"plan":"paid"}'::jsonb WHERE id = $1`, [p]);
    const r = await enrollFromProfileChange(enrollDeps(), { workspace_id: WS, profile_id: p, change: 'updated' });
    expect(r.exited).toBe(1);
    expect((await enrollment(a, p)).status).toBe('exited');
  });

  it('profile_match restart is edge-triggered: only a false→true change restarts', async () => {
    const rule: ExitRule = { id: 'vip', action: 'restart', when: { kind: 'profile_match', ast: { field: 'attributes.vip', operator: '=', value: 'yes' } as never } };
    const a = await automation(flow([rule]));
    const p = await profile(WS, { vip: 'yes' });
    await event(p, 'cart');
    await tick(a, p); // first observation: true → latch only, journey proceeds
    let e = await enrollment(a, p);
    expect(e.current_node).toBe('w');
    expect(e.restarts).toBe(0);
    expect(e.state.exit_latch).toEqual({ vip: true });

    const update = () => enrollFromProfileChange(enrollDeps(), { workspace_id: WS, profile_id: p, change: 'updated' });
    expect((await update()).restarted).toBe(0); // still true — no restart
    await admin.query(`UPDATE profiles SET attributes = '{"vip":"no"}'::jsonb WHERE id = $1`, [p]);
    expect((await update()).restarted).toBe(0); // true → false records
    await admin.query(`UPDATE profiles SET attributes = '{"vip":"yes"}'::jsonb WHERE id = $1`, [p]);
    expect((await update()).restarted).toBe(1); // false → true restarts
    e = await enrollment(a, p);
    expect(e.current_node).toBe('t');
    expect(e.state.exit_latch).toEqual({ vip: true }); // latch survives the restart
    expect((await update()).restarted).toBe(0); // and does not loop
  });

  it('applies while PAUSED, not for ARCHIVED automations, and draft-only rules are inert', async () => {
    const paused = await automation(flow([EXIT_ON_PURCHASE]));
    const archived = await automation(flow([EXIT_ON_PURCHASE]));
    const drafted = await automation(flow([]), 'active', WS, { draft: flow([EXIT_ON_PURCHASE]) });
    const p = await profile();
    await event(p, 'cart');
    await admin.query("UPDATE automations SET status='paused' WHERE id=$1", [paused]);
    await admin.query("UPDATE automations SET status='archived' WHERE id=$1", [archived]);
    await event(p, 'purchase');
    expect((await enrollment(paused, p)).status).toBe('exited');
    expect((await enrollment(archived, p)).status).toBe('active');
    expect((await enrollment(drafted, p)).status).toBe('active');
  });

  it('a completed enrollment is never touched, and restarts stop at the cap', async () => {
    const a = await automation(flow([{ id: 'again', action: 'restart', when: { kind: 'event', eventType: 'poke' } }]));
    const p = await profile();
    await event(p, 'cart');
    await admin.query('UPDATE automation_enrollments SET restarts=$2 WHERE automation_id=$1', [a, MAX_RESTARTS]);
    expect((await event(p, 'poke')).restarted).toBe(0);
    expect((await enrollment(a, p)).restarts).toBe(MAX_RESTARTS);
    await admin.query("UPDATE automation_enrollments SET status='completed', restarts=0 WHERE automation_id=$1", [a]);
    expect((await event(p, 'poke')).restarted).toBe(0);
    expect((await enrollment(a, p)).status).toBe('completed');
  });

  it('is workspace-scoped: another workspace\'s event never touches this enrollment', async () => {
    const a = await automation(flow([EXIT_ON_PURCHASE]));
    const p = await profile();
    await event(p, 'cart');
    // A mis-scoped call (other workspace, same profile id) must not match anything.
    const r = await event(p, 'purchase', {}, WS_B);
    expect(r.exited).toBe(0);
    expect((await enrollment(a, p)).status).toBe('active');
  });
});
