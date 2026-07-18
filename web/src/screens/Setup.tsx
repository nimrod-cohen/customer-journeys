// Setup / readiness (§10). A single place that answers "am I set up to send?" — it
// fetches GET /company/readiness and renders one card per channel (Email / SMS /
// WhatsApp) plus an image-storage note. An `error`-severity check that isn't ready means
// the channel is HARD-DISABLED for broadcasts + automations; each failing sub-item links
// to the screen that fixes it. The page can be SCOPED (via the route / tabs) to just the
// COMPANY-level (connectors/providers) or WORKSPACE-level (sending domains) requirements —
// this is what the Company/Workspace settings nav badges deep-link into.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, PageHeader } from '../ui/kit.js';

type ReadinessScope = 'company' | 'workspace';
type ScopeFilter = 'all' | ReadinessScope;

interface ReadinessFix {
  label: string;
  route: string;
}
interface ReadinessItem {
  label: string;
  ok: boolean;
  scope: ReadinessScope;
  fix?: ReadinessFix;
}
interface ReadinessCheck {
  id: 'email' | 'sms' | 'whatsapp' | 'storage';
  label: string;
  severity: 'error' | 'warning';
  status: 'ready' | 'incomplete' | 'not_configured';
  items: ReadinessItem[];
  summary: string;
}
export interface WorkspaceReadiness {
  checks: ReadinessCheck[];
  channels: { email: boolean; sms: boolean; whatsapp: boolean };
  errorCount: number;
  warningCount: number;
  companyErrorCount: number;
  workspaceErrorCount: number;
}

function statusBadge(status: ReadinessCheck['status'], severity: ReadinessCheck['severity']) {
  if (status === 'ready') return <Badge tone="success">Ready</Badge>;
  if (severity === 'warning') return <Badge tone="warn">Optional</Badge>;
  return <Badge tone="danger">{status === 'incomplete' ? 'Incomplete' : 'Not set up'}</Badge>;
}

function CheckIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0 text-emerald-600" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0 text-rose-500" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
    </svg>
  );
}

/** A check card, showing only the items in the active scope filter, with a status pill
 *  recomputed from THOSE items (so an email card under "Workspace" reflects only its
 *  domain/sender requirements). */
function CheckCard({ c, filter }: { c: ReadinessCheck; filter: ScopeFilter }) {
  const items = filter === 'all' ? c.items : c.items.filter((it) => it.scope === filter);
  const status: ReadinessCheck['status'] =
    items.every((it) => it.ok) ? 'ready' : c.severity === 'warning' ? 'not_configured' : 'incomplete';
  const ring =
    status === 'ready' ? 'border-emerald-200' : c.severity === 'warning' ? 'border-amber-200' : 'border-rose-200';
  return (
    <Card data-testid={`readiness-${c.id}`} data-status={status} class={`p-5 ${ring}`}>
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">{c.label}</h2>
        <span data-testid={`readiness-status-${c.id}`}>{statusBadge(status, c.severity)}</span>
      </div>
      <ul class="mt-4 space-y-2">
        {items.map((it, idx) => (
          <li key={idx} class="flex items-center justify-between gap-3">
            <span class="flex items-center gap-2 text-sm text-ink-800">
              <CheckIcon ok={it.ok} />
              {it.label}
            </span>
            {!it.ok && it.fix ? (
              <Button variant="ghost" data-testid={`readiness-fix-${c.id}`} onClick={() => navigate(it.fix!.route)}>
                {it.fix.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const FILTER_TABS: { id: ScopeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'company', label: 'Company connectors' },
  { id: 'workspace', label: 'Sending domains' },
];

export function SetupScreen({ scope = 'all' }: { scope?: ScopeFilter }) {
  const [data, setData] = useState<WorkspaceReadiness | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<ScopeFilter>(scope);
  // Follow the route scope when it changes (a different badge deep-links a different scope).
  useEffect(() => {
    setFilter(scope);
  }, [scope]);

  useEffect(() => {
    void api
      .get<WorkspaceReadiness>('/company/readiness')
      .then(setData)
      .catch(() => setErr('Could not load your setup status.'));
  }, []);

  // Only the checks that have a requirement in the active scope.
  const visibleChecks =
    data == null
      ? []
      : data.checks.filter((c) => filter === 'all' || c.items.some((it) => it.scope === filter));
  const scopeErrors =
    filter === 'company' ? data?.companyErrorCount ?? 0 : filter === 'workspace' ? data?.workspaceErrorCount ?? 0 : data?.errorCount ?? 0;

  const subtitle =
    data == null
      ? 'Checking what still needs configuring…'
      : scopeErrors > 0
        ? `${scopeErrors} thing${scopeErrors === 1 ? '' : 's'} to fix.`
        : 'Everything required here is configured.';

  return (
    <section data-testid="setup-screen">
      <PageHeader title="Setup" subtitle={subtitle} />

      {/* Scope filter — All / Company connectors / Sending domains. */}
      <div class="mb-5 inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
        {FILTER_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`setup-filter-${t.id}`}
            aria-pressed={filter === t.id}
            onClick={() => setFilter(t.id)}
            class={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              filter === t.id ? 'bg-brand-500 text-ink-950' : 'text-stone-600 hover:bg-stone-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {err ? <Card class="p-5 text-sm text-rose-600">{err}</Card> : null}
      {data == null ? null : (
        <div class="space-y-4">
          {scopeErrors === 0 ? (
            <Card data-testid="readiness-all-good" class="border-emerald-200 bg-emerald-50/50 p-5 text-sm text-emerald-800">
              ✓ {filter === 'all' ? 'Everything required to send is configured.' : 'Nothing to fix here.'}
            </Card>
          ) : null}
          {visibleChecks.map((c) => (
            <CheckCard key={c.id} c={c} filter={filter} />
          ))}
        </div>
      )}
    </section>
  );
}
