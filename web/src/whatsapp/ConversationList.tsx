// The inbox's left pane: searchable conversations, most recent first.
import { Input } from '../ui/kit.js';
import { dayKey } from './logic.js';
import type { Conversation } from './logic.js';

function when(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d);
}

function initials(name: string): string {
  const letters = name.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).map((w) => w[0] ?? '');
  return (letters.slice(0, 2).join('') || '#').toUpperCase();
}

export function ConversationList({
  conversations,
  selectedId,
  query,
  onQuery,
  onSelect,
  hasMore,
  onMore,
}: {
  conversations: Conversation[] | null;
  selectedId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  hasMore: boolean;
  onMore: () => void;
}) {
  return (
    <div class="flex min-h-0 flex-col">
      <div class="border-b border-stone-200 p-3">
        <Input
          data-testid="wa-search"
          type="search"
          placeholder="Search name, phone or email"
          value={query}
          onInput={(e: Event) => onQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        {conversations === null ? (
          <p class="p-4 text-sm text-stone-500">Loading…</p>
        ) : conversations.length === 0 ? (
          <p data-testid="wa-no-conversations" class="p-4 text-sm text-stone-500">
            {query ? 'No conversations match.' : 'No WhatsApp conversations yet. They appear here when someone writes to your number or you message them.'}
          </p>
        ) : (
          <ul>
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid="wa-conversation"
                  data-unread={c.unread_count > 0 ? 'true' : 'false'}
                  onClick={() => onSelect(c.id)}
                  class={`flex w-full items-center gap-3 border-b border-stone-100 px-3 py-2.5 text-left transition hover:bg-stone-50 ${
                    c.id === selectedId ? 'bg-brand-50/70' : ''
                  }`}
                >
                  <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">
                    {initials(c.display_name)}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex items-baseline justify-between gap-2">
                      <span dir="auto" class={`truncate text-sm ${c.unread_count > 0 ? 'font-bold text-ink-950' : 'font-semibold text-ink-900'}`}>
                        {c.display_name}
                      </span>
                      <span class={`shrink-0 text-[11px] ${c.unread_count > 0 ? 'font-semibold text-emerald-600' : 'text-stone-400'}`}>
                        {when(c.last_message_at)}
                      </span>
                    </span>
                    <span class="mt-0.5 flex items-center justify-between gap-2">
                      <span dir="auto" class="truncate text-xs text-stone-500">
                        {c.last_message_preview ?? ''}
                      </span>
                      {c.unread_count > 0 ? (
                        <span data-testid="wa-unread" class="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-bold text-white">
                          {c.unread_count}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasMore ? (
          <div class="p-3 text-center">
            <button type="button" data-testid="wa-more-conversations" class="text-sm font-medium text-brand-700 hover:underline" onClick={onMore}>
              Show older conversations
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
