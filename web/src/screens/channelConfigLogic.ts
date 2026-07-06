// Pure validation for the 019 SMS "source" (sender ID) — extracted so it can be
// unit-tested without the React screen. An ALPHANUMERIC sender is capped at 11 chars
// (GSM standard; 019 rejects a longer one with error 992) and must be letters/digits
// only. A purely NUMERIC source is a phone number and isn't bound by the 11-char rule.

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
