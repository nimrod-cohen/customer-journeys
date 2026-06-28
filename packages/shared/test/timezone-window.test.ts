// Workspace-tz hour-of-day window math (§9B). The runner parks an enrollment on an
// hour_of_day_window node until the next allowed window OPENING in the WORKSPACE
// timezone — DST-correct, reusing the same zoned↔UTC two-pass helpers the
// broadcast scheduler uses. These tests LOCK the exact UTC instants so the
// extraction stays behavior-preserving and DST-correct.
import { describe, it, expect } from 'vitest';
import {
  nextWindowOpening,
  isWindowOpen,
  zonedComponents,
  zonedInputToUtcIso,
} from '../src/timezone.js';

const NY = 'America/New_York';
const JM = 'Asia/Jerusalem';

describe('zonedComponents', () => {
  it('reads ws-local wall-clock parts (DST-aware)', () => {
    // 2026-07-15T12:00Z in NY (EDT, -4) is 08:00 local, a Wednesday (weekday 3).
    const c = zonedComponents(new Date('2026-07-15T12:00:00.000Z'), NY);
    expect(c.year).toBe(2026);
    expect(c.month).toBe(7);
    expect(c.day).toBe(15);
    expect(c.hour).toBe(8);
    expect(c.minute).toBe(0);
    expect(c.weekday).toBe(3);
  });
  it('UTC is the identity zone', () => {
    const c = zonedComponents(new Date('2026-06-19T05:30:00.000Z'), 'UTC');
    expect(c).toMatchObject({ year: 2026, month: 6, day: 19, hour: 5, minute: 30 });
  });
});

describe('nextWindowOpening — same-day window (9..17)', () => {
  const win = { startHour: 9, endHour: 17 };
  it('returns null when already inside (12:00 ws-local)', () => {
    // 2026-06-19 12:00 NY (EDT -4) == 16:00Z.
    expect(nextWindowOpening(new Date('2026-06-19T16:00:00.000Z'), win, NY)).toBeNull();
  });
  it('before the window today (07:00 ws-local) → today 09:00 ws-local→UTC', () => {
    // 07:00 NY == 11:00Z. Opening today 09:00 NY.
    const got = nextWindowOpening(new Date('2026-06-19T11:00:00.000Z'), win, NY);
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-06-19T09:00', NY));
  });
  it('after the window today (19:00 ws-local) → tomorrow 09:00 ws-local→UTC', () => {
    // 19:00 NY == 23:00Z (same date). Opening tomorrow 09:00 NY.
    const got = nextWindowOpening(new Date('2026-06-19T23:00:00.000Z'), win, NY);
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-06-20T09:00', NY));
  });
  it('endHour is INCLUSIVE through :59 (17:30 inside; 18:00 outside)', () => {
    // 17:30 NY == 21:30Z → inside.
    expect(nextWindowOpening(new Date('2026-06-19T21:30:00.000Z'), win, NY)).toBeNull();
    // 18:00 NY == 22:00Z → outside → tomorrow 09:00.
    const got = nextWindowOpening(new Date('2026-06-19T22:00:00.000Z'), win, NY);
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-06-20T09:00', NY));
  });
});

