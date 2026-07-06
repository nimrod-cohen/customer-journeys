import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient } from '@cdp/email';
import { dispatchOutbox, type DispatchDeps, type Reader } from '../src/dispatch.js';
import type { SqlStatement } from '../src/core.js';

/** A quiet schedule with the SAME window every weekday (settings default TZ = UTC). */
const allDays = (startHour: number, endHour: number): Record<string, { startHour: number; endHour: number }> =>
  Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { startHour, endHour }]));

// §9 + CRITICAL invariants — the orchestrator runs the FIXED guard pipeline and
// calls SES SendEmail ONLY on the all-pass path. We prove the SES call count
// with aws-sdk-client-mock: 0 on refuse/suppress/cap/quiet, exactly 1 on send,
// and NOT twice on replay (atomic claim). The DB is faked here (it's exercised
// for real in the integration tier); SES is mocked.
const ses = mockClient(SESv2Client);

const WS = '11111111-1111-1111-1111-111111111111';
const OUTBOX = '22222222-2222-2222-2222-222222222222';
const PROFILE = '33333333-3333-3333-3333-333333333333';

interface FakeState {
  outboxStatus: string;
  suppressed: boolean;
  recentSends: number;
  wsStatus: string;
  verified: boolean;
  quietHours: unknown;
  freqCap: unknown;
  linkTracking?: boolean;
}

