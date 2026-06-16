// Sending-domain SETUP screen (§10). Reached from the domains list. Two modes:
//   • new  (/settings/domains/new): name the domain and save it (pending) → its setup.
//   • edit (/settings/domains/:id): publish the DNS records, run a DNS CHECK (the only
//     way to verify — the system looks the records up), and ONLY once verified,
//     manage the domain's named "From" senders here. "← Back to domains" returns
//     to the list; the domain is saved whether or not it's verified.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { askConfirm } from '../ui/dialog.tsx';
import { Badge, Button, Card, Input, PageHeader } from '../ui/kit.js';

interface DnsRecord {
  role: string;
  type: string;
  name: string;
  value: string;
  status?: 'found' | 'missing' | 'mismatch';
  required?: boolean;
  note?: string;
}
type RecordStatus = 'found' | 'missing' | 'mismatch' | undefined;
const recordStatusMark = (s: RecordStatus): string => (s === 'found' ? '✓' : s === 'mismatch' ? '!' : '○');
const recordStatusLabel = (s: RecordStatus): string =>
  s === 'found'
    ? 'Found in DNS'
    : s === 'mismatch'
      ? 'A record exists but its value doesn’t match — fix it'
      : 'Not visible yet — publish this record';
const recordStatusClass = (s: RecordStatus): string =>
  `inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${
    s === 'found'
      ? 'bg-emerald-100 text-emerald-700'
      : s === 'mismatch'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-stone-100 text-stone-400'
  }`;

interface DomainDetail {
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

export function SendingDomainDetail({ id }: { id?: string }) {
  const isNew = !id;

  // ── new-domain create form ────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async (): Promise<void> => {
    setCreateError('');
    setCreating(true);
    try {
      const r = await api.post<{ domain: { id: string } }>('/sending-domains', { body: { domain: name.trim() } });
      navigate(`/settings/domains/${r.domain.id}`); // continue setup on the saved domain
    } catch (e) {
      setCreateError((e as { error?: string })?.error ?? 'Could not add the domain.');
      setCreating(false);
    }
  };

  if (isNew) {
    return (
      <section data-testid="domain-detail">
        <BackLink />
        <PageHeader title="Add a sending domain" subtitle="Save the domain, then verify it and add senders." />
        <Card class="max-w-xl p-5">
          <label class="block text-sm font-semibold text-stone-600">Domain</label>
          <div class="mt-2 flex gap-2">
            <Input
              data-testid="domain-name-input"
              class="flex-1 font-mono text-sm"
              placeholder="yourcompany.com"
              value={name}
              onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' && name.trim()) void create();
              }}
            />
            <Button data-testid="save-domain" onClick={() => void create()} disabled={creating || !name.trim()}>
              Save domain
            </Button>
          </div>
          {createError ? <p data-testid="domain-error" class="mt-2 text-sm text-rose-600">{createError}</p> : null}
        </Card>
      </section>
    );
  }

  return <DomainEditor id={id} />;
}

function BackLink() {
  return (
    <button data-testid="domain-back" class="btn-ghost mb-4 btn-sm" onClick={() => navigate('/settings/domains')}>
      ← Back to domains
    </button>
  );
}

