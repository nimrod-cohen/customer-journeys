// Waiting out a mail server that is down.
//
// The app submits to our own MTA over SMTP. When that box is rebooting, every
// submission in flight fails at once — and a send that is merely EARLY must not
// become a send that never happened. The rules:
//
//   - a connection-level failure is TRANSIENT: the row goes back to pending with a
//     growing delay, and a later sweep re-claims it;
//   - a 5xx from the server is PERMANENT: the recipient is refused, and retrying
//     forever would hammer the MTA and hide the reason;
//   - retries are BOUNDED, so a row that can never succeed eventually records a
//     failure a human can see instead of looping.
import { describe, it, expect } from 'vitest';
import {
  isPermanentSendError,
  retryDelayMs,
  MAX_SEND_ATTEMPTS,
  buildOutboxRetrySchedule,
  buildDueOutboxQuery,
} from '../src/core.js';

describe('isPermanentSendError — SMTP', () => {
  // nodemailer reports the SMTP reply code; 5xx is the server saying "never".
  it('treats a 5xx SMTP reply as permanent', () => {
    expect(isPermanentSendError({ responseCode: 550, message: 'No such user' })).toBe(true);
    expect(isPermanentSendError({ responseCode: 552 })).toBe(true);
  });

  // 4xx is "not now" — the MTA itself would retry, and so must we.
  it('treats a 4xx SMTP reply as transient', () => {
    expect(isPermanentSendError({ responseCode: 421, message: 'Service not available' })).toBe(false);
    expect(isPermanentSendError({ responseCode: 451 })).toBe(false);
  });

  // The reboot case: nothing is listening yet, DNS is still cold, TLS times out.
  it('treats connection-level failures as transient', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNECTION', 'ESOCKET', 'EAI_AGAIN', 'EDNS']) {
      expect(isPermanentSendError({ code })).toBe(false);
    }
  });

  // Bad credentials are permanent: retrying cannot fix them and every attempt is a
  // failed auth against our own server.
  it('treats an auth failure as permanent', () => {
    expect(isPermanentSendError({ code: 'EAUTH', responseCode: 535 })).toBe(true);
  });

  // The SES rules are untouched.
  it('still classifies the SES shapes it always did', () => {
    expect(isPermanentSendError({ name: 'MessageRejected' })).toBe(true);
    expect(isPermanentSendError({ name: 'ThrottlingException' })).toBe(false);
    expect(isPermanentSendError(new Error('socket hang up'))).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially and then holds at the cap', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(4)).toBe(480_000);
    expect(retryDelayMs(5)).toBe(960_000);
    expect(retryDelayMs(6)).toBe(1_800_000); // capped at 30 minutes
    expect(retryDelayMs(50)).toBe(1_800_000);
  });

  // A first attempt still waits: retrying instantly against a box that is rebooting
  // just burns the attempt budget before it can come back.
  it('never returns zero', () => {
    expect(retryDelayMs(0)).toBeGreaterThan(0);
  });

  // The whole budget has to outlast a reboot by a wide margin, or the graceful wait
  // is only graceful in theory.
  it('spans hours before giving up', () => {
    let total = 0;
    for (let i = 1; i <= MAX_SEND_ATTEMPTS; i++) total += retryDelayMs(i);
    expect(total).toBeGreaterThan(3 * 60 * 60_000);
  });
});

describe('buildOutboxRetrySchedule', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');

  it('returns the row to pending with the next attempt in the future', () => {
    const s = buildOutboxRetrySchedule('ws-1', 'ob-1', 1, now);
    expect(s.text).toMatch(/status = 'pending'/);
    expect(s.values[0]).toBe('ws-1'); // workspace_id at $1 (inv.1)
    expect(new Date(String(s.values[2])).getTime()).toBe(now.getTime() + 60_000);
  });

  // Only a row we are actually holding may be released; otherwise a slow retry could
  // resurrect a row another worker has since sent.
  it('only releases a row that is still sending', () => {
    expect(buildOutboxRetrySchedule('ws-1', 'ob-1', 1, now).text).toMatch(/status = 'sending'/);
  });

  it('refuses to build without a workspace (inv.1)', () => {
    expect(() => buildOutboxRetrySchedule('', 'ob-1', 1, now)).toThrow(/workspaceId/);
  });
});

describe('buildDueOutboxQuery', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');

  it('takes pending rows whose backoff has elapsed, and never-tried rows', () => {
    const q = buildDueOutboxQuery(now, 100);
    expect(q.text).toMatch(/status = 'pending'/);
    expect(q.text).toMatch(/next_attempt_at IS NULL OR next_attempt_at <= \$1/);
    expect(q.values[0]).toBe(now.toISOString());
  });

  // A process killed mid-send leaves a row claimed forever. Nothing else recovers
  // it, so the sweep reclaims one that has been 'sending' well past any send.
  it('reclaims rows stuck in sending', () => {
    const q = buildDueOutboxQuery(now, 100);
    expect(q.text).toMatch(/'sending'/);
  });

  it('stops before the attempt budget is spent', () => {
    expect(buildDueOutboxQuery(now, 100).text).toMatch(new RegExp(`attempts < ${MAX_SEND_ATTEMPTS}`));
  });

  it('bounds the batch', () => {
    expect(buildDueOutboxQuery(now, 25).values).toContain(25);
  });
});
