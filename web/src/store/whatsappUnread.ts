// A tiny signal the AppShell watches to re-fetch the WhatsApp unread count (the inbox
// nav badge) WITHOUT a route change — bumped when a conversation is read, or when
// the live stream reports a change.
import { createStore, type Store } from './store.js';

export const whatsappUnreadStore: Store<number> = createStore<number>(0);

export function refreshWhatsappUnread(): void {
  whatsappUnreadStore.set((n) => n + 1);
}
