// AI access (MCP) — owners mint tokens that let an assistant such as Claude read
// this workspace and draft automations, broadcasts, segments and templates through
// the hosted /mcp endpoint. Drafts only: publishing and sending stay human.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';
import { Button, Input, Card, Badge } from '../ui/kit.js';
import { askConfirm } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_email: string | null;
}

/** The absolute /mcp URL (the API may live on another origin in dev). */
export function mcpEndpoint(base: string, origin: string): string {
  const root = /^https?:\/\//.test(base) ? base : origin + base;
  return `${root.replace(/\/+$/, '')}/mcp`;
}

/** The one-line Claude Code command that connects this workspace. */
export function claudeCodeCommand(endpoint: string, token: string): string {
  return `claude mcp add --transport http customer-journeys ${endpoint} --header "Authorization: Bearer ${token}"`;
}

export function McpTokens() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const endpoint = mcpEndpoint(apiBaseUrl(), globalThis.location?.origin ?? '');

  const load = async (): Promise<void> => {
    const r = await api.get<{ tokens: TokenRow[] }>('/workspace/mcp-tokens');
    setTokens(r.tokens ?? []);
    setLoaded(true);
  };
  useEffect(() => {
    void load();
  }, []);

  const create = async (): Promise<void> => {
    if (!name.trim()) {
      showToast('Give the token a name, e.g. “Claude — Dana”.', { tone: 'error' });
      return;
    }
    const r = await api.post<{ token: string }>('/workspace/mcp-tokens', { body: { name: name.trim() } });
    setFresh(r.token);
    setName('');
    await load();
  };

  const revoke = async (t: TokenRow): Promise<void> => {
    const ok = await askConfirm({
      title: `Revoke “${t.name}”?`,
      message: 'Any assistant using it loses access immediately.',
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    await api.del(`/workspace/mcp-tokens/${t.id}`);
    showToast('Token revoked', { tone: 'success' });
    await load();
  };

  const copy = (text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => showToast('Copied to clipboard'),
      () => showToast('Could not copy — select and copy manually'),
    );
  };

  const active = tokens.filter((t) => !t.revoked_at);

  return (
    <Card class="p-6" data-testid="mcp-tokens">
      <h3 class="font-bold text-ink-900">AI assistant access (MCP)</h3>
      <p class="mt-1 text-sm text-stone-600">
        Connect Claude (or another MCP client) to this workspace. It can read your automations, broadcasts, segments and
        templates and <b>create or edit drafts</b>. It cannot publish, send, schedule, enroll people or delete anything, and it
        never sees profile data — a person finishes those steps here. Every change it makes is logged in the Activity log.
      </p>
      <p class="mt-2 text-sm text-stone-600">
        A token acts on your behalf and stops working if you leave the workspace. It is shown once.
      </p>

      {fresh ? (
        <div data-testid="fresh-mcp-token" class="mt-4 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Your new token — copy it now. This is the only time it is shown.
          </p>
          <div class="flex items-center gap-2">
            <code class="flex-1 overflow-x-auto rounded bg-surface px-2 py-1.5 font-mono text-sm text-ink-900 ring-1 ring-amber-200">
              {fresh}
            </code>
            <Button data-testid="copy-mcp-token" onClick={() => copy(fresh)}>
              Copy
            </Button>
          </div>
          <p class="text-xs text-stone-600">Connect Claude Code with:</p>
          <div class="flex items-center gap-2">
            <code
              data-testid="mcp-command"
              class="flex-1 overflow-x-auto whitespace-nowrap rounded bg-surface px-2 py-1.5 font-mono text-xs text-ink-900 ring-1 ring-amber-200"
            >
              {claudeCodeCommand(endpoint, fresh)}
            </code>
            <Button data-testid="copy-mcp-command" variant="secondary" onClick={() => copy(claudeCodeCommand(endpoint, fresh))}>
              Copy
            </Button>
          </div>
          <button type="button" class="text-sm text-stone-500 hover:underline" onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      ) : null}

      <div class="mt-4 flex flex-wrap items-end gap-2">
        <div class="min-w-[12rem] flex-1">
          <label class="label" for="mcp-token-name">
            Name
          </label>
          <Input
            id="mcp-token-name"
            data-testid="mcp-token-name"
            value={name}
            onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
            placeholder="e.g. Claude — Dana"
          />
        </div>
        <Button data-testid="create-mcp-token" onClick={create}>
          Create token
        </Button>
      </div>
      <p class="mt-2 text-xs text-stone-500">
        Endpoint: <code class="font-mono">{endpoint}</code>
      </p>

      <div class="mt-5">
        {loaded && active.length === 0 ? (
          <p class="rounded-lg bg-stone-50 px-3 py-3 text-sm text-stone-500 ring-1 ring-inset ring-stone-200">No tokens yet.</p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-sm" data-testid="mcp-tokens-table">
              <thead class="text-left text-xs uppercase tracking-wide text-stone-400">
                <tr>
                  <th class="py-1.5 pr-4">Name</th>
                  <th class="py-1.5 pr-4">Token</th>
                  <th class="py-1.5 pr-4">Created by</th>
                  <th class="py-1.5 pr-4">Last used</th>
                  <th class="py-1.5 pr-4" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} data-testid="mcp-token-row" class="border-t border-stone-100">
                    <td class="py-2 pr-4 text-ink-900">{t.name}</td>
                    <td class="py-2 pr-4 font-mono text-xs text-stone-600">
                      {t.token_prefix}…
                      {t.revoked_at ? (
                        <Badge tone="danger" class="ml-2">
                          revoked
                        </Badge>
                      ) : null}
                    </td>
                    <td class="py-2 pr-4 text-stone-600">{t.created_by_email ?? '—'}</td>
                    <td class="py-2 pr-4 text-stone-500">{t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'never'}</td>
                    <td class="py-2 pr-4 text-right">
                      {t.revoked_at ? null : (
                        <Button data-testid="revoke-mcp-token" variant="ghost" class="text-rose-600" onClick={() => revoke(t)}>
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
