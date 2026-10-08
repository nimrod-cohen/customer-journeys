// Turning the HTML body into the plain-text alternative, and making non-ASCII
// headers legal.
//
// Both exist for deliverability. An HTML-only message is a long-standing spam
// signal — every real mail client sends `multipart/alternative`, and filters notice
// when something does not. And a header is specified as ASCII: a Hebrew subject
// written as raw UTF-8 bytes is a protocol violation that costs spam points and
// renders as mojibake in the clients that do not guess.

/** Entities common enough in compiled MJML that leaving them raw looks broken. */
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
];

/**
 * A readable plain-text rendering of an HTML email body.
 *
 * Not a general HTML-to-text engine: it only has to produce something a person can
 * read in a client that shows the text part, and something a filter can see is real
 * content. A link keeps its URL in parentheses — dropping it would leave a text part
 * telling the reader to "click here" with nothing to click.
 */
export function htmlToPlainText(html: string): string {
  let out = String(html ?? '');
  out = out.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // A link becomes "text (url)" — unless the text already IS the url.
  out = out.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, '').trim();
    if (!label) return href;
    return label === href ? label : `${label} (${href})`;
  });
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|tr|h[1-6]|li|table|section)\s*>/gi, '\n');
  out = out.replace(/<li\b[^>]*>/gi, '- ');
  out = out.replace(/<[^>]+>/g, '');
  for (const [re, ch] of ENTITIES) out = out.replace(re, ch);
  // Collapse the runs of blank lines that stripping a table layout leaves behind.
  out = out
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** Whether a string is safe to put in a header without encoding. */
export function isAsciiHeader(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[^\x20-\x7e]/.test(v);
}

/**
 * RFC 2047 encode one header value, as base64 encoded-words.
 *
 * Chunked so no encoded-word exceeds the 75-character limit, and split on CHARACTER
 * boundaries — a multi-byte character cut across two words decodes to replacement
 * characters, which is how a Hebrew subject turns into question marks.
 */
export function encodeHeaderWord(value: string): string {
  const v = String(value ?? '');
  if (!v || isAsciiHeader(v)) return v;
  // 75 total minus `=?UTF-8?B?` (10) and `?=` (2) leaves 63 base64 chars, and base64
  // must be taken in whole 4-char groups → 60 chars ≙ 45 input octets.
  const MAX_OCTETS = 45;
  const enc = new TextEncoder();
  const words: string[] = [];
  let buf = '';
  let bytes = 0;
  for (const ch of v) {
    const size = enc.encode(ch).length;
    if (bytes + size > MAX_OCTETS) {
      words.push(buf);
      buf = '';
      bytes = 0;
    }
    buf += ch;
    bytes += size;
  }
  if (buf) words.push(buf);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/**
 * Encode an address header, leaving the ADDRESS alone.
 *
 * `תלמידים פלוס <noreply@x.com>` must become `=?UTF-8?B?…?= <noreply@x.com>`:
 * encoding the whole string would produce an encoded-word where a mailbox belongs,
 * and the message would be unroutable.
 */
export function encodeAddressHeader(value: string): string {
  const v = String(value ?? '').trim();
  const m = /^(.*?)\s*<\s*([^<>\s]+)\s*>$/.exec(v);
  if (!m) return isAsciiHeader(v) ? v : encodeHeaderWord(v);
  const name = m[1]!.trim().replace(/^"(.*)"$/, '$1');
  if (!name) return `<${m[2]!}>`;
  if (!isAsciiHeader(name)) return `${encodeHeaderWord(name)} <${m[2]!}>`;
  // Quote ONLY a name containing a special, which is what every other mailer does —
  // quoting every display name would needlessly rewrite headers that were correct.
  const needsQuotes = /[(),.:;<>@\[\]\\"]/.test(name);
  return `${needsQuotes ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name} <${m[2]!}>`;
}