function DomainEditor({ id }: { id: string }) {
  const [domain, setDomain] = useState<DomainDetail | null>(null);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [error, setError] = useState('');
  // Set when SES can't be reached — most importantly when the company has NO SES
  // credentials. We then BLOCK setup (no records, no verify) rather than simulate.
  const [sesError, setSesError] = useState('');
  // sender inputs
  const [sName, setSName] = useState('');
  const [sLocal, setSLocal] = useState('');
  const [sBusy, setSBusy] = useState(false);
  const [sError, setSError] = useState('');

  const load = async (): Promise<void> => {
    const d = await api.get<{ domain: DomainDetail; records: DnsRecord[]; sesError?: string }>(
      `/sending-domains/${id}`,
    );
    setDomain(d.domain);
    setRecords(d.records);
    setSesError(d.sesError ?? '');
    if (d.domain.verified) {
      const s = await api.get<{ senders: Sender[] }>('/domain-senders');
      setSenders(s.senders.filter((x) => x.domain === d.domain.domain));
    } else {
      setSenders([]);
    }
  };
  useEffect(() => {
    void load().catch(() => navigate('/settings/domains'));
  }, [id]);

  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckMsg('');
    try {
      const r = await api.post<{ verified: boolean; dkimStatus?: string; records?: DnsRecord[]; error?: string }>(
        `/sending-domains/${id}/check`,
        {},
      );
      if (r.error) {
        setSesError(r.error);
      } else if (r.verified) {
        setSesError('');
        setCheckMsg('Verified — Amazon SES confirmed DKIM for this domain.');
      } else {
        // If the required (DKIM) records are already visible to us, SES just
        // hasn't polled them yet — say so rather than "publish the records".
        const dkim = (r.records ?? []).filter((x) => x.required);
        const allDkimVisible = dkim.length > 0 && dkim.every((x) => x.status === 'found');
        const status = r.dkimStatus ?? 'pending';
        setCheckMsg(
          allDkimVisible
            ? `Your DKIM records are visible in DNS. Amazon SES (status: ${status}) verifies on its own schedule — usually minutes to a few hours after the records go live (up to 72h). Leave them in place and check again shortly.`
            : `Amazon SES DKIM status: ${status}. Publish the required DKIM (CNAME) records above, then check again (DNS can take a while to propagate).`,
        );
      }
      await load();
    } catch (e) {
      setCheckMsg((e as { error?: string })?.error ?? 'Could not check with SES.');
    } finally {
      setChecking(false);
    }
  };

  const removeDomain = async (): Promise<void> => {
    if (!domain) return;
    const ok = await askConfirm({
      title: 'Remove sending domain',
      message: `Remove “${domain.domain}” and stop using it for sending?`,
      danger: true,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await api.del(`/sending-domains/${id}`);
      navigate('/settings/domains');
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not remove the domain.');
    }
  };

  const addSender = async (): Promise<void> => {
    if (!domain) return;
    setSError('');
    setSBusy(true);
    try {
      await api.post('/domain-senders', { body: { name: sName.trim(), email: `${sLocal.trim()}@${domain.domain}` } });
      setSName('');
      setSLocal('');
      await load();
    } catch (e) {
      setSError((e as { error?: string })?.error ?? 'Could not add the sender.');
    } finally {
      setSBusy(false);
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
    setSError('');
    try {
      await api.del(`/domain-senders/${s.id}`);
      await load();
    } catch (e) {
      setSError((e as { error?: string })?.error ?? 'Could not remove the sender.');
    }
  };

  if (!domain) return <p class="text-sm text-stone-500">Loading…</p>;

  // The one check action always re-looks-up DNS AND asks SES; the LABEL reflects
  // what the user needs next: while the required (DKIM) records aren't all found
  // in DNS yet, the job is to fix/recheck DNS; once they're all present, it's on
  // SES to confirm; after that it's a re-verify.
  const requiredRecords = records.filter((r) => r.required);
  const allRequiredFound = requiredRecords.length > 0 && requiredRecords.every((r) => r.status === 'found');
  const checkLabel = checking
    ? 'Checking…'
    : domain.verified
      ? 'Re-check with SES'
      : allRequiredFound
        ? 'Verify with SES'
        : 'Recheck DNS';

  return (
    <section data-testid="domain-detail">
      <BackLink />
      <PageHeader
        title={domain.domain}
        subtitle="Publish the DNS records, then check to verify. Senders can be added once the domain is verified."
        actions={
          <span class="flex items-center gap-3">
            <Badge data-testid="domain-status" tone={domain.verified ? 'success' : 'warn'}>
              {domain.verified ? 'verified' : 'pending'}
            </Badge>
            <Button data-testid="domain-remove" variant="danger" size="sm" onClick={() => void removeDomain()}>
              Remove
            </Button>
          </span>
        }
      />
      {error ? <p class="mb-3 text-sm text-rose-600">{error}</p> : null}

      <div class="space-y-5">
        {/* SES DKIM records + verification */}
        <Card data-testid="dns-section" class="p-5">
          <h2 class="text-base font-bold text-ink-900">DNS records</h2>
          <p class="mt-1 text-sm text-stone-500">
            Add these records at your DNS provider, then check. The <b>DKIM (CNAME)</b> records are{' '}
            <b>required</b> — Amazon SES verifies the domain on them, and DKIM alignment makes DMARC pass. <b>SPF</b> and{' '}
            <b>DMARC</b> are recommended for deliverability but not needed to verify. Propagation can take from minutes
            to a few hours.
          </p>
          {sesError ? (
            // No SES credentials (or SES unreachable) → block setup; do NOT
            // simulate. The owner must configure SES first.
            <div
              data-testid="ses-error"
              class="mt-3 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200"
            >
              <p>{sesError}</p>
              <Button
                data-testid="go-to-ses-config"
                variant="secondary"
                size="sm"
                class="mt-3"
                onClick={() => navigate('/company')}
              >
                Open Company settings →
              </Button>
            </div>
          ) : (
            <>
              <div class="mt-3 overflow-hidden rounded-lg border border-stone-200">
                <table class="w-full text-sm">
                  <thead class="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                    <tr>
                      <th class="px-3 py-2 font-semibold">Seen</th>
                      <th class="px-3 py-2 font-semibold">Type</th>
                      <th class="px-3 py-2 font-semibold">Name</th>
                      <th class="px-3 py-2 font-semibold">Value</th>
                      <th class="px-3 py-2 font-semibold">Required</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-stone-100 text-xs">
                    {records.map((rec, i) => (
                      <tr data-testid="dns-record" key={i}>
                        <td class="px-3 py-2" title={recordStatusLabel(rec.status)}>
                          <span data-testid="dns-record-status" data-status={rec.status ?? 'unknown'} class={recordStatusClass(rec.status)}>
                            {recordStatusMark(rec.status)}
                          </span>
                        </td>
                        <td class="px-3 py-2 font-mono text-stone-500">{rec.type}</td>
                        <td class="max-w-[16rem] truncate px-3 py-2 font-mono text-ink-900">{rec.name}</td>
                        <td class="px-3 py-2 font-mono text-stone-600">
                          <span class="block max-w-[18rem] truncate">{rec.value}</span>
                          {rec.note ? <span class="mt-0.5 block font-sans text-[11px] text-stone-400">{rec.note}</span> : null}
                        </td>
                        <td class="px-3 py-2">
                          <Badge tone={rec.required ? 'warn' : 'neutral'}>
                            {rec.required ? 'required' : 'recommended'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p class="mt-2 text-xs text-stone-400">
                <span class={recordStatusClass('found')}>✓</span> found in DNS &nbsp;·&nbsp;
                <span class={recordStatusClass('missing')}>○</span> not visible yet &nbsp;·&nbsp;
                <span class={recordStatusClass('mismatch')}>!</span> value doesn’t match
              </p>
              <div class="mt-3 flex items-center gap-3">
                <Button data-testid="check-dns" variant="secondary" onClick={() => void check()} disabled={checking}>
                  {checkLabel}
                </Button>
                {checkMsg ? <span class="text-sm text-stone-600">{checkMsg}</span> : null}
              </div>
            </>
          )}
        </Card>

        {/* Senders — ONLY for a verified domain */}
        <Card data-testid="senders-section" class="p-5">
          <h2 class="text-base font-bold text-ink-900">Senders</h2>
          {!domain.verified ? (
            <p data-testid="senders-locked" class="mt-1 text-sm text-stone-400">
              Verify this domain to add senders.
            </p>
          ) : (
            <>
              <p class="mt-1 text-sm text-stone-500">The named “From” identities broadcasts and campaigns can send as.</p>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  data-testid="sender-name-input"
                  class="min-w-[9rem] flex-1"
                  placeholder="Name (e.g. Support)"
                  value={sName}
                  onInput={(e: Event) => setSName((e.target as HTMLInputElement).value)}
                />
                <span class="flex min-w-[12rem] flex-1 items-center rounded-lg border border-stone-300 bg-white pr-2 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400/30">
                  <input
                    data-testid="sender-local-input"
                    class="w-full bg-transparent px-3 py-2 font-mono text-sm outline-none"
                    placeholder="support"
                    value={sLocal}
                    onInput={(e: Event) => setSLocal((e.target as HTMLInputElement).value)}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === 'Enter' && sName.trim() && sLocal.trim()) void addSender();
                    }}
                  />
                  <span class="whitespace-nowrap font-mono text-sm text-stone-400">@{domain.domain}</span>
                </span>
                <Button
                  data-testid="add-sender"
                  onClick={() => void addSender()}
                  disabled={sBusy || !sName.trim() || !sLocal.trim()}
                >
                  Add sender
                </Button>
              </div>
              {sError ? <p data-testid="senders-error" class="mt-2 text-sm text-rose-600">{sError}</p> : null}
              <ul class="mt-3 space-y-1">
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
          )}
        </Card>
      </div>
    </section>
  );
}
