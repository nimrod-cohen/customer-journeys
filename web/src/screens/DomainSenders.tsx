// Domain senders (§10): manage the named "From" identities for the workspace's
// sending domain(s). Each sender is a display name + a full address; the list is
// grouped by the address's domain. Add (name + email) and delete (styled confirm,
// per the no-native-dialogs rule). Capability-gated server-side (manage_sending_domain).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { askConfirm } from '../ui/dialog.tsx';
import { Button, Card, Input } from '../ui/kit.js';

interface Sender {
  id: string;
  domain: string;
  name: string;
  email: string;
}

export function DomainSenders() {
  const [senders, setSenders] = useState<Sender[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<void> => {
    const r = await api.get<{ senders: Sender[] }>('/domain-senders');
    setSenders(r.senders);
  };
  useEffect(() => {
    void reload();
  }, []);

  const add = async (): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await api.post('/domain-senders', { body: { name: name.trim(), email: email.trim() } });
      setName('');
      setEmail('');
      await reload();
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not add the sender.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Sender): Promise<void> => {
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
      setSenders((list) => (list ?? []).filter((x) => x.id !== s.id));
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the sender.');
    }
  };

  // Group by domain for display.
  const byDomain = new Map<string, Sender[]>();
  for (const s of senders ?? []) {
    const list = byDomain.get(s.domain) ?? [];
    list.push(s);
    byDomain.set(s.domain, list);
  }
  const domains = [...byDomain.keys()].sort();

  return (
    <Card data-testid="domain-senders" class="p-5">
      <h2 class="text-base font-bold text-ink-900">Domain senders</h2>
      <p class="mt-1 text-sm text-stone-500">
        The named “From” identities your broadcasts and campaigns can send as. The domain is taken from each address.
      </p>

      {/* Add a sender */}
      <div class="mt-4 flex flex-wrap items-start gap-2">
        <Input
          data-testid="sender-name-input"
          class="min-w-[10rem] flex-1"
          placeholder="Name (e.g. Support)"
          value={name}
          onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
        />
        <Input
          data-testid="sender-email-input"
          class="min-w-[14rem] flex-1 font-mono text-sm"
          placeholder="support@mail.yourcompany.com"
          value={email}
          onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && name.trim() && email.trim()) void add();
          }}
        />
        <Button data-testid="add-sender" onClick={() => void add()} disabled={busy || !name.trim() || !email.trim()}>
          Add sender
        </Button>
      </div>
      {error ? (
        <p data-testid="senders-error" class="mt-2 text-sm text-rose-600">
          {error}
        </p>
      ) : null}

      {/* The list, grouped by domain */}
      <div class="mt-5 space-y-4">
        {senders === null ? (
          <p class="text-sm text-stone-400">Loading…</p>
        ) : domains.length === 0 ? (
          <p class="text-sm text-stone-400">No senders yet — add one above.</p>
        ) : (
          domains.map((domain) => (
            <div data-testid="sender-domain-group" key={domain}>
              <p class="mb-1 font-mono text-xs uppercase tracking-wide text-stone-400">@{domain}</p>
              <ul class="space-y-1">
                {byDomain.get(domain)!.map((s) => (
                  <li
                    data-testid="sender-row"
                    key={s.id}
                    class="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2"
                  >
                    <span class="min-w-0 truncate text-sm">
                      <span class="font-medium text-ink-900">{s.name}</span>{' '}
                      <span class="text-stone-500">&lt;{s.email}&gt;</span>
                    </span>
                    <Button data-testid="sender-delete" variant="danger" size="sm" onClick={() => void remove(s)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
