// Write-key management (§7) — mint / list / revoke the PUBLIC tracking keys that
// drive the /v1/track + /v1/identify ingest endpoints. Session-authed; shown in
// the authenticated Help screen (NOT the public /docs). The raw key is returned
// ONCE at creation and shown in a copy-now box — never retrievable again.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Button, Input, Card, Badge } from '../ui/kit.js';
import { showToast } from '../ui/toast.js';

interface KeyRow {
  id: string;
  key_prefix: string;
  key_full: string | null; // the copyable public value (null for pre-0050 keys)
  label: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function IngestKeys() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [label, setLabel] = useState('');
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async (): Promise<void> => {
    const r = await api.get<{ keys: KeyRow[] }>('/ingest-keys');
    setKeys(r.keys ?? []);
    setLoaded(true);
  };
  useEffect(() => {
    void load();
  }, []);

  const create = async (): Promise<void> => {
    const r = await api.post<{ key: string }>('/ingest-keys', { body: { label: label.trim() } });
    setFreshKey(r.key);
    setLabel('');
    await load();
  };

  const revoke = async (id: string): Promise<void> => {
    await api.del(`/ingest-keys/${id}`);
    await load();
  };

  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => showToast('Copied to clipboard'),
      () => showToast('Could not copy — select and copy manually'),
    );
  };

  const active = keys.filter((k) => !k.revoked_at);

  return (
    <Card class="p-6" data-testid="ingest-keys">
      <h3 class="font-bold text-ink-900">Your write keys</h3>
      <p class="mt-1 text-sm text-stone-600">
        Public, write-only keys for the tracking API (<code class="font-mono text-xs">/v1/track</code>{' '}
        &amp; <code class="font-mono text-xs">/v1/identify</code>). Safe to embed in front-end code —
        a key can only add profiles/events to this workspace, never read or delete. Revoke anytime.
      </p>

      {/* Freshly-minted key — shown ONCE */}
      {freshKey ? (
        <div
          data-testid="fresh-key"
          class="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3"
        >
          <p class="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Your new write key — copy it below (also available in the list anytime)
          </p>
          <div class="mt-2 flex items-center gap-2">
            <code class="flex-1 overflow-x-auto rounded bg-white px-2 py-1.5 font-mono text-sm text-ink-900 ring-1 ring-amber-200">
              {freshKey}
            </code>
            <Button data-testid="copy-key" onClick={() => copy(freshKey)}>
              Copy
            </Button>
            <button
              type="button"
              class="text-sm text-stone-500 hover:underline"
              onClick={() => setFreshKey(null)}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* Create */}
      <div class="mt-4 flex flex-wrap items-end gap-2">
        <div class="flex-1 min-w-[12rem]">
          <label class="label" for="key-label">
            Label (optional)
          </label>
          <Input
            id="key-label"
            data-testid="key-label"
            value={label}
            onInput={(e: Event) => setLabel((e.target as HTMLInputElement).value)}
            placeholder="e.g. Marketing website"
          />
        </div>
        <Button data-testid="create-key" onClick={create}>
          Create write key
        </Button>
      </div>

      {/* List */}
      <div class="mt-5">
        {loaded && active.length === 0 ? (
          <p class="rounded-lg bg-stone-50 px-3 py-3 text-sm text-stone-500 ring-1 ring-inset ring-stone-200">
            No write keys yet. Create one to start sending events from your site or app.
          </p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="keys-table">
              <thead class="text-left text-xs uppercase tracking-wide text-stone-400">
                <tr>
                  <th class="py-1.5 pr-4">Key</th>
                  <th class="py-1.5 pr-4">Label</th>
                  <th class="py-1.5 pr-4">Last used</th>
                  <th class="py-1.5 pr-4" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} data-testid="key-row" class="border-t border-stone-100">
                    <td class="py-2 pr-4 font-mono text-xs text-ink-900">
                      {k.key_full && !k.revoked_at ? (
                        <button
                          type="button"
                          data-testid="copy-existing-key"
                          onClick={() => copy(k.key_full as string)}
                          title="Click to copy this key"
                          class="inline-flex max-w-full items-center gap-1.5 truncate rounded bg-stone-100 px-2 py-1 text-ink-800 hover:bg-stone-200"
                        >
                          <span class="truncate">{k.key_full}</span>
                          <span class="shrink-0 text-stone-400">⧉</span>
                        </button>
                      ) : (
                        <>{k.key_prefix}…</>
                      )}
                      {k.revoked_at ? (
                        <Badge tone="danger" class="ml-2">
                          revoked
                        </Badge>
                      ) : null}
                    </td>
                    <td class="py-2 pr-4 text-stone-600">{k.label || <span class="text-stone-400">—</span>}</td>
                    <td class="py-2 pr-4 text-stone-500">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}
                    </td>
                    <td class="py-2 pr-4 text-right">
                      {k.revoked_at ? null : (
                        <Button
                          data-testid="revoke-key"
                          variant="ghost"
                          onClick={() => revoke(k.id)}
                          class="text-rose-600"
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
