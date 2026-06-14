// Sending domains — the LIST, rendered as a panel inside Workspace settings
// (sending domains are per-workspace, §10). Just the domains + "Add domain".
// Adding opens the per-domain setup screen (/settings/domains/new); clicking a
// row opens that domain's setup screen (/settings/domains/:id) where it's
// verified (via SES) and its senders are managed.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, EmptyState } from '../ui/kit.js';

interface SendingDomain {
  id: string;
  domain: string;
  verified: boolean;
}

export function SendingDomainsPanel() {
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);

  useEffect(() => {
    void api.get<{ domains: SendingDomain[] }>('/sending-domains').then((r) => setDomains(r.domains));
  }, []);

  return (
    <div data-testid="sending-domains">
      <div class="mb-4 flex items-center justify-between gap-3">
        <p class="text-sm text-stone-500">
          The domains this workspace sends from. Open one to verify it and manage its senders.
        </p>
        <Button data-testid="add-domain" onClick={() => navigate('/settings/domains/new')}>
          Add domain
        </Button>
      </div>

      {domains === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : domains.length ? (
        <ul data-testid="domain-list" class="space-y-2">
          {domains.map((d) => (
            <li
              data-testid="domain-row"
              key={d.id}
              class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card hover:border-brand-300"
              onClick={() => navigate(`/settings/domains/${d.id}`)}
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
    </div>
  );
}
