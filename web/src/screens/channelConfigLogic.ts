// Pure validation for the 019 SMS "source" (sender ID) — extracted so it can be
// unit-tested without the React screen. An ALPHANUMERIC sender is capped at 11 chars
// (GSM standard; 019 rejects a longer one with error 992) and must be letters/digits
// only. A purely NUMERIC source is a phone number and isn't bound by the 11-char rule.

/**
 * Curated 019 SMS send/config error codes (from docs.019sms.co.il) with a plain
 * meaning and an actionable fix — the ones a workspace admin actually hits when
 * configuring or sending. (The full DLR/status table lives in 019's docs.)
 */
export const SMS_019_ERRORS: ReadonlyArray<{ code: string; meaning: string; fix: string }> = [
  { code: '0', meaning: 'Success — the message was accepted for sending.', fix: 'Nothing to do.' },
  {
    code: '3 / 10 / 11 / 504',
    meaning: 'Authentication failed — wrong/expired API token, or it doesn’t match the username.',
    fix: 'Make sure the Username and Bearer (API token) belong to the SAME 019 account. Regenerate the token in your 019 portal if expired, then re-save here.',
  },
  {
    code: '4 / 12',
    meaning: 'Not enough credit in the 019 account.',
    fix: 'Top up your 019 SMS balance.',
  },
  {
    code: '5',
    meaning: 'Not allowed to send right now (account permission or sending-hours restriction).',
    fix: 'Check your 019 account’s sending permissions / allowed hours.',
  },
  {
    code: '8 / 715',
    meaning: 'All recipients are on 019’s block list (opted out or blacklisted at 019).',
    fix: 'These numbers are blocked at the 019 level — nothing to change in the app.',
  },
  {
    code: '9 / 933',
    meaning: 'A destination phone number is too short/long or invalid.',
    fix: 'Use valid numbers (E.164, e.g. +97252…). Set the Default country so local numbers get normalized.',
  },
  {
    code: '515',
    meaning: 'Unverified source — the sender name isn’t approved for this 019 account.',
    fix: 'Register/verify the sender in your 019 portal (approval is per-account), or switch to a sender that’s already approved / the 019 account where it is.',
  },
  {
    code: '989',
    meaning: 'The message body is too long or too short.',
    fix: 'Adjust the message text length.',
  },
  {
    code: '992',
    meaning: 'The source (sender ID) is too long or too short.',
    fix: 'Use an alphanumeric sender of ≤ 11 letters/digits with no spaces, or a valid phone number.',
  },
  {
    code: '998 / 999',
    meaning: 'Unknown error on 019’s side.',
    fix: 'Retry; if it keeps happening, contact 019 support.',
  },
];

/** Returns a human warning string for an invalid 019 source, or null when it's fine. */
export function sourceWarning(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^\+?\d+$/.test(v)) return null; // numeric (phone-number) sender — 11-char rule doesn't apply
  if (v.length > 11) {
    return `Alphanumeric sender IDs are limited to 11 characters — this is ${v.length}. 019 will reject a longer source (error 992).`;
  }
  if (!/^[A-Za-z0-9]+$/.test(v)) {
    return 'Alphanumeric sender IDs should be letters and digits only — no spaces or symbols.';
  }
  return null;
}
