// Plain-English meaning of an RFC 3463 enhanced status code (`5.7.1`, `4.2.2`…).
//
// A bounce report carries one of these, and on its own it tells a marketer
// nothing. Pure, so the activity log and any other screen share one wording.

/** Exact codes that come up in practice, in the words someone can act on. */
const KNOWN: Record<string, string> = {
  'x.1.1': 'The mailbox does not exist.',
  'x.1.2': 'The recipient’s domain does not exist or does not accept mail.',
  'x.1.3': 'The recipient address is malformed.',
  'x.1.10': 'The recipient’s domain does not accept mail (null MX).',
  'x.2.1': 'The mailbox is disabled.',
  'x.2.2': 'The mailbox is full.',
  'x.2.3': 'The message is too large for this mailbox.',
  'x.3.4': 'The message is too large for the receiving server.',
  'x.4.1': 'The receiving server did not answer.',
  'x.4.4': 'The recipient’s domain could not be routed to.',
  'x.4.7': 'Delivery timed out.',
  'x.7.0': 'The receiving server refused the message for a security or policy reason.',
  'x.7.1':
    'The receiving server refused the message by policy — usually it judged the sender untrusted or the content as spam, or the recipient blocks this sender.',
  'x.7.23': 'SPF check failed — the sending server is not authorised for this domain.',
  'x.7.25': 'The sending server has no valid reverse DNS.',
  'x.7.26': 'Authentication failed (SPF/DKIM/DMARC) — the receiving server could not verify the sender.',
  'x.7.27': 'The sender’s domain does not accept mail (null MX), so replies would be impossible.',
};

/** Fallback by the middle digit when the exact code is not listed. */
const SUBJECT: Record<string, string> = {
  '1': 'There is a problem with the recipient address.',
  '2': 'There is a problem with the recipient’s mailbox.',
  '3': 'The receiving mail system has a problem.',
  '4': 'There was a network or routing problem.',
  '5': 'There was a mail-protocol problem.',
  '6': 'There is a problem with the message content.',
  '7': 'The message was refused for a security or policy reason.',
};

export interface DeliveryStatusMeaning {
  /** The code as given, e.g. '5.7.1'. */
  readonly code: string;
  /** Permanent (5.x.x) failures suppress the address; transient (4.x.x) are retried. */
  readonly permanent: boolean;
  readonly meaning: string;
}

/** Null when `code` is not an enhanced status code. Never throws. */
export function describeDeliveryStatus(code: string | null | undefined): DeliveryStatusMeaning | null {
  const m = /^([245])\.(\d{1,3})\.(\d{1,3})$/.exec((code ?? '').trim());
  if (!m) return null;
  const [, cls, subject, detail] = m;
  if (cls === '2') return { code: code!.trim(), permanent: false, meaning: 'Delivered.' };
  const meaning =
    KNOWN[`x.${subject}.${detail}`] ?? SUBJECT[subject!] ?? 'The receiving server reported a delivery problem.';
  return { code: code!.trim(), permanent: cls === '5', meaning };
}
