// Pure helpers for the WhatsApp inbox (no I/O, unit-tested).

export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  type: string;
  body: string | null;
  media: { mime_type: string | null; filename: string | null; stored: boolean; failed: boolean } | null;
  template: { name: string; language: string; params: string[] } | null;
  status: 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  error: { code: number | null; title: string | null; message: string | null } | null;
  broadcast_id: string | null;
  broadcast_name: string | null;
  automation_id: string | null;
  automation_name: string | null;
  sent_by_name: string | null;
  sent_by_email: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  profile_id: string | null;
  wa_phone: string;
  display_name: string;
  contact_name: string | null;
  profile_email: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  window_open: boolean;
  window_closes_at: string | null;
}

// ── Server-sent events ──────────────────────────────────────────────────────

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Split a growing SSE text buffer into complete events + the unfinished tail.
 * Events end with a blank line; `:` lines are comments (keep-alives).
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length || event !== 'message') events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

// ── Thread rendering ────────────────────────────────────────────────────────

/** Local calendar-day key for grouping (YYYY-MM-DD in the viewer's zone). */
export function dayKey(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** "Today" / "Yesterday" / a date, like WhatsApp's day separators. */
export function dayLabel(iso: string, now: Date = new Date(), timeZone?: string): string {
  const k = dayKey(iso, timeZone);
  if (k === dayKey(now.toISOString(), timeZone)) return 'Today';
  if (k === dayKey(new Date(now.getTime() - 86_400_000).toISOString(), timeZone)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

export type ThreadItem = { kind: 'day'; key: string; label: string } | { kind: 'message'; message: ChatMessage };

/** Oldest-first messages with a day separator before each new day. */
export function buildThread(oldestFirst: ChatMessage[], now: Date = new Date(), timeZone?: string): ThreadItem[] {
  const out: ThreadItem[] = [];
  let last = '';
  for (const m of oldestFirst) {
    const k = dayKey(m.created_at, timeZone);
    if (k !== last) {
      out.push({ kind: 'day', key: k, label: dayLabel(m.created_at, now, timeZone) });
      last = k;
    }
    out.push({ kind: 'message', message: m });
  }
  return out;
}

/** Merge a fetched page into the loaded set by id (newer copies win), oldest first. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** The delivery ticks shown on an outbound bubble. */
export function ticksFor(status: ChatMessage['status']): { glyph: string; read: boolean; label: string } | null {
  switch (status) {
    case 'pending':
      return { glyph: '🕓', read: false, label: 'Sending' };
    case 'sent':
      return { glyph: '✓', read: false, label: 'Sent' };
    case 'delivered':
      return { glyph: '✓✓', read: false, label: 'Delivered' };
    case 'read':
      return { glyph: '✓✓', read: true, label: 'Read' };
    default:
      return null;
  }
}

/** Where an outbound message came from, for the small label above it. */
export function sourceLabel(m: ChatMessage): string | null {
  if (m.direction !== 'out') return null;
  if (m.broadcast_id) return `Broadcast · ${m.broadcast_name ?? 'deleted'}`;
  if (m.automation_id) return `Automation · ${m.automation_name ?? 'deleted'}`;
  if (m.sent_by_name || m.sent_by_email) return m.sent_by_name ?? m.sent_by_email;
  return null;
}

/**
 * A template's text as the customer received it: each `{{n}}` replaced by the n-th
 * value that was sent. A placeholder with no value stays visible, so a gap shows.
 */
export function fillTemplateBody(body: string, params: readonly string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

/** The text a bubble shows when it has no body of its own. */
export function fallbackText(m: ChatMessage): string {
  if (m.template) return `Template: ${m.template.name}${m.template.params.length ? ` (${m.template.params.join(', ')})` : ''}`;
  switch (m.type) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Voice message';
    case 'document':
      return m.media?.filename ?? 'Document';
    case 'sticker':
      return 'Sticker';
    case 'unsupported':
      return 'This message type isn’t supported by WhatsApp’s API.';
    default:
      return '';
  }
}

/** "Replies allowed for 3h 12m more" — the 24h customer-service window. */
export function windowLabel(closesAt: string | null, now: Date = new Date()): string | null {
  if (!closesAt) return null;
  const ms = new Date(closesAt).getTime() - now.getTime();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Is the 24h window still open right now (the server's flag can be stale). */
export function windowOpen(closesAt: string | null, now: Date = new Date()): boolean {
  return !!closesAt && new Date(closesAt).getTime() > now.getTime();
}
