// A WhatsApp conversation thread + its composer. Shared by the inbox screen and
// the profile's WhatsApp tab (one component, not two forks).
//
// The parent owns the live stream and bumps `refreshSignal` when this
// conversation may have changed; the thread then refetches its newest page and
// merges it in by id, so a status update re-renders the ticks in place.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { Button, Select, Input, Spinner } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { formatDateTime } from '../ui/datetime.js';
import { fetchMediaUrl } from './live.js';
import { refreshWhatsappUnread } from '../store/whatsappUnread.js';
import {
  buildThread,
  mergeMessages,
  ticksFor,
  sourceLabel,
  fallbackText,
  windowLabel,
  windowOpen,
  type ChatMessage,
  type Conversation,
} from './logic.js';

const PAGE = 50;

export interface ChatThreadProps {
  /** The conversation, or null when the profile has none yet (first message starts it). */
  conversation: Conversation | null;
  /** Needed to start a conversation from a profile. */
  profileId?: string | null;
  /** Bumped by the parent when this conversation may have changed. */
  refreshSignal: number;
  /** After a send — the conversation it landed in (new on a first message). */
  onSent?: (conversationId: string | null) => void;
  /** After the unread count was cleared. */
  onRead?: () => void;
  class?: string;
}

export function ChatThread({ conversation, profileId, refreshSignal, onSent, onRead, class: cls = '' }: ChatThreadProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const convId = conversation?.id ?? null;

  const fetchPage = async (before?: string): Promise<{ messages: ChatMessage[]; has_more: boolean } | null> => {
    if (!convId) return null;
    return api.get<{ messages: ChatMessage[]; has_more: boolean }>(`/whatsapp/conversations/${convId}/messages`, {
      query: { limit: String(PAGE), ...(before ? { before } : {}) },
    });
  };

  // A different conversation → start over at its newest page.
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    stickToBottom.current = true;
    if (!convId) return;
    let live = true;
    setLoading(true);
    void fetchPage()
      .then((r) => {
        if (!live || !r) return;
        setMessages(mergeMessages([], r.messages));
        setHasMore(r.has_more);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [convId]);

  // Something changed → merge the newest page in.
  useEffect(() => {
    if (!convId || refreshSignal === 0) return;
    const el = scroller.current;
    stickToBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    void fetchPage().then((r) => r && setMessages((cur) => mergeMessages(cur, r.messages)));
  }, [refreshSignal]);

  // Opening a conversation with unread messages marks it read.
  useEffect(() => {
    if (!conversation || conversation.unread_count === 0) return;
    void api.post(`/whatsapp/conversations/${conversation.id}/read`, { body: {} }).then(() => {
      refreshWhatsappUnread();
      onRead?.();
    });
  }, [conversation?.id, conversation?.unread_count]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadEarlier = async (): Promise<void> => {
    const oldest = messages[0];
    if (!oldest) return;
    const el = scroller.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    const r = await fetchPage(oldest.created_at);
    if (!r) return;
    stickToBottom.current = false;
    setMessages((cur) => mergeMessages(cur, r.messages));
    setHasMore(r.has_more);
    // Keep the viewport on the message the user was reading.
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - fromBottom;
    });
  };

  const retry = async (id: string): Promise<void> => {
    try {
      await api.post(`/whatsapp/messages/${id}/retry`, { body: {} });
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Still could not send it.', { tone: 'error' });
    }
    const r = await fetchPage();
    // The failed row is replaced, so rebuild from the server's view.
    if (r) setMessages((cur) => mergeMessages(cur.filter((m) => m.id !== id), r.messages));
  };

  const afterSend = async (conversationId: string | null): Promise<void> => {
    stickToBottom.current = true;
    if (conversationId && conversationId === convId) {
      const r = await fetchPage();
      if (r) setMessages((cur) => mergeMessages(cur, r.messages));
    }
    onSent?.(conversationId);
  };

  const items = buildThread(messages);

  return (
    <div data-testid="wa-thread" class={`flex min-h-0 flex-col ${cls}`}>
      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto bg-[#efeae2] px-3 py-4 sm:px-6">
        {hasMore ? (
          <div class="mb-3 text-center">
            <Button data-testid="wa-load-earlier" variant="secondary" size="sm" onClick={loadEarlier}>
              Load earlier messages
            </Button>
          </div>
        ) : null}
        {loading && messages.length === 0 ? (
          <div class="grid h-full place-items-center text-stone-500">
            <Spinner />
          </div>
        ) : !convId || messages.length === 0 ? (
          <div data-testid="wa-thread-empty" class="grid h-full place-items-center text-center text-sm text-stone-500">
            No messages yet.
          </div>
        ) : (
          <ol class="space-y-1.5">
            {items.map((it) =>
              it.kind === 'day' ? (
                <li key={`d-${it.key}`} class="my-3 text-center">
                  <span class="rounded-md bg-white/80 px-2.5 py-1 text-xs font-medium text-stone-600 shadow-sm">{it.label}</span>
                </li>
              ) : (
                <Bubble key={it.message.id} m={it.message} onRetry={retry} />
              ),
            )}
          </ol>
        )}
      </div>
      <Composer conversation={conversation} profileId={profileId ?? null} onSent={afterSend} />
    </div>
  );
}

function Bubble({ m, onRetry }: { m: ChatMessage; onRetry: (id: string) => Promise<void> }) {
  const out = m.direction === 'out';
  const ticks = out ? ticksFor(m.status) : null;
  const source = sourceLabel(m);
  const text = m.body ?? fallbackText(m);
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(m.created_at));
  return (
    <li data-testid="wa-message" data-direction={m.direction} data-status={m.status} class={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div
        class={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%] ${
          out ? (m.status === 'failed' ? 'bg-rose-50 ring-1 ring-rose-200' : 'bg-[#d9fdd3]') : 'bg-white'
        }`}
        title={formatDateTime(m.created_at)}
      >
        {source ? <div class="mb-0.5 text-[11px] font-semibold text-emerald-700">{source}</div> : null}
        {m.media ? <MediaView m={m} /> : null}
        {m.template ? (
          <div class="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-stone-500">Template · {m.template.name}</div>
        ) : null}
        {text && !(m.template && !m.body) ? (
          <p dir="auto" class="whitespace-pre-wrap break-words text-ink-900">
            {text}
          </p>
        ) : m.template ? (
          <p class="text-ink-900">{m.template.params.length ? m.template.params.join(' · ') : <em class="text-stone-500">(no variables)</em>}</p>
        ) : null}
        <div class="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-stone-500">
          <span>{time}</span>
          {ticks ? (
            <span data-testid="wa-ticks" title={ticks.label} class={ticks.read ? 'text-sky-500' : ''}>
              {ticks.glyph}
            </span>
          ) : null}
        </div>
        {m.status === 'failed' ? (
          <div class="mt-1 flex items-center justify-between gap-2 border-t border-rose-200 pt-1 text-xs text-rose-700">
            <span>{m.error?.message ?? m.error?.title ?? 'Not delivered'}</span>
            {out && !m.broadcast_id && !m.automation_id ? (
              <Button data-testid="wa-retry" size="sm" variant="secondary" onClick={() => onRetry(m.id)}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function MediaView({ m }: { m: ChatMessage }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const media = m.media!;
  useEffect(() => {
    if (!media.stored) return;
    let objectUrl: string | null = null;
    let live = true;
    fetchMediaUrl(m.id)
      .then((u) => {
        objectUrl = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [m.id, media.stored]);

  if (media.failed || failed) return <p class="mb-1 text-xs italic text-stone-500">Media unavailable</p>;
  if (!media.stored || !url) return <p class="mb-1 text-xs italic text-stone-500">Loading media…</p>;
  const mime = media.mime_type ?? '';
  let el: JSX.Element;
  if (mime.startsWith('image/')) {
    el = (
      <a href={url} target="_blank" rel="noopener">
        <img src={url} alt={m.body ?? 'Photo'} class="max-h-72 rounded-md" />
      </a>
    );
  } else if (mime.startsWith('audio/')) {
    el = <audio controls src={url} class="max-w-full" />;
  } else if (mime.startsWith('video/')) {
    el = <video controls src={url} class="max-h-72 max-w-full rounded-md" />;
  } else {
    el = (
      <a href={url} download={media.filename ?? 'file'} class="inline-flex items-center gap-1.5 rounded-md bg-black/5 px-2 py-1.5 text-xs font-medium text-ink-900 hover:bg-black/10">
        📄 {media.filename ?? 'Download file'}
      </a>
    );
  }
  return <div class="mb-1">{el}</div>;
}

// ── Composer ─────────────────────────────────────────────────────────────────

interface WaTemplate {
  name: string;
  language: string;
  status: string;
  body: string;
  variableCount: number;
}

function Composer({ conversation, profileId, onSent }: { conversation: Conversation | null; profileId: string | null; onSent: (conversationId: string | null) => Promise<void> }) {
  const [text, setText] = useState('');
  const [useTemplate, setUseTemplate] = useState(false);
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [params, setParams] = useState<string[]>([]);
  const [now, setNow] = useState(() => new Date());
  // The window closes while the screen is open; re-evaluate every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const open = windowOpen(conversation?.window_closes_at ?? null, now);
  const left = windowLabel(conversation?.window_closes_at ?? null, now);
  const templateMode = !open || useTemplate;

  useEffect(() => {
    if (!templateMode || templates !== null) return;
    void api
      .get<{ templates: WaTemplate[] }>('/whatsapp/templates')
      .then((r) => setTemplates(r.templates.filter((t) => t.status === 'APPROVED')))
      .catch(() => setTemplates([]));
  }, [templateMode]);

  const tpl = templates?.find((t) => `${t.name}|${t.language}` === chosen) ?? null;
  useEffect(() => setParams(Array.from({ length: tpl?.variableCount ?? 0 }, () => '')), [chosen]);

  const target = conversation ? `/whatsapp/conversations/${conversation.id}/messages` : profileId ? `/profiles/${profileId}/whatsapp/messages` : null;

  // Enter-to-send bypasses the button's own lock, so the composer owns the in-flight
  // state: the ref guards re-entry synchronously, the state shows the button locked
  // and spinning however the send was started (click OR Enter).
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const send = async (): Promise<void> => {
    if (!target || sending.current) return;
    const body = templateMode
      ? tpl
        ? { template: { name: tpl.name, language: tpl.language, params } }
        : null
      : text.trim()
        ? { text }
        : null;
    if (!body) return;
    sending.current = true;
    setBusy(true);
    try {
      const r = await api.post<{ conversation_id?: string }>(target, { body });
      setText('');
      setChosen('');
      setUseTemplate(false);
      await onSent(r.conversation_id ?? null);
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not send the message.', { tone: 'error' });
      await onSent(conversation?.id ?? null); // a failed send is in the thread now
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const canSend = templateMode ? !!tpl && params.every((p) => p.trim() !== '') : text.trim() !== '';

  return (
    <div data-testid="wa-composer" class="border-t border-stone-200 bg-stone-50 px-3 py-2.5 sm:px-4">
      {!open ? (
        <p data-testid="wa-window-closed" class="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {conversation?.last_inbound_at
            ? 'More than 24 hours have passed since their last message, so WhatsApp only allows an approved template.'
            : 'They haven’t written to you yet, so WhatsApp only allows an approved template to start the conversation.'}
        </p>
      ) : left ? (
        <div class="mb-1.5 flex items-center justify-between text-xs text-stone-500">
          <span data-testid="wa-window-left">Free replies allowed for {left} more</span>
          <button type="button" data-testid="wa-use-template" class="font-medium text-brand-700 hover:underline" onClick={() => setUseTemplate(!useTemplate)}>
            {useTemplate ? 'Write a message instead' : 'Use a template'}
          </button>
        </div>
      ) : null}

      {templateMode ? (
        <div class="space-y-2">
          {templates === null ? (
            <p class="text-xs text-stone-500">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p class="text-xs text-stone-500">No approved templates yet. Create one under Asset management → WhatsApp templates.</p>
          ) : (
            <>
              <Select data-testid="wa-template-select" value={chosen} onChange={(e: Event) => setChosen((e.target as HTMLSelectElement).value)}>
                <option value="">Choose a template…</option>
                {templates.map((t) => (
                  <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </Select>
              {tpl ? <p dir="auto" class="whitespace-pre-wrap rounded-md bg-white px-3 py-2 text-xs text-stone-700 ring-1 ring-stone-200">{tpl.body}</p> : null}
              {params.map((p, i) => (
                <Input
                  key={i}
                  data-testid={`wa-template-param-${i + 1}`}
                  dir="auto"
                  placeholder={`Value for {{${i + 1}}}`}
                  value={p}
                  onInput={(e: Event) => setParams((cur) => cur.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
                />
              ))}
            </>
          )}
          <div class="flex justify-end">
            <Button data-testid="wa-send" disabled={!canSend} loading={busy} onClick={send}>
              Send template
            </Button>
          </div>
        </div>
      ) : (
        <div class="flex items-end gap-2">
          <textarea
            data-testid="wa-input"
            dir="auto"
            rows={1}
            class="textarea max-h-40 min-h-[40px] flex-1 resize-none"
            placeholder="Type a message"
            value={text}
            onInput={(e: Event) => {
              const el = e.target as HTMLTextAreaElement;
              setText(el.value);
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e: KeyboardEvent) => {
              // Enter sends, Shift+Enter is a new line (as in WhatsApp Web).
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (canSend) void send();
              }
            }}
          />
          <Button data-testid="wa-send" disabled={!canSend} loading={busy} onClick={send}>
            Send
          </Button>
        </div>
      )}
    </div>
  );
}
