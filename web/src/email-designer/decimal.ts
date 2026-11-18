// Line height is a decimal multiplier (1.4). A browser NUMBER input fights that: a
// field without a `step` treats 1.4 as invalid and its arrows jump 1 → 2, and a
// keyboard set to a comma decimal types "1,4", which a number input rejects. So the
// line-height fields are text fields with a decimal keypad, read through this.

/** "1.4" / "1,4" → 1.4, clamped to 1–3; blank or junk → undefined (the default). */
export function parseLineHeight(raw: string): number | undefined {
  const s = raw.trim().replace(',', '.');
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(3, Math.max(1, n));
}

/** "12" (or "12.4") → 12 px, 0–60; blank or junk → undefined (the default). */
export function parseParagraphSpacing(raw: string): number | undefined {
  const s = raw.trim().replace(',', '.');
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(60, Math.max(0, Math.round(n)));
}
