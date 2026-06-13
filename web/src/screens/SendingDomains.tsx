// Sending domains (§10): a workspace can have several. Add a domain to the list
// even before it's verified; verify it (dev harness stands in for the SES/DKIM
// check); remove it (blocked while it still has senders). A domain must be
// verified before it can host a sender (enforced server-side). Styled confirm
// for removal (no native dialogs).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { askConfirm } from '../ui/dialog.tsx';
import { Badge, Button, Card, Input } from '../ui/kit.js';

interface SendingDomain {
  id: string;
  domain: string;
  verified: boolean;
}

/** Notifies the parent when the verified set changes (senders depend on it). */
export function SendingDomains({ onChange }: { onChange?: () => void } = {}) {
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<void> => {
    const r = await api.get<{ domains: SendingDomain[] }>('/sending-domains');
    setDomains(r.domains);
    onChange?.();
  };
  useEffect(() => {
    void reload();
  }, []);

  const add = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await api.post('/sending-domains', { body: { domain: value.trim() } });
      setValue('');
      await reload();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not add the domain.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (d: SendingDomain): Promise<void> => {
    setError('');
    try {
      await api.post(`/sending-domains/${d.id}/verify`, {});
      await reload();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not verify the domain.');
    }
  };

  const remove = async (d: SendingDomain): Promise<void> => {
    const ok = await askConfirm({
      title: 'Remove sending domain',
      message: `Remove “${d.domain}” from this workspace's sending domains?`,
      danger: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/sending-domains/${d.id}`);
      await reload();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the domain.');
    }
  };

  return (
    <Card data-testid="sending-domains" class="p-5">
      <h2 class="text-base font-bold text-ink-900">Sending domains</h2>
      <p class="mt-1 text-sm text-stone-500">
        Add the domains you send from. A domain can be added before it's verified, but you can only create senders for a
        verified domain.
      </p>

      <div class="mt-4 flex flex-wrap items-start gap-2">
        <Input
          data-testid="domain-add-input"
          class="min-w-[16rem] flex-1 font-mono text-sm"
          placeholder="mail.yourcompany.com"
          value={value}
          onInput={(e: Event) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && value.trim()) void add();
          }}
        />
        <Button data-testid="add-domain" onClick={() => void add()} disabled={busy || !value.trim()}>
          Add domain
        </Button>
      </div>
      {error ? (
        <p data-testid="domains-error" class="mt-2 text-sm text-rose-600">
          {error}
        </p>
      ) : null}

      <ul class="mt-5 space-y-1">
        {domains === null ? (
          <p class="text-sm text-stone-400">Loading…</p>
        ) : domains.length === 0 ? (
          <p class="text-sm text-stone-400">No sending domains yet — add one above.</p>
        ) : (
          domains.map((d) => (
            <li
              data-testid="domain-row"
              key={d.id}
              class="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2"
            >
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate font-mono text-sm text-ink-900">{d.domain}</span>
                <Badge data-testid="domain-status" tone={d.verified ? 'success' : 'warn'}>
                  {d.verified ? 'verified' : 'pending'}
                </Badge>
              </span>
              <span class="flex shrink-0 items-center gap-2">
                {d.verified ? null : (
                  <Button data-testid="domain-verify" variant="secondary" size="sm" onClick={() => void verify(d)}>
                    Verify
                  </Button>
                )}
                <Button data-testid="domain-remove" variant="danger" size="sm" onClick={() => void remove(d)}>
                  Remove
                </Button>
              </span>
            </li>
          ))
        )}
      </ul>
    </Card>
  );
}
