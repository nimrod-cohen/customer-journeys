// Ingestion of bounces and spam complaints from our own mail server.
//
// The mail-agent on the MTA is a THIN forwarder: it reads raw messages out of the
// bounce mailbox and posts them here. All parsing and decisioning lives in this
// repo, where it is tested — so fixing a parser bug is an app deploy, not a
// server change.
//
// This is the self-hosted twin of the SES -> SNS -> Feedback Lambda path, and it
// deliberately reuses that path's SQL builders rather than duplicating suppression
// logic: one place decides what a bounce means.
//
// Tenancy: the workspace is NEVER taken from the request. It is looked up from
// `messages_log` using the message id recovered from a VERIFIED VERP token, so a
// forged post cannot touch another tenant's data (invariant 2).
import { unpackVerpToken } from '@cdp/email';
import {
  parseBounceMessage,
  classifyInboundReport,
  type ParsedBounceMessage,
} from '@cdp/service-feedback';
import type { ClassifiedEvent } from '@cdp/service-feedback';

/** One raw message handed over by the mail-agent. */
export interface RawInboundMail {
  /** Full RFC 5322 message, headers and body. */
  readonly raw: string;
  /** Postfix's X-Original-To, preserved by the agent in case headers were stripped. */
  readonly originalTo?: string | null;
}

/** What ingestion decided about one message. */
export interface MailEventDecision {
  /** 'ignored' when we could not attribute it — recorded nowhere, never guessed. */
  readonly action: 'suppress' | 'record' | 'ignored';
  readonly reason: string;
  readonly workspaceId: string | null;
  readonly messageId: string | null;
  readonly recipient: string | null;
  readonly classified: ClassifiedEvent | null;
}

/** The message row we resolve from a verified VERP token. */
export interface MessageRef {
  readonly workspaceId: string;
  /** The primary recipient (the profile the message was rendered for). */
  readonly recipient: string | null;
  /** Visible copies this message carried, if any. */
  readonly cc?: readonly string[];
  /** Blind copies. Stored only so a bounce naming one can be attributed to it. */
  readonly bcc?: readonly string[];
}

/**
 * Decide what to do with one inbound report, given a way to resolve the message.
 *
 * Pure apart from the injected lookup, so every branch is unit-testable without a
 * database.
 *
 * The rule that protects the list: only a PERMANENT failure suppresses. A
 * transient one is still being retried by the MTA and must never remove an
 * address — and a complaint always suppresses, because someone reporting spam is
 * a stronger signal than any bounce.
 */
export async function decideMailEvent(
  mail: RawInboundMail,
  verpSecret: string,
  lookupMessage: (messageId: string) => Promise<MessageRef | null>,
): Promise<MailEventDecision> {
  const parsed: ParsedBounceMessage = parseBounceMessage(mail.raw ?? '');

  // The agent may pass X-Original-To separately if it had to read it from the
  // Maildir filename rather than the headers.
  const token = parsed.verpToken ?? extractToken(mail.originalTo ?? null);
  if (!token) {
    return none('no VERP token — cannot attribute this report to a message');
  }

  const messageId = unpackVerpToken(verpSecret, token);
  if (!messageId) {
    // Either a forgery or a token signed with a rotated secret. Either way we
    // must not act: acting on an unverified token is exactly how someone would
    // suppress an arbitrary recipient.
    return none('VERP token failed verification');
  }

  const ref = await lookupMessage(messageId);
  if (!ref) {
    return { ...none('no message found for this token'), messageId };
  }

  const classified = classifyInboundReport(parsed, messageId, ref.recipient);
  const suppress = classified.category === 'hard_bounce' || classified.category === 'complaint';

  // WHICH address failed. The report names one, and it is usually right — a copy can
  // bounce while the primary is fine, so the primary's address is the wrong answer.
  // But the report body is written by a remote party, so the named address counts
  // only when this message actually went to it. Anything else falls back to the
  // primary; without that check, a forged DSN could suppress any address it liked.
  const named = classified.recipients[0] ?? null;
  const wasOnThisMessage =
    !!named && recipientsOf(ref).some((a) => a.toLowerCase() === named.trim().toLowerCase());
  const recipient = wasOnThisMessage ? named : ref.recipient;

  return {
    action: classified.category === 'other' ? 'record' : suppress ? 'suppress' : 'record',
    reason:
      classified.category === 'complaint'
        ? 'spam complaint — permanent removal'
        : classified.category === 'hard_bounce'
          ? `permanent failure ${classified.subType ?? ''}`.trim()
          : classified.category === 'soft_bounce'
            ? `transient failure ${classified.subType ?? ''} — recorded, not suppressed`.trim()
            : 'unrecognised report — recorded only',
    workspaceId: ref.workspaceId,
    messageId,
    recipient,
    classified,
  };
}

/** Every address this message was delivered to: the primary plus its copies. */
function recipientsOf(ref: MessageRef): string[] {
  return [ref.recipient, ...(ref.cc ?? []), ...(ref.bcc ?? [])].filter((a): a is string => !!a);
}

function none(reason: string): MailEventDecision {
  return { action: 'ignored', reason, workspaceId: null, messageId: null, recipient: null, classified: null };
}

function extractToken(recipient: string | null): string | null {
  if (!recipient) return null;
  const addr = recipient.trim().replace(/^</, '').replace(/>$/, '');
  const at = addr.lastIndexOf('@');
  if (at <= 0) return null;
  const local = addr.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0 || local.slice(0, plus).toLowerCase() !== 'bounce') return null;
  return local.slice(plus + 1) || null;
}

/**
 * Look up the workspace and recipient a message id belongs to. `messages_log`
 * stores `profile_id` rather than an address, so the recipient comes from the
 * joined profile — which also means a bounce is attributed to the profile that
 * actually received it, not to whatever address the report happens to name.
 */
export function buildMessageLookup(messageId: string): { text: string; values: unknown[] } {
  return {
    text: `SELECT m.workspace_id, p.email AS recipient_email,
                  COALESCE(m.cc_addresses, '{}') AS cc_addresses,
                  COALESCE(m.bcc_addresses, '{}') AS bcc_addresses
             FROM messages_log m
             JOIN profiles p
               ON p.id = m.profile_id AND p.workspace_id = m.workspace_id
            WHERE m.ses_message_id = $1
            LIMIT 1`,
    values: [messageId],
  };
}
