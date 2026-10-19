// Live WhatsApp updates for the inbox and the profile tab.
//
// The server streams one event per conversation change (ids only) over SSE. It is
// read with an authenticated fetch — EventSource cannot send the bearer token —
// and reconnects with backoff. A slow poll runs underneath regardless: if the
// stream is down, or the server's LISTEN connection sits behind a pooler that never
// delivers notifications (a silent failure), the screen still catches up.
import { useEffect, useRef } from 'preact/hooks';
import { apiBaseUrl } from '../api/client.js';
import { sessionStore } from '../store/session.js';
import { parseSse } from './logic.js';
import { refreshWhatsappUnread } from '../store/whatsappUnread.js';

export interface LiveEvent {
  kind: string;
  conversation_id?: string;
  message_id?: string;
}

/** Fallback refresh interval while a screen is open. */
export const POLL_MS = 30_000;

/** Open the stream; resolves when it ends. Throws on a refused connection. */
async function readStream(onEvent: (e: LiveEvent) => void, signal: AbortSignal): Promise<void> {
  const token = sessionStore.get().token;
  const res = await fetch(`${apiBaseUrl()}/whatsapp/stream`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream refused (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const e of events) {
      if (e.event === 'ready') continue;
      try {
        onEvent({ kind: e.event, ...(JSON.parse(e.data) as Omit<LiveEvent, 'kind'>) });
      } catch {
        /* a malformed event is skipped */
      }
    }
  }
}

/**
 * Call `onChange` whenever WhatsApp data in this workspace changes: on each stream
 * event, every POLL_MS, and when the tab becomes visible again. The latest
 * `onChange` is always used (no stale closures), and everything stops on unmount.
 */
export function useWhatsAppLive(onChange: (e: LiveEvent | null) => void, enabled = true): void {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    let delay = 1_000;
    let stopped = false;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        try {
          await readStream((e) => {
            delay = 1_000;
            latest.current(e);
            refreshWhatsappUnread();
          }, ctl.signal);
        } catch {
          /* refused / dropped — retry below */
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void loop();

    const poll = setInterval(() => latest.current(null), POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') latest.current(null);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      ctl.abort();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
}

/** Fetch a stored media file with the bearer token, as an object URL (caller revokes). */
export async function fetchMediaUrl(messageId: string): Promise<string> {
  const token = sessionStore.get().token;
  const res = await fetch(`${apiBaseUrl()}/whatsapp/media/${messageId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`media unavailable (${res.status})`);
  return URL.createObjectURL(await res.blob());
}
