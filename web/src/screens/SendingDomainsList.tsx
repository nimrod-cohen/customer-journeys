// Sending domains — the LIST screen (§10). Just the domains and an "Add domain"
// action. Adding opens the domain setup screen (/onboarding/new); clicking a row
// opens that domain's setup screen (/onboarding/:id) where it's verified (via a
// DNS lookup) and — once verified — its senders are managed. Nothing else lives
// on this screen.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, PageHeader, EmptyState } from '../ui/kit.js';

interface SendingDomain {
  id: string;
  domain: string;
  verified: boolean;
}

export function SendingDomainsList() {
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);

  useEffect(() => {
    void api.get<{ domains: SendingDomain[] }>('/sending-domains').then((r) => setDomains(r.domains));
  }, []);

  return (
    <section data-testid="sending-domains">
      <PageHeader
        title="Sending domains"
        subtitle="The domains this workspace sends from. Open one to verify it and manage its senders."
        actions={
          <Button data-testid="add-domain" onClick={() => navigate('/onboarding/new')}>
            Add domain
          </Button>
        }
      />

      {domains === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : domains.length ? (
        <ul data-testid="domain-list" class="space-y-2">
          {domains.map((d) => (
            <li
              data-testid="domain-row"
              key={d.id}
              class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card hover:border-brand-300"
              onClick={() => navigate(`/onboarding/${d.id}`)}
            >
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate font-mono text-sm font-semibold text-ink-900">{d.domain}</span>
                <Badge data-testid="domain-status" tone={d.verified ? 'success' : 'warn'}>
                  {d.verified ? 'verified' : 'pending'}
                </Badge>
              </span>
              <span class="text-stone-300">›</span>
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="domain-list">
          <EmptyState>No sending domains yet — add one to get started.</EmptyState>
        </div>
      )}
    </section>
  );
}