function makeReader(state: FakeState): { reader: Reader; claimAttempts: number } {
  const tracker = { claimAttempts: 0 };
  const reader: Reader = {
    async query<T>(text: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('SELECT id, workspace_id, profile_id, campaign_id')) {
        return {
          rows: [
            {
              id: OUTBOX,
              workspace_id: WS,
              profile_id: PROFILE,
              campaign_id: null,
              template_id: 'tpl-1',
              dedupe_key: 'dk-1',
              attempts: 0,
              payload: {
                subject: 'Hi',
                merge: { first_name: 'Ada' },
                frequency_cap: state.freqCap,
                quiet_hours: state.quietHours,
              },
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith("UPDATE outbox SET status = 'sending'")) {
        // The atomic claim: succeeds only if currently pending.
        tracker.claimAttempts += 1;
        if (state.outboxStatus !== 'pending') return { rows: [] };
        state.outboxStatus = 'sending';
        return { rows: [{ id: OUTBOX, workspace_id: WS, profile_id: PROFILE } as unknown as T] };
      }
      if (t.startsWith('SELECT id, status, sending_identity, settings FROM workspaces')) {
        return {
          rows: [
            {
              id: WS,
              status: state.wsStatus,
              sending_identity: {
                verified: state.verified,
                from_domain: 'mail.acme.com',
                config_set: 'ws-cfgset',
              },
              settings: state.linkTracking ? { link_tracking: true } : null,
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith('SELECT id, email, external_id, email_status, created_at, attributes')) {
        return {
          rows: [
            {
              id: PROFILE,
              email: 'r@example.com',
              external_id: null,
              email_status: 'active',
              created_at: null,
              attributes: { tier: 'gold' },
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith('SELECT compiled_html, subject, sender_id, to_address FROM email_templates')) {
        return {
          rows: [
            {
              compiled_html: '<html>Hi {{first_name}} <a href="https://acme.com/sale">Sale</a></html>',
              subject: 'Hi',
              sender_id: null,
              to_address: '{{customer.email}}',
            } as unknown as T,
          ],
        };
      }
      if (t.startsWith('SELECT EXISTS')) {
        return { rows: [{ suppressed: state.suppressed } as unknown as T] };
      }
      if (t.startsWith('SELECT count(*)::int AS n FROM messages_log')) {
        return { rows: [{ n: state.recentSends } as unknown as T] };
      }
      return { rows: [] };
    },
  };
  return { reader, claimAttempts: tracker.claimAttempts, ...tracker };
}

function makeDeps(state: FakeState): {
  deps: DispatchDeps;
  txCalls: SqlStatement[][];
} {
  const { reader } = makeReader(state);
  const txCalls: SqlStatement[][] = [];
  const deps: DispatchDeps = {
    reader,
    ses: new ProdSesEmailClient(ses as unknown as SESv2Client),
    async runInWorkspaceTx(_ws, statements) {
      txCalls.push([...statements]);
      // Reflect the outbox status change the tx would persist.
      for (const s of statements) {
        if (s.text.includes("SET status = 'sent'")) state.outboxStatus = 'sent';
        if (s.text.includes('SET status = $3')) state.outboxStatus = String(s.values[2]);
      }
    },
    now: () => new Date('2026-06-10T12:00:00.000Z'),
    unsubscribeBaseUrl: 'https://api.cdp.example/unsubscribe',
    linkTrackingBaseUrl: 'https://api.cdp.example',
  };
  return { deps, txCalls };
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    outboxStatus: 'pending',
    suppressed: false,
    recentSends: 0,
    wsStatus: 'active',
    verified: true,
    quietHours: null,
    freqCap: { max: 7, days: 7 },
    ...overrides,
  };
}

describe('dispatchOutbox — SES call count proves guard order', () => {
  beforeEach(() => {
    ses.reset();
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
  });

  it('all-pass → calls SES exactly once and writes the 3-statement tx', async () => {
    const state = freshState();
    const { deps, txCalls } = makeDeps(state);
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('send');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    // messages_log + usage_counters + mark sent, all in one tx.
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0]).toHaveLength(3);
    expect(txCalls[0]![0]!.text).toContain('INSERT INTO messages_log');
    expect(txCalls[0]![1]!.text).toContain('INSERT INTO usage_counters');
    expect(txCalls[0]![2]!.text).toContain("SET status = 'sent'");
  });

  it('link tracking ON → rewrites the email links and records tracked_links in the tx', async () => {
    const { deps, txCalls } = makeDeps(freshState({ linkTracking: true }));
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('send');
    // The SENT html routes links through /t/<token>, not the raw destination.
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0]!.input as {
      Content: { Simple: { Body: { Html: { Data: string } } } };
    };
    const html = input.Content.Simple.Body.Html.Data;
    expect(html).toContain('/t/');
    expect(html).not.toContain('https://acme.com/sale');
    // A tracked_links row is upserted (before messages_log) in the same tx.
    expect(txCalls[0]!.some((s) => s.text.includes('INSERT INTO tracked_links'))).toBe(true);
  });

  it('workspace not verified → refuse, SES NOT called', async () => {
    const { deps } = makeDeps(freshState({ wsStatus: 'onboarding', verified: false }));
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('refuse');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('suppressed recipient → skip, SES NOT called', async () => {
    const { deps } = makeDeps(freshState({ suppressed: true }));
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('skip');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('over frequency cap → skip, SES NOT called', async () => {
    const { deps } = makeDeps(freshState({ recentSends: 7, freqCap: { max: 1, days: 7 } }));
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('skip');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('within quiet hours → defer, SES NOT called', async () => {
    const { deps } = makeDeps(freshState({ quietHours: allDays(9, 17) }));
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('defer');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('replay/concurrent: a row already claimed is a noop, SES NOT called again', async () => {
    // Simulate the row already moved out of pending (lost the claim).
    const { deps } = makeDeps(freshState({ outboxStatus: 'sent' }));
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('noop');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('two sequential dispatches of the same id send ONCE (idempotent claim)', async () => {
    const state = freshState();
    const { deps } = makeDeps(state);
    const first = await dispatchOutbox(deps, OUTBOX);
    const second = await dispatchOutbox(deps, OUTBOX);
    expect(first.result).toBe('send');
    expect(second.result).toBe('noop');
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it('SES failure → retryable-failure, claim reset, no messages_log write', async () => {
    ses.reset();
    ses.on(SendEmailCommand).rejects(new Error('SES throttled'));
    const state = freshState();
    const { deps, txCalls } = makeDeps(state);
    const out = await dispatchOutbox(deps, OUTBOX);
    expect(out.result).toBe('retryable-failure');
    // No messages_log/usage tx; only the claim-reset tx.
    const wrote = txCalls.some((stmts) => stmts.some((s) => s.text.includes('messages_log')));
    expect(wrote).toBe(false);
  });
});
