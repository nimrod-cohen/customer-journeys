// iCalendar (RFC 5545) generation for meeting invites sent as email.
//
// An invite a mail client RECOGNISES — one that shows Accept / Decline rather than
// a file to download — is a `text/calendar; method=REQUEST` part sitting in a
// `multipart/alternative` beside the HTML body. The same bytes delivered as an
// attachment are just a file. That distinction lives in the transport
// (`buildMimeMessage`); this module's only job is to produce bytes that are
// actually valid, which in practice comes down to two things everybody gets wrong:
//
//   - ESCAPING. A comma, semicolon or backslash in a summary or location is
//     structural in iCalendar. An unescaped one silently truncates the field, so a
//     meeting called "Review, then lunch" loses everything from the comma.
//   - FOLDING. A content line may not exceed 75 OCTETS; longer lines must be split
//     with a CRLF + one leading space. Clients differ in how they cope — some
//     tolerate it, Outlook drops the property — and a long description is the
//     common case, not an edge case.

/** Who is organising, or being invited. */
export interface CalendarPerson {
  readonly email: string;
  readonly name?: string | undefined;
}

/** The meeting itself. Times are absolute instants; see `icsDateTime`. */
export interface CalendarEvent {
  /**
   * Stable identity across updates and cancellations — the SAME uid, with a higher
   * `sequence`, is what makes a client replace an invite rather than show a second
   * one. Generated when absent, which is correct only for a one-off invite that
   * will never be changed.
   */
  readonly uid?: string | undefined;
  readonly method?: 'REQUEST' | 'CANCEL' | undefined;
  /** Bumped on every revision of the same uid. A client ignores a lower one. */
  readonly sequence?: number | undefined;
  readonly summary: string;
  readonly start: Date;
  readonly end: Date;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  /** A joining link. Clients surface it as the meeting URL. */
  readonly url?: string | undefined;
  readonly organizer: CalendarPerson;
  readonly attendees?: readonly CalendarPerson[];
}

/**
 * Escape a TEXT value (RFC 5545 §3.3.11). Backslash FIRST, or the backslashes this
 * adds get escaped again and the value arrives full of `\\`.
 */
export function escapeIcsText(v: string): string {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line to 75 octets per RFC 5545 §3.1.
 *
 * Measured in OCTETS, not characters: a Hebrew or emoji summary is multi-byte, so
 * folding on character count produces lines that are still too long. A multi-byte
 * character is never split across the fold, which would corrupt it.
 */
export function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  // The continuation lines carry a leading space, so they have one octet less room.
  for (const ch of line) {
    const size = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current) out.push(current);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n');
}

/** `YYYYMMDDTHHMMSSZ` — UTC, which every client renders in the viewer's own zone. */
export function icsDateTime(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

function person(prop: 'ORGANIZER' | 'ATTENDEE', p: CalendarPerson, extra = ''): string {
  const cn = p.name ? `;CN=${escapeIcsText(p.name)}` : '';
  return `${prop}${cn}${extra}:mailto:${p.email}`;
}

/**
 * Build the .ics body for one meeting.
 *
 * `METHOD:CANCEL` additionally sets `STATUS:CANCELLED` — a cancellation that omits
 * it leaves the event sitting in the invitee's calendar in some clients, which is
 * the worst possible outcome for a cancellation.
 */
export function buildIcs(event: CalendarEvent, now: Date = new Date()): string {
  const method = event.method ?? 'REQUEST';
  const uid = event.uid?.trim() || `${now.getTime()}-${Math.random().toString(36).slice(2)}@cdp`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//on-grow//journeys//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDateTime(now)}`,
    `DTSTART:${icsDateTime(event.start)}`,
    `DTEND:${icsDateTime(event.end)}`,
    `SEQUENCE:${Math.max(0, Math.floor(event.sequence ?? 0))}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    ...(event.description ? [`DESCRIPTION:${escapeIcsText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeIcsText(event.location)}`] : []),
    ...(event.url ? [`URL:${event.url}`] : []),
    // Gmail only offers RSVP when the organizer is a real address on the message.
    person('ORGANIZER', event.organizer),
    ...(event.attendees ?? []).map((a) =>
      person('ATTENDEE', a, ';ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE'),
    ),
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/**
 * The attachment list to hand a transport that cannot compose MIME itself.
 *
 * SES's Simple content and Resend's JSON body both take files and nothing else, so
 * an invite sent through either arrives as an `.ics` FILE. Most clients still read
 * the METHOD out of the file and offer to add the event, but the inline RSVP buttons
 * belong to the `multipart/alternative` shape that only our own SMTP transport can
 * build. The content type keeps `method=` for the clients that do look at it.
 */
export function attachmentsWithCalendar(input: {
  readonly attachments?: readonly { filename: string; contentType: string; content: string }[];
  readonly calendar?: { readonly ics: string; readonly method: string; readonly filename?: string };
}): readonly { filename: string; contentType: string; content: string }[] {
  const files = input.attachments ?? [];
  if (!input.calendar) return files;
  return [
    ...files,
    {
      filename: input.calendar.filename ?? 'invite.ics',
      contentType: `text/calendar; method=${input.calendar.method}`,
      content: Buffer.from(input.calendar.ics, 'utf8').toString('base64'),
    },
  ];
}
