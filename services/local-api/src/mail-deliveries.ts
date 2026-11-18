// Successful deliveries from our own mail server.
//
// SES reports every delivery; Postfix reports only failures (as bounce mail). What
// it DOES do is log every handoff, so the mail-agent forwards Postfix's log lines
// and this module turns them into `delivery` events. As with bounces, the agent
// parses nothing — the parsing lives here, where it is tested.
//
// Two lines per handoff, joined by Postfix's queue id:
//   qmgr: <QID>: from=<bounce+TOKEN@bounce.…>, size=…, nrcpt=1 (queue active)
//   smtp: <QID>: to=<a@b.com>, relay=…, delay=…, dsn=2.0.0, status=sent (250 …)
// The `from` is our VERP Return-Path, so attribution reuses the SIGNED token the
// bounce path trusts: workspace and message come from `messages_log`, never from
// the log line (inv. 2). Mail without a valid token (a DSN Postfix generated, a
// relay test) is simply not ours to count.
//
// NOTE: while the box relays through relay1 (Hetzner's port 25 block), `status=sent`
// means our relay accepted it. A later rejection by the receiver still comes back
// as a bounce, which the bounce path records alongside.
import { unpackVerpToken } from '@cdp/email';
import { extractVerpToken, type MessageRef } from './mail-events.js';

/** One successful handoff read from the log. */
export interface LoggedDelivery {
  readonly queueId: string;
  readonly verpToken: string;
  readonly to: string;
  readonly relay: string;
  readonly dsn: string;
  /** ISO timestamp from the log line, when the line carries one. */
  readonly at: string | null;
}

// `<ts> <host> postfix/<proc>[pid]: <QID>: <rest>` — journalctl's short-iso format.
const LINE = /^(\S+)\s+\S+\s+postfix\/(?:[\w-]+\/)?(qmgr|smtp|lmtp)\[\d+\]:\s+([0-9A-Za-z]+):\s+(.*)$/;
const FROM = /^from=<([^>]*)>/;
const SENT = /^to=<([^>]*)>.*?\brelay=([^,\s]+).*?\bdsn=(\d\.\d+\.\d+), status=sent\b/;

/** Pure: pair each `status=sent` line with the `from=` of its queue id. */
export function parseDeliveryLog(lines: readonly string[]): LoggedDelivery[] {
  const fromByQueue = new Map<string, string>();
  const out: LoggedDelivery[] = [];
  for (const line of lines) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const [, ts, proc, queueId, rest] = m as unknown as [string, string, string, string, string];
    if (proc === 'qmgr') {
      const f = FROM.exec(rest);
      if (f) fromByQueue.set(queueId, f[1]!);
      continue;
    }
    const s = SENT.exec(rest);
    if (!s || !s[3]!.startsWith('2.')) continue;
    const token = extractVerpToken(fromByQueue.get(queueId) ?? null);
    if (!token) continue;
    out.push({ queueId, verpToken: token, to: s[1]!, relay: s[2]!, dsn: s[3]!, at: isoOrNull(ts) });
  }
  return out;
}

function isoOrNull(ts: string): string | null {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A delivery attributed to a message we sent. */
export interface AttributedDelivery {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly profileId: string | null;
  readonly relay: string;
  readonly dsn: string;
  readonly at: string | null;
}

/**
 * Verify each delivery's token and resolve its message. Anything that fails is
 * counted and dropped — never guessed. One message delivered to several addresses
 * (cc/bcc) yields one event: delivery is recorded per message.
 */
export async function attributeDeliveries(
  deliveries: readonly LoggedDelivery[],
  verpSecret: string,
  lookupMessage: (messageId: string) => Promise<MessageRef | null>,
): Promise<{ attributed: AttributedDelivery[]; ignored: number }> {
  const attributed: AttributedDelivery[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const d of deliveries) {
    const messageId = unpackVerpToken(verpSecret, d.verpToken);
    if (!messageId) {
      ignored++;
      continue;
    }
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    const ref = await lookupMessage(messageId);
    if (!ref) {
      ignored++;
      continue;
    }
    attributed.push({
      workspaceId: ref.workspaceId,
      messageId,
      profileId: ref.profileId ?? null,
      relay: d.relay,
      dsn: d.dsn,
      at: d.at,
    });
  }
  return { attributed, ignored };
}
