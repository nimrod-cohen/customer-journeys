// The pure rules for a `calendar` block on POST /v1/send.
//
// Everything here is a refusal that prevents a send which would LOOK successful and
// quietly do the wrong thing to someone's calendar: a meeting at an ambiguous hour, a
// cancellation that cancels nothing, a meeting whose length we invented.
import { describe, it, expect } from 'vitest';
import { parseCalendar, parseTransactionalRequest } from '../src/transactional-send.js';

const okBlock = {
  title: 'Intro call',
  start: '2026-10-12T13:00:00Z',
  end: '2026-10-12T13:30:00Z',
};
const parse = (c: unknown) => parseCalendar(c);
const err = (c: unknown): string => {
  const r = parse(c);
  if (!('error' in r)) throw new Error('expected a refusal');
  return r.error;
};
const val = (c: unknown) => {
  const r = parse(c);
  if ('error' in r) throw new Error(`unexpected refusal: ${r.error}`);
  return r.calendar!;
};

describe('parseCalendar', () => {
  it('is absent by default — an ordinary send carries no invite', () => {
    expect(parse(undefined)).toEqual({ calendar: null });
    expect(parse(null)).toEqual({ calendar: null });
  });

  it('accepts a minimal invite and defaults method and sequence', () => {
    const c = val(okBlock);
    expect(c.method).toBe('REQUEST');
    expect(c.sequence).toBe(0);
    expect(c.summary).toBe('Intro call');
    expect(c.start.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(c.end.toISOString()).toBe('2026-10-12T13:30:00.000Z');
  });

  // A bare wall clock means a different instant to the caller, to us and to the
  // invitee's client. Nobody notices until the meeting is missed.
  it('refuses a time with no timezone, and says what to send instead', () => {
    const e = err({ ...okBlock, start: '2026-10-12T13:00:00' });
    expect(e).toMatch(/timezone/i);
    expect(e).toMatch(/Z|\+03:00/);
    expect(val({ ...okBlock, start: '2026-10-12T16:00:00+03:00' }).start.toISOString()).toBe('2026-10-12T13:00:00.000Z');
  });

  it('refuses an unparseable date', () => {
    expect(err({ ...okBlock, start: 'next tuesday' })).toMatch(/not a valid date/i);
  });

  // Picking a length for the caller would put a meeting of OUR choosing in someone's
  // calendar.
  it('requires an end or a duration rather than inventing one', () => {
    expect(err({ title: 'x', start: okBlock.start })).toMatch(/'end'|duration_minutes/);
    expect(val({ ...okBlock, end: undefined, duration_minutes: 45 }).end.toISOString()).toBe('2026-10-12T13:45:00.000Z');
    expect(err({ ...okBlock, end: undefined, duration_minutes: 0 })).toMatch(/positive/);
  });

  it('refuses an end at or before the start', () => {
    expect(err({ ...okBlock, end: okBlock.start })).toMatch(/must be after/);
    expect(err({ ...okBlock, end: '2026-10-12T12:00:00Z' })).toMatch(/must be after/);
  });

  // A typo'd year reads as a valid date, so the only thing that catches it is span.
  it('refuses an absurd span', () => {
    expect(err({ ...okBlock, end: '2126-10-12T13:30:00Z' })).toMatch(/more than/);
  });

  // Sent with a fresh uid, a cancellation matches no meeting: the invitee keeps it and
  // the API still answers 200, so the sender believes it was called off.
  it('requires the original uid to cancel', () => {
    expect(err({ ...okBlock, method: 'cancel' })).toMatch(/uid.*required to cancel/i);
    expect(val({ ...okBlock, method: 'cancel', uid: 'booking-42' }).method).toBe('CANCEL');
  });

  it('takes method case-insensitively and refuses anything else', () => {
    expect(val({ ...okBlock, method: 'request' }).method).toBe('REQUEST');
    expect(err({ ...okBlock, method: 'reschedule' })).toMatch(/'request' or 'cancel'/);
  });

  it('keeps uid and sequence, which is what makes an update replace the invite', () => {
    const c = val({ ...okBlock, uid: 'booking-42', sequence: 3 });
    expect(c.uid).toBe('booking-42');
    expect(c.sequence).toBe(3);
    expect(err({ ...okBlock, sequence: -1 })).toMatch(/0 or more/);
  });

  it('validates the organizer address and the meeting url', () => {
    expect(val({ ...okBlock, organizer: { email: 'host@acme.com', name: 'Acme' } }).organizer).toEqual({
      email: 'host@acme.com',
      name: 'Acme',
    });
    expect(err({ ...okBlock, organizer: { email: 'not-an-address' } })).toMatch(/not a valid email/);
    expect(err({ ...okBlock, url: 'javascript:alert(1)' })).toMatch(/http\(s\)/);
    expect(val({ ...okBlock, url: 'https://meet.example/x' }).url).toBe('https://meet.example/x');
  });

  // The title is the one field worth defaulting: the subject is nearly always right,
  // and it is already rendered by the time the ICS is built.
  it('leaves the title empty when none is given, to fall back to the subject', () => {
    expect(val({ start: okBlock.start, end: okBlock.end }).summary).toBe('');
  });

  it('keeps merge tags unrendered, since rendering is per recipient', () => {
    expect(val({ ...okBlock, title: 'Call with {{customer.first_name}}' }).summary).toBe(
      'Call with {{customer.first_name}}',
    );
  });

  it('refuses a non-object', () => {
    expect(err('tomorrow at 3')).toMatch(/must be an object/);
    expect(err([okBlock])).toMatch(/must be an object/);
  });
});

describe('parseTransactionalRequest with a calendar', () => {
  it('carries the invite onto the parsed request', () => {
    const r = parseTransactionalRequest({ template: 'booking', to: 'a@b.com', calendar: okBlock });
    expect('error' in r).toBe(false);
    expect((r as { calendar: { summary: string } }).calendar.summary).toBe('Intro call');
  });

  it('is null when the caller sends no calendar', () => {
    const r = parseTransactionalRequest({ template: 'otp', to: 'a@b.com' });
    expect((r as { calendar: null }).calendar).toBeNull();
  });

  // The refusal must surface from the request parser, not be swallowed into a send.
  it('fails the whole request when the invite is invalid', () => {
    const r = parseTransactionalRequest({ template: 'booking', to: 'a@b.com', calendar: { title: 'x' } });
    expect((r as { error: string }).error).toMatch(/calendar/);
  });
});
