// WhatsApp inbox — every conversation in the workspace, like WhatsApp Web: the
// list on the left, the open thread on the right (stacked on a phone). Data is
// pulled when the screen opens and kept current by the live stream (+ a slow poll).
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { PageHeader } from '../ui/kit.js';
import { ConversationList } from '../whatsapp/ConversationList.tsx';
import { ChatThread } from '../whatsapp/ChatThread.tsx';
import { useWhatsAppLive, type LiveEvent } from '../whatsapp/live.js';
import type { Conversation } from '../whatsapp/logic.js';

export function WhatsAppInbox({ conversationId = null }: { conversationId?: string | null }) {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [signal, setSignal] = useState(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  const loadList = async (q = queryRef.current): Promise<void> => {
    const r = await api.get<{ conversations: Conversation[]; has_more: boolean }>('/whatsapp/conversations', {
      query: q ? { q } : {},
    });
    if (q !== queryRef.current) return; // a newer search is in flight
    setConversations(r.conversations);
    setHasMore(r.has_more);
  };
  const loadMore = async (): Promise<void> => {
    const last = conversations?.at(-1);
    if (!last?.last_message_at) return;
    const r = await api.get<{ conversations: Conversation[]; has_more: boolean }>('/whatsapp/conversations', {
      query: { before: last.last_message_at, ...(query ? { q: query } : {}) },
    });
    setConversations((cur) => [...(cur ?? []), ...r.conversations.filter((c) => !cur?.some((x) => x.id === c.id))]);
    setHasMore(r.has_more);
  };
  const loadSelected = async (id: string | null): Promise<void> => {
    if (!id) return setSelected(null);
    try {
      const r = await api.get<{ conversation: Conversation }>(`/whatsapp/conversations/${id}`);
      setSelected(r.conversation);
    } catch {
      setSelected(null);
    }
  };

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => void loadList(query), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => void loadSelected(conversationId), [conversationId]);

  useWhatsAppLive((e: LiveEvent | null) => {
    void loadList();
    if (conversationId && (!e || e.conversation_id === conversationId)) {
      void loadSelected(conversationId);
      setSignal((n) => n + 1);
    }
  });

  const open = (id: string): void => navigate(`/inbox/${id}`);

  return (
    <section data-testid="whatsapp-inbox" class="flex h-[calc(100dvh-7rem)] min-h-[480px] flex-col md:h-[calc(100dvh-4rem)]">
      <PageHeader title="WhatsApp inbox" subtitle="Every WhatsApp conversation in this workspace." />
      <div class="grid min-h-0 flex-1 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-card md:grid-cols-[minmax(260px,340px)_1fr]">
        <div class={`min-h-0 border-stone-200 md:flex md:flex-col md:border-r ${conversationId ? 'hidden' : 'flex flex-col'}`}>
          <ConversationList
            conversations={conversations}
            selectedId={conversationId}
            query={query}
            onQuery={setQuery}
            onSelect={open}
            hasMore={hasMore}
            onMore={loadMore}
          />
        </div>
        <div class={`min-h-0 flex-col ${conversationId ? 'flex' : 'hidden md:flex'}`}>
          {selected ? (
            <>
              <header class="flex items-center gap-3 border-b border-stone-200 px-3 py-2.5 sm:px-4">
                <button type="button" class="text-stone-500 md:hidden" aria-label="Back to conversations" onClick={() => navigate('/inbox')}>
                  ←
                </button>
                <div class="min-w-0 flex-1">
                  <div dir="auto" data-testid="wa-thread-title" class="truncate text-sm font-bold text-ink-950">
                    {selected.display_name}
                  </div>
                  <div class="truncate text-xs text-stone-500">{selected.wa_phone}</div>
                </div>
                {selected.profile_id ? (
                  <button
                    type="button"
                    data-testid="wa-open-profile"
                    class="shrink-0 text-xs font-semibold text-brand-700 hover:underline"
                    onClick={() => navigate(`/profiles/${selected.profile_id}`)}
                  >
                    View profile
                  </button>
                ) : null}
              </header>
              <ChatThread
                class="flex-1"
                conversation={selected}
                profileId={selected.profile_id}
                refreshSignal={signal}
                onSent={() => {
                  void loadList();
                  void loadSelected(selected.id);
                }}
                onRead={() => void loadList()}
              />
            </>
          ) : (
            <div class="grid flex-1 place-items-center p-6 text-center text-sm text-stone-500">
              {conversationId ? 'Conversation not found.' : 'Choose a conversation to read it.'}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