describe('minute-of-day window (half-hours + EXCLUSIVE close; startMin/endMin canonical)', () => {
  it('"8pm to midnight" (endMin 1440 = exclusive midnight): 23:30 inside, 00:00 next day OUTSIDE', () => {
    // startMin/endMin take precedence over the (deliberately wrong) legacy hour fields.
    const win = { startHour: 0, endHour: 0, startMin: 1200, endMin: 1440 };
    expect(isWindowOpen(new Date('2026-06-19T20:00:00.000Z'), win, 'UTC')).toBe(true);
    expect(isWindowOpen(new Date('2026-06-19T23:30:00.000Z'), win, 'UTC')).toBe(true);
    expect(isWindowOpen(new Date('2026-06-20T00:00:00.000Z'), win, 'UTC')).toBe(false); // closed AT midnight
    expect(nextWindowOpening(new Date('2026-06-19T19:00:00.000Z'), win, 'UTC')?.toISOString()).toBe(zonedInputToUtcIso('2026-06-19T20:00', 'UTC'));
  });
  it('half-hour window 20:30–22:30 (exclusive): 20:00 out, 20:30 in, 22:00 in, 22:30 out; opens 20:30', () => {
    const win = { startHour: 0, endHour: 0, startMin: 1230, endMin: 1350 };
    expect(isWindowOpen(new Date('2026-06-19T20:00:00.000Z'), win, 'UTC')).toBe(false);
    expect(isWindowOpen(new Date('2026-06-19T20:30:00.000Z'), win, 'UTC')).toBe(true);
    expect(isWindowOpen(new Date('2026-06-19T22:00:00.000Z'), win, 'UTC')).toBe(true);
    expect(isWindowOpen(new Date('2026-06-19T22:30:00.000Z'), win, 'UTC')).toBe(false);
    expect(nextWindowOpening(new Date('2026-06-19T19:00:00.000Z'), win, 'UTC')?.toISOString()).toBe(zonedInputToUtcIso('2026-06-19T20:30', 'UTC'));
  });
  it('open === close ⇒ always open (24h); nextWindowOpening is null', () => {
    const win = { startHour: 0, endHour: 0, startMin: 720, endMin: 720 };
    expect(isWindowOpen(new Date('2026-06-19T03:00:00.000Z'), win, 'UTC')).toBe(true);
    expect(isWindowOpen(new Date('2026-06-19T15:00:00.000Z'), win, 'UTC')).toBe(true);
    expect(nextWindowOpening(new Date('2026-06-19T03:00:00.000Z'), win, 'UTC')).toBeNull();
  });
});

describe('nextWindowOpening — overnight window (22..6)', () => {
  const win = { startHour: 22, endHour: 6 };
  it('23:30 ws-local is inside → null', () => {
    // 23:30 NY == 03:30Z next day.
    expect(nextWindowOpening(new Date('2026-06-20T03:30:00.000Z'), win, NY)).toBeNull();
  });
  it('05:30 ws-local is inside → null', () => {
    // 05:30 NY == 09:30Z.
    expect(nextWindowOpening(new Date('2026-06-19T09:30:00.000Z'), win, NY)).toBeNull();
  });
  it('12:00 ws-local is outside → next opening today 22:00 ws-local→UTC', () => {
    // 12:00 NY == 16:00Z. Opening today 22:00 NY.
    const got = nextWindowOpening(new Date('2026-06-19T16:00:00.000Z'), win, NY);
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-06-19T22:00', NY));
  });
});

