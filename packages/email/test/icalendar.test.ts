// The two things that silently ruin a calendar invite: unescaped text and unfolded
// lines. Both corrupt the file in ways that look fine in a diff and fail in Outlook.
import { describe, it, expect } from 'vitest';
import { buildIcs, escapeIcsText, foldIcsLine, icsDateTime } from '../src/icalendar.js';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const base = {
  summary: 'Intro call',
  start: new Date('2026-10-12T13:00:00.000Z'),
  end: new Date('2026-10-12T13:30:00.000Z'),
  organizer: { email: 'hello@acme.com', name: 'Acme' },
  attendees: [{ email: 'jane@example.com', name: 'Jane' }],
};

describe('escapeIcsText', () => {
  // A comma is structural in iCalendar: unescaped, everything after it is dropped.
  it('escapes the characters that would truncate a value', () => {
    expect(escapeIcsText('Review, then lunch')).toBe('Review\\, then lunch');
    expect(escapeIcsText('a;b')).toBe('a\\;b');
    expect(escapeIcsText('line1\nline2')).toBe('line1\\nline2');
  });

  // Backslash must be escaped FIRST or the escaping escapes itself.
  it('does not double-escape its own backslashes', () => {
    expect(escapeIcsText('a\\b')).toBe('a\\\\b');
    expect(escapeIcsText('a,b')).not.toContain('\\\\');
  });
});

describe('foldIcsLine', () => {
  it('leaves a short line alone', () => {
    expect(foldIcsLine('SUMMARY:hi')).toBe('SUMMARY:hi');
  });

  it('folds past 75 octets with a leading space on continuations', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'x'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.length).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) {
      expect(p.startsWith(' ')).toBe(true);
      expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop CRLF + one space) restores the original exactly.
    expect(folded.split('\r\n ').join('')).toBe(`DESCRIPTION:${'x'.repeat(200)}`);
  });

  // Hebrew is two octets per character: folding on CHARACTER count leaves lines
  // that are still over the limit, and splitting mid-character corrupts them.
  it('measures octets, and never splits a multi-byte character', () => {
    const hebrew = 'פגישה'.repeat(40);
    for (const p of foldIcsLine(`SUMMARY:${hebrew}`).split('\r\n')) {
      expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(foldIcsLine(`SUMMARY:${hebrew}`).split('\r\n ').join('')).toBe(`SUMMARY:${hebrew}`);
  });
});

describe('buildIcs', () => {
  const ics = buildIcs(base, NOW);

  it('produces a valid VCALENDAR with the event bracketed', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('VERSION:2.0');
  });

  it('writes times as UTC instants', () => {
    expect(icsDateTime(NOW)).toBe('20261008T090000Z');
    expect(ics).toContain('DTSTART:20261012T130000Z');
    expect(ics).toContain('DTEND:20261012T133000Z');
    expect(ics).toContain('DTSTAMP:20261008T090000Z');
  });

  // Gmail only offers Accept/Decline when the organizer is a real address and the
  // attendee is asked to reply.
  it('names the organizer and asks the attendee to RSVP', () => {
    const unfolded = ics.split('\r\n ').join('');
    expect(unfolded).toContain('ORGANIZER;CN=Acme:mailto:hello@acme.com');
    expect(unfolded).toContain(
      'ATTENDEE;CN=Jane;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:jane@example.com',
    );
  });

  it('defaults to a REQUEST that is CONFIRMED', () => {
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('SEQUENCE:0');
  });

  // A cancellation without STATUS:CANCELLED leaves the meeting sitting in the
  // invitee's calendar in some clients — the worst outcome for a cancellation.
  it('marks a cancellation CANCELLED, not merely METHOD:CANCEL', () => {
    const cancelled = buildIcs({ ...base, method: 'CANCEL', uid: 'u-1', sequence: 2 }, NOW);
    expect(cancelled).toContain('METHOD:CANCEL');
    expect(cancelled).toContain('STATUS:CANCELLED');
    expect(cancelled).toContain('SEQUENCE:2');
    expect(cancelled).toContain('UID:u-1');
  });

  // Same uid + higher sequence is what makes a client REPLACE an invite rather
  // than show a second one.
  it('keeps the caller’s uid verbatim, and invents one only when absent', () => {
    expect(buildIcs({ ...base, uid: 'booking-42' }, NOW)).toContain('UID:booking-42');
    expect(buildIcs(base, NOW)).toMatch(/UID:.+/);
  });

  it('escapes and folds the text fields it was given', () => {
    const out = buildIcs({ ...base, summary: 'Review, then lunch', description: 'x'.repeat(200) }, NOW);
    expect(out).toContain('SUMMARY:Review\\, then lunch');
    for (const line of out.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('omits optional properties rather than emitting empty ones', () => {
    expect(ics).not.toContain('DESCRIPTION:');
    expect(ics).not.toContain('LOCATION:');
    expect(ics).not.toContain('URL:');
    const full = buildIcs({ ...base, location: 'Tel Aviv', url: 'https://meet.example/x' }, NOW);
    expect(full).toContain('LOCATION:Tel Aviv');
    expect(full).toContain('URL:https://meet.example/x');
  });
});
