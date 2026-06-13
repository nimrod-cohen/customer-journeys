// Sending domains (§10): a workspace can have several. Each domain is its own
// card — add it (pending until verified), verify it (dev harness stands in for
// the SES/DKIM check), and manage ITS senders inline. A sender can only be added
// to a VERIFIED domain, and its address is always at that domain. Styled confirm
// for destructive actions (no native dialogs).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { askConfirm } from '../ui/dialog.tsx';
import { Badge, Button, Card, Input } from '../ui/kit.js';

interface SendingDomain {
  id: string;
  domain: string;
  verified: boolean;
}
interface Sender {
  id: string;
  domain: string;
  name: string;
  email: string;
}

export function SendingDomains() {
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<void> => {
    const [d, s] = await Promise.all([
      api.get<{ domains: SendingDomain[] }>('/sending-domains'),
      api.get<{ senders: Sender[] }>('/domain-senders'),
    ]);
    setDomains(d.domains);
    setSenders(s.senders);
  };
  useEffect(() => {
    void reload();
  }, []);

  const addDomain = async (): Promise<void> => {
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

  return (
    <Card data-testid="sending-domains" class="p-5">
      <h2 class="text-base font-bold text-ink-900">Sending domains</h2>
      <p class="mt-1 text-sm text-stone-500">
        Add the domains you send from. A domain can be added before it's verified; once verified you can add its named
        “From” senders below it.
      </p>

      <div class="mt-4 flex flex-wrap items-start gap-2">
        <Input
          data-testid="domain-add-input"
          class="min-w-[16rem] flex-1 font-mono text-sm"
          placeholder="mail.yourcompany.com"
          value={value}
          onInput={(e: Event) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && value.trim()) void addDomain();
          }}
        />
        <Button data-testid="add-domain" onClick={() => void addDomain()} disabled={busy || !value.trim()}>
          Add domain
        </Button>
      </div>
      {error ? (
        <p data-testid="domains-error" class="mt-2 text-sm text-rose-600">
          {error}
        </p>
      ) : null}

      <div class="mt-5 space-y-3">
        {domains === null ? (
          <p class="text-sm text-stone-400">Loading…</p>
        ) : domains.length === 0 ? (
          <p class="text-sm text-stone-400">No sending domains yet — add one above.</p>
        ) : (
          domains.map((d) => (
            <DomainCard
              key={d.id}
              domain={d}
              senders={senders.filter((s) => s.domain === d.domain)}
              onChanged={reload}
            />
          ))
        )}
      </div>
    </Card>
  );
}

/** One domain + its senders. Holds the per-domain add-sender inputs. */
function DomainCard({
  domain,
  senders,
  onChanged,
}: {
  domain: SendingDomain;
  senders: Sender[];
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [local, setLocal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const verify = async (): Promise<void> => {
    setError('');
    try {
      await api.post(`/sending-domains/${domain.id}/verify`, {});
      await onChanged();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not verify the domain.');
    }
  };

  const removeDomain = async (): Promise<void> => {
    const ok = await askConfirm({
      title: 'Remove sending domain',
      message: `Remove “${domain.domain}” and stop using it for sending?`,
      danger: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/sending-domains/${domain.id}`);
      await onChanged();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the domain.');
    }
  };

  const addSender = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await api.post('/domain-senders', {
        body: { name: name.trim(), email: `${local.trim()}@${domain.domain}` },
      });
      setName('');
      setLocal('');
      await onChanged();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not add the sender.');
    } finally {
      setBusy(false);
    }
  };

  const removeSender = async (s: Sender): Promise<void> => {
    const ok = await askConfirm({
      title: 'Remove sender',
      message: `Remove “${s.name}” <${s.email}>?`,
      danger: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/domain-senders/${s.id}`);
      await onChanged();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the sender.');
    }
  };

  return (
    <div data-testid="domain-row" class="rounded-xl border border-stone-200 bg-white p-4">
      {/* Domain header */}
      <div class="flex items-center justify-between gap-3">
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate font-mono text-sm font-semibold text-ink-900">{domain.domain}</span>
          <Badge data-testid="domain-status" tone={domain.verified ? 'success' : 'warn'}>
            {domain.verified ? 'verified' : 'pending'}
          </Badge>
        </span>
        <span class="flex shrink-0 items-center gap-2">
          {domain.verified ? null : (
            <Button data-testid="domain-verify" variant="secondary" size="sm" onClick={() => void verify()}>
              Verify
            </Button>
          )}
          <Button data-testid="domain-remove" variant="danger" size="sm" onClick={() => void removeDomain()}>
            Remove
          </Button>
        </span>
      </div>

      {/* Senders for THIS domain */}
      <div class="mt-3 border-t border-stone-100 pt-3">
        {domain.verified ? (
          <>
            <div class="flex flex-wrap items-center gap-2">
              <Input
                data-testid="sender-name-input"
                class="min-w-[9rem] flex-1"
                placeholder="Name (e.g. Support)"
                value={name}
                onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              />
              <span class="flex min-w-[12rem] flex-1 items-center rounded-lg border border-stone-300 bg-white pr-2 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400/30">
                <input
                  data-testid="sender-local-input"
                  class="w-full bg-transparent px-3 py-2 font-mono text-sm outline-none"
                  placeholder="support"
                  value={local}
                  onInput={(e: Event) => setLocal((e.target as HTMLInputElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && name.trim() && local.trim()) void addSender();
                  }}
                />
                <span class="whitespace-nowrap font-mono text-sm text-stone-400">@{domain.domain}</span>
              </span>
              <Button
                data-testid="add-sender"
                size="sm"
                onClick={() => void addSender()}
                disabled={busy || !name.trim() || !local.trim()}
              >
                Add sender
              </Button>
            </div>
            <ul class="mt-2 space-y-1">
              {senders.length === 0 ? (
                <li class="text-sm text-stone-400">No senders for this domain yet.</li>
              ) : (
                senders.map((s) => (
                  <li
                    data-testid="sender-row"
                    key={s.id}
                    class="flex items-center justify-between gap-3 rounded-lg bg-stone-50 px-3 py-1.5"
                  >
                    <span class="min-w-0 truncate text-sm">
                      <span class="font-medium text-ink-900">{s.name}</span>{' '}
                      <span class="text-stone-500">&lt;{s.email}&gt;</span>
                    </span>
                    <Button data-testid="sender-delete" variant="danger" size="sm" onClick={() => void removeSender(s)}>
                      Remove
                    </Button>
                  </li>
                ))
              )}
            </ul>
          </>
        ) : (
          <p class="text-sm text-stone-400">Verify this domain to add senders.</p>
        )}
        {error ? (
          <p data-testid="senders-error" class="mt-2 text-sm text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
