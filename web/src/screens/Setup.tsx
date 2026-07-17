// Setup / readiness (§10). A single place that answers "am I set up to send?" — it
// fetches GET /company/readiness and renders one card per channel (Email / SMS /
// WhatsApp) plus an image-storage note. An `error`-severity check that isn't ready
// means the channel is HARD-DISABLED for broadcasts + automations (see the banner in
// AppShell); each failing sub-item links to the screen that fixes it.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Badge, Button, Card, PageHeader } from '../ui/kit.js';

interface ReadinessFix {
  label: string;
  route: string;
}
interface ReadinessItem {
  label: string;
  ok: boolean;
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
}

function statusBadge(c: ReadinessCheck) {
  if (c.status === 'ready') return <Badge tone="success">Ready</Badge>;
  if (c.severity === 'warning') return <Badge tone="warn">Optional</Badge>;
  return <Badge tone="danger">{c.status === 'incomplete' ? 'Incomplete' : 'Not set up'}</Badge>;
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

function CheckCard({ c }: { c: ReadinessCheck }) {
  const ring =
    c.status === 'ready'
      ? 'border-emerald-200'
      : c.severity === 'warning'
        ? 'border-amber-200'
        : 'border-rose-200';
  return (
    <Card data-testid={`readiness-${c.id}`} data-status={c.status} class={`p-5 ${ring}`}>
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-ink-900">{c.label}</h2>
        <span data-testid={`readiness-status-${c.id}`}>{statusBadge(c)}</span>
      </div>
      <p class="mt-1 text-sm text-stone-600">{c.summary}</p>
      <ul class="mt-4 space-y-2">
        {c.items.map((it, idx) => (
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

export function SetupScreen() {
  const [data, setData] = useState<WorkspaceReadiness | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    void api
      .get<WorkspaceReadiness>('/company/readiness')
      .then(setData)
      .catch(() => setErr('Could not load your setup status.'));
  }, []);

  const subtitle =
    data == null
      ? 'Checking what still needs configuring…'
      : data.errorCount > 0
        ? `${data.errorCount} thing${data.errorCount === 1 ? '' : 's'} to fix before you can send on every channel.`
        : 'Everything required to send is configured.';

  return (
    <section data-testid="setup-screen">
      <PageHeader title="Setup" subtitle={subtitle} />
      {err ? <Card class="p-5 text-sm text-rose-600">{err}</Card> : null}
      {data == null ? null : (
        <div class="space-y-4">
          {data.errorCount === 0 && data.warningCount === 0 ? (
            <Card data-testid="readiness-all-good" class="border-emerald-200 bg-emerald-50/50 p-5 text-sm text-emerald-800">
              ✓ You're fully set up — every channel is ready to send.
            </Card>
          ) : null}
          {data.checks.map((c) => (
            <CheckCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </section>
  );
}
