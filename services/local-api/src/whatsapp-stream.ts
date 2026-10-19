// Live WhatsApp updates for the inbox: Postgres LISTEN/NOTIFY → server-sent events.
//
// Every write to a conversation runs `pg_notify('wa_events', {workspace_id, kind,
// conversation_id, message_id})` inside its own transaction, so a notification is
// delivered only on COMMIT and works across every machine sharing the database.
// Each process holds ONE dedicated LISTEN connection (started lazily, on the first
// open stream) and fans notifications out to the streams of THAT workspace only.
//
// The LISTEN connection must be a direct or session-mode connection: a
// transaction-mode pooler (Supabase :6543) never delivers notifications. That
// failure is silent, which is why the browser also polls slowly underneath.
import { Client } from 'pg';
import { WHATSAPP_NOTIFY_CHANNEL } from './whatsapp-inbound.js';

/** What a stream receives — the notification without its workspace (already filtered). */
export interface WhatsAppStreamEvent {
  readonly kind: string;
  readonly conversation_id?: string;
  readonly message_id?: string;
}
type Listener = (e: WhatsAppStreamEvent) => void;

/** Workspace-filtered fan-out. Pure: no I/O, so routing is unit-testable. */
export class WhatsAppEventHub {
  private readonly byWorkspace = new Map<string, Set<Listener>>();

  subscribe(workspaceId: string, listener: Listener): () => void {
    let set = this.byWorkspace.get(workspaceId);
    if (!set) {
      set = new Set();
      this.byWorkspace.set(workspaceId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.byWorkspace.delete(workspaceId);
    };
  }

  /** Route one raw NOTIFY payload. A malformed payload is ignored, never thrown. */
  dispatch(raw: string | undefined): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw ?? '') as Record<string, unknown>;
    } catch {
      return;
    }
    const ws = typeof msg.workspace_id === 'string' ? msg.workspace_id : null;
    const set = ws ? this.byWorkspace.get(ws) : undefined;
    if (!set) return;
    const event: WhatsAppStreamEvent = {
      kind: String(msg.kind ?? 'message'),
      ...(typeof msg.conversation_id === 'string' ? { conversation_id: msg.conversation_id } : {}),
      ...(typeof msg.message_id === 'string' ? { message_id: msg.message_id } : {}),
    };
    for (const l of [...set]) {
      try {
        l(event);
      } catch {
        /* one broken stream must not starve the rest */
      }
    }
  }

  get size(): number {
    let n = 0;
    for (const s of this.byWorkspace.values()) n += s.size;
    return n;
  }
}

/** The connection the LISTEN uses: a direct URL when one is configured. */
export function listenConnectionString(): string | null {
  return process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? process.env.DATABASE_POOL_URL ?? null;
}

/**
 * Keep one LISTEN connection alive for `hub`, reconnecting with backoff. Returns a
 * stop function. Started on demand by `ensureListening`.
 */
export function startWhatsAppListener(hub: WhatsAppEventHub, connectionString: string): () => void {
  let stopped = false;
  let client: Client | null = null;
  let delay = 1_000;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const c = new Client({ connectionString });
    client = c;
    // 'end' and a failed connect can both fire for one client; retry once.
    let retried = false;
    const retry = (): void => {
      if (retried || stopped) return;
      retried = true;
      setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, 30_000);
    };
    c.on('notification', (n) => {
      if (n.channel === WHATSAPP_NOTIFY_CHANNEL) hub.dispatch(n.payload);
    });
    c.on('error', () => {
      void c.end().catch(() => {});
    });
    c.on('end', retry);
    try {
      await c.connect();
      await c.query(`LISTEN ${WHATSAPP_NOTIFY_CHANNEL}`);
      delay = 1_000;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[local-api] whatsapp LISTEN failed; retrying', (e as Error).message);
      void c.end().catch(() => {});
      retry();
    }
  };
  void connect();
  return () => {
    stopped = true;
    void client?.end().catch(() => {});
  };
}

let shared: { hub: WhatsAppEventHub; stop: (() => void) | null } | null = null;

/** The process-wide hub; its LISTEN connection starts with the first open stream. */
export function sharedWhatsAppHub(): WhatsAppEventHub {
  if (!shared) shared = { hub: new WhatsAppEventHub(), stop: null };
  if (!shared.stop) {
    const url = listenConnectionString();
    if (url) shared.stop = startWhatsAppListener(shared.hub, url);
  }
  return shared.hub;
}
