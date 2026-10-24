import { describe, it, expect } from 'vitest';
import { parseSse, buildThread, mergeMessages, ticksFor, sourceLabel, fallbackText, fillTemplateBody, windowLabel, windowOpen, dayLabel, type ChatMessage } from './logic.js';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'm',
  direction: 'in',
  type: 'text',
  body: 'hi',
  media: null,
  template: null,
  status: 'received',
  error: null,
  broadcast_id: null,
  broadcast_name: null,
  automation_id: null,
  automation_name: null,
  sent_by_name: null,
  sent_by_email: null,
  created_at: '2026-10-19T10:00:00Z',
  ...over,
});

describe('parseSse', () => {
  it('splits complete events and keeps the unfinished tail', () => {
    const r = parseSse('event: ready\ndata: {}\n\n: keep-alive\n\nevent: message\ndata: {"a":1}\n\nevent: sta');
    expect(r.events).toEqual([
      { event: 'ready', data: '{}' },
      { event: 'message', data: '{"a":1}' },
    ]);
    expect(r.rest).toBe('event: sta');
  });
  it('handles CRLF and multi-line data', () => {
    expect(parseSse('data: a\r\ndata: b\r\n\r\n').events).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});

describe('buildThread', () => {
  it('inserts a day separator before each new day', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const items = buildThread(
      [
        msg({ id: '1', created_at: '2026-10-18T09:00:00Z' }),
        msg({ id: '2', created_at: '2026-10-18T10:00:00Z' }),
        msg({ id: '3', created_at: '2026-10-19T09:00:00Z' }),
      ],
      now,
      'UTC',
    );
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.message.id))).toEqual(['Yesterday', '1', '2', 'Today', '3']);
  });
  it('labels older days with a date', () => {
    expect(dayLabel('2026-10-01T09:00:00Z', new Date('2026-10-19T12:00:00Z'), 'UTC')).toMatch(/2026/);
  });
});

describe('mergeMessages', () => {
  it('dedupes by id (newer copy wins) and sorts oldest first', () => {
    const a = msg({ id: 'a', created_at: '2026-10-19T10:00:00Z', status: 'sent', direction: 'out' });
    const b = msg({ id: 'b', created_at: '2026-10-19T09:00:00Z' });
    const merged = mergeMessages([a], [b, { ...a, status: 'read' }]);
    expect(merged.map((m) => [m.id, m.status])).toEqual([
      ['b', 'received'],
      ['a', 'read'],
    ]);
  });
});

describe('bubble helpers', () => {
  it('ticks follow WhatsApp', () => {
    expect(ticksFor('sent')?.glyph).toBe('✓');
    expect(ticksFor('delivered')).toMatchObject({ glyph: '✓✓', read: false });
    expect(ticksFor('read')).toMatchObject({ glyph: '✓✓', read: true });
    expect(ticksFor('received')).toBeNull();
    expect(ticksFor('failed')).toBeNull();
  });
  it('labels where an outbound message came from', () => {
    expect(sourceLabel(msg({ direction: 'out', broadcast_id: 'b', broadcast_name: 'Oct sale' }))).toBe('Broadcast · Oct sale');
    expect(sourceLabel(msg({ direction: 'out', automation_id: 'a', automation_name: null }))).toBe('Automation · deleted');
    expect(sourceLabel(msg({ direction: 'out', sent_by_name: 'Nimrod' }))).toBe('Nimrod');
    expect(sourceLabel(msg({ direction: 'in' }))).toBeNull();
  });
  it('gives body-less messages a readable text', () => {
    expect(fallbackText(msg({ template: { name: 'order_update', language: 'en', params: ['Ada'] } }))).toBe('Template: order_update (Ada)');
    expect(fallbackText(msg({ type: 'document', media: { mime_type: 'application/pdf', filename: 'inv.pdf', stored: true, failed: false } }))).toBe('inv.pdf');
    expect(fallbackText(msg({ type: 'audio' }))).toBe('Voice message');
  });
});

describe('24h window', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  it('counts down the time left', () => {
    expect(windowLabel('2026-10-19T15:12:00Z', now)).toBe('3h 12m');
    expect(windowLabel('2026-10-19T12:05:00Z', now)).toBe('5m');
    expect(windowLabel('2026-10-19T11:00:00Z', now)).toBeNull();
    expect(windowLabel(null, now)).toBeNull();
  });
  it('is open only before it closes', () => {
    expect(windowOpen('2026-10-19T12:00:01Z', now)).toBe(true);
    expect(windowOpen('2026-10-19T12:00:00Z', now)).toBe(false);
    expect(windowOpen(null, now)).toBe(false);
  });
});

describe('fillTemplateBody', () => {
  // A template send stores only the template name and its values; the chat should
  // show what the customer actually received.
  it('puts each value in its numbered placeholder', () => {
    expect(fillTemplateBody('Hi {{1}}, order {{2}} ships at {{3}}.', ['nimrod', '123423', '10:40'])).toBe(
      'Hi nimrod, order 123423 ships at 10:40.',
    );
  });

  it('fills a placeholder used twice, and tolerates spaces inside the braces', () => {
    expect(fillTemplateBody('{{1}} / {{ 1 }}', ['x'])).toBe('x / x');
  });

  // A missing value is left visible rather than silently dropped.
  it('leaves a placeholder that has no value as it is', () => {
    expect(fillTemplateBody('Hi {{1}}, see {{2}}', ['dana'])).toBe('Hi dana, see {{2}}');
  });
});