describe('nextWindowOpening — DST spring-forward', () => {
  // America/New_York springs forward 2026-03-08 (02:00→03:00, EST -5 → EDT -4).
  it('an opening on the spring-forward day uses the correct (post-transition) offset', () => {
    const win = { startHour: 9, endHour: 17 };
    // now = 2026-03-08 05:00 NY (well before 09:00). 05:00 on that day is already
    // EDT (-4) since the jump is at 02:00 → 05:00 NY == 09:00Z.
    const now = new Date('2026-03-08T09:00:00.000Z');
    const got = nextWindowOpening(now, win, NY);
    // 09:00 NY that day is EDT (-4) → 13:00Z. The naive winter guess (-5) would
    // give 14:00Z; the two-pass resolution must land on 13:00Z.
    expect(got?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-03-08T09:00', NY));
  });
});

describe('nextWindowOpening — DST fall-back', () => {
  // America/New_York falls back 2026-11-01 (02:00→01:00). A 09:00 opening that day
  // is unambiguous (well outside the repeated hour) and resolves to a single UTC.
  it('an opening on the fall-back day resolves to one unambiguous UTC instant', () => {
    const win = { startHour: 9, endHour: 17 };
    const now = new Date('2026-11-01T11:00:00.000Z'); // 06:00 NY (EST -5) before 09:00
    const got = nextWindowOpening(now, win, NY);
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-11-01T09:00', NY));
    // 09:00 NY in November is EST (-5) → 14:00Z.
    expect(got?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
});

describe('nextWindowOpening — daysOfWeek (keyed on the OPENING day)', () => {
  it('allowed only Mon/Wed [1,3]: Tue inside hour-range is NOT inside; next opening Wed', () => {
    const win = { startHour: 9, endHour: 17, daysOfWeek: [1, 3] };
    // 2026-06-23 is a Tuesday. 12:00 NY == 16:00Z.
    const tueNoon = new Date('2026-06-23T16:00:00.000Z');
    const got = nextWindowOpening(tueNoon, win, NY);
    // Next allowed opening is Wed 2026-06-24 09:00 NY.
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-06-24T09:00', NY));
  });
  it('allowed Mon/Wed: Mon inside hour-range → null (inside)', () => {
    const win = { startHour: 9, endHour: 17, daysOfWeek: [1, 3] };
    // 2026-06-22 is a Monday. 12:00 NY == 16:00Z.
    expect(nextWindowOpening(new Date('2026-06-22T16:00:00.000Z'), win, NY)).toBeNull();
  });
  it('overnight window day-membership keyed on the OPENING day', () => {
    // Window 22..6 allowed only on day 5 (Fri). At Sat 02:00 the window is "inside"
    // because it OPENED on Fri 22:00 — Friday is the allowed day.
    const win = { startHour: 22, endHour: 6, daysOfWeek: [5] };
    // 2026-06-20 is a Saturday. 02:00 NY == 06:00Z.
    const satEarly = new Date('2026-06-20T06:00:00.000Z');
    expect(nextWindowOpening(satEarly, win, NY)).toBeNull();
    // But Saturday 22:00 (opening on a Sat, not allowed) → next opening Fri 2026-06-26 22:00.
    // 2026-06-20 23:00 NY == 2026-06-21 03:00Z (Sat night, inside a Sat-opened window
    // which is NOT allowed) → next opening is next Friday.
    const satNight = new Date('2026-06-21T03:00:00.000Z'); // Sat 23:00 NY
    const got = nextWindowOpening(satNight, win, NY);
    expect(got?.toISOString()).toBe(zonedInputToUtcIso('2026-06-26T22:00', NY));
  });
});

describe('isWindowOpen', () => {
  it('is the boolean companion of nextWindowOpening', () => {
    const win = { startHour: 9, endHour: 17 };
    const inside = new Date('2026-06-19T16:00:00.000Z'); // 12:00 NY
    const outside = new Date('2026-06-19T11:00:00.000Z'); // 07:00 NY
    expect(isWindowOpen(inside, win, NY)).toBe(true);
    expect(nextWindowOpening(inside, win, NY)).toBeNull();
    expect(isWindowOpen(outside, win, NY)).toBe(false);
    expect(nextWindowOpening(outside, win, NY)).not.toBeNull();
  });
  it('no daysOfWeek treats every day as allowed', () => {
    const win = { startHour: 0, endHour: 23 };
    // any instant is inside a 0..23 all-week window.
    expect(isWindowOpen(new Date('2026-06-23T16:00:00.000Z'), win, JM)).toBe(true);
  });
});

describe('tz shifts the boundary (not hard-coded UTC)', () => {
  it('the same wall-clock window opens at DIFFERENT UTC instants per tz', () => {
    const win = { startHour: 9, endHour: 17 };
    // now = 2026-06-19 00:00Z. Before 09:00 in both NY and Jerusalem.
    const now = new Date('2026-06-19T00:00:00.000Z');
    const ny = nextWindowOpening(now, win, NY);
    const jm = nextWindowOpening(now, win, JM);
    expect(ny?.toISOString()).toBe(zonedInputToUtcIso('2026-06-19T09:00', NY));
    expect(jm?.toISOString()).toBe(zonedInputToUtcIso('2026-06-19T09:00', JM));
    expect(ny?.toISOString()).not.toBe(jm?.toISOString());
  });
});
