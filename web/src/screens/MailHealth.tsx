// Mail health (system-admin only): is each of our sending IPs getting through to
// Google, Microsoft and Apple, and is it on a blocklist? Every verdict is computed by
// the server (`services/local-api/src/mail-health.ts`); this screen only shows it.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Card, PageHeader } from '../ui/kit.js';

type Tone = 'neutral' | 'success' | 'warn' | 'danger';

interface ProviderRow {
  provider: string;
  label: string;
  status: 'ok' | 'blocked' | 'throttled' | 'unreachable' | 'unknown';
  code: number | null;
  block_code: string | null;
  reply: string | null;
}
interface ListRow {
  zone: string;
  name: string;
  status: 'clean' | 'listed' | 'unknown';
  detail: string | null;
}
interface ServerRow {
  ip: string;
  name: string;
  role: string;
  delivering: boolean;
  checked_at: string | null;
  stale: boolean;
  providers: ProviderRow[];
  blocklists: ListRow[];
}
interface Issue {
  severity: 'warning' | 'critical';
  title: string;
  detail: string | null;
  help: string | null;
}
interface Rejection {
  provider: string;
  label: string;
  count: number;
  workspaces: number;
  last_at: string;
  sample: string | null;
}
export interface MailHealthData {
  status: 'ok' | 'warning' | 'critical';
  issues: Issue[];
  servers: ServerRow[];
  rejections: Rejection[];
  generated_at: string;
}

const OVERALL: Record<MailHealthData['status'], { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'All clear' },
  warning: { tone: 'warn', label: 'Needs attention' },
  critical: { tone: 'danger', label: 'Mail is being blocked' },
};
const PROVIDER_STATUS: Record<ProviderRow['status'], { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'Accepted' },
  blocked: { tone: 'danger', label: 'Blocked' },
  throttled: { tone: 'warn', label: 'Temporarily refused' },
  unreachable: { tone: 'warn', label: 'Unreachable' },
  unknown: { tone: 'neutral', label: 'Not checked' },
};
const LIST_STATUS: Record<ListRow['status'], { tone: Tone; label: string }> = {
  clean: { tone: 'success', label: 'Not listed' },
  listed: { tone: 'danger', label: 'Listed' },
  unknown: { tone: 'neutral', label: 'Could not check' },
};

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : 'Never');

function ServerCard({ server }: { server: ServerRow }) {
  return (
    <Card data-testid="mail-health-server" data-ip={server.ip} class="p-5">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-semibold text-ink-900">{server.name}</h2>
        <span class="text-sm text-stone-500">
          {server.ip} · {server.role}
        </span>
        {server.delivering ? <Badge tone="success">Delivering mail now</Badge> : null}
        {server.stale ? <Badge tone="warn">Checks stopped</Badge> : null}
      </div>
      <p class="mt-1 text-sm text-stone-500">Last checked: {when(server.checked_at)}</p>

      <h3 class="mt-4 text-sm font-semibold text-ink-900">Mail providers</h3>
      <ul class="mt-2 divide-y divide-stone-200">
        {server.providers.map((p) => (
          <li data-testid="mail-health-provider" data-provider={p.provider} key={p.provider} class="py-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm text-ink-900">{p.label}</span>
              <span class="flex items-center gap-2">
                {p.block_code ? <code class="text-xs text-stone-500">{p.block_code}</code> : null}
                <Badge tone={PROVIDER_STATUS[p.status].tone}>{PROVIDER_STATUS[p.status].label}</Badge>
              </span>
            </div>
            {p.reply ? <p class="mt-1 break-words text-xs text-stone-500">{p.reply}</p> : null}
          </li>
        ))}
      </ul>

      <h3 class="mt-4 text-sm font-semibold text-ink-900">Blocklists</h3>
      <ul class="mt-2 divide-y divide-stone-200">
        {server.blocklists.map((l) => (
          <li data-testid="mail-health-blocklist" data-zone={l.zone} key={l.zone} class="flex items-center justify-between gap-3 py-2">
            <span class="text-sm text-ink-900">
              {l.name}
              {l.detail ? <span class="ml-2 text-xs text-stone-500">{l.detail}</span> : null}
            </span>
            <Badge tone={LIST_STATUS[l.status].tone}>{LIST_STATUS[l.status].label}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function MailHealth() {
  const [health, setHealth] = useState<MailHealthData | null>(null);
  const [error, setError] = useState('');

  const load = async (): Promise<void> => {
    setError('');
    try {
      const r = await api.get<{ health: MailHealthData }>('/admin/mail-health');
      setHealth(r.health);
    } catch (e) {
      setError((e as { error?: string })?.error ?? 'Could not load mail health');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <section data-testid="mail-health-screen">
      <PageHeader
        title="Mail health"
        subtitle="Whether Google, Microsoft and Apple accept mail from our servers, checked hourly from each server."
        actions={
          <Button data-testid="mail-health-refresh" variant="secondary" onClick={load}>
            Refresh
          </Button>
        }
      />
      {error ? <p data-testid="mail-health-error" class="mb-4 text-sm text-rose-600">{error}</p> : null}
      {!health && !error ? <p class="text-sm text-stone-500">Loading…</p> : null}
      {health ? (
        <div class="space-y-4">
          <Card class="p-5">
            <div class="flex items-center gap-3">
              <span data-testid="mail-health-status" data-status={health.status}>
                <Badge tone={OVERALL[health.status].tone}>{OVERALL[health.status].label}</Badge>
              </span>
              <span class="text-sm text-stone-500">
                {health.issues.length === 0
                  ? 'No problems found.'
                  : `${health.issues.length} issue${health.issues.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {health.issues.length > 0 ? (
              <ul class="mt-3 space-y-3">
                {health.issues.map((i) => (
                  <li data-testid="mail-health-issue" data-severity={i.severity} key={i.title}>
                    <div class="flex items-center gap-2">
                      <Badge tone={i.severity === 'critical' ? 'danger' : 'warn'}>
                        {i.severity === 'critical' ? 'Critical' : 'Warning'}
                      </Badge>
                      <span class="text-sm font-medium text-ink-900">{i.title}</span>
                      {i.help ? (
                        <a class="text-sm text-brand-600 hover:underline" href={i.help} target="_blank" rel="noopener noreferrer">
                          How to fix
                        </a>
                      ) : null}
                    </div>
                    {i.detail ? <p class="mt-1 break-words text-xs text-stone-500">{i.detail}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <div class="grid gap-4 lg:grid-cols-2">
            {health.servers.map((s) => (
              <ServerCard key={s.ip} server={s} />
            ))}
          </div>

          <Card class="p-5">
            <h2 class="text-lg font-semibold text-ink-900">Real rejections, last 7 days</h2>
            <p class="mt-1 text-sm text-stone-500">
              Some blocks only appear after a message is sent, so a passing check above does not guarantee delivery.
            </p>
            {health.rejections.length === 0 ? (
              <p data-testid="mail-health-no-rejections" class="mt-3 text-sm text-stone-500">No policy rejections.</p>
            ) : (
              <ul class="mt-3 divide-y divide-stone-200">
                {health.rejections.map((r) => (
                  <li data-testid="mail-health-rejection" key={r.provider} class="py-2">
                    <p class="text-sm text-ink-900">
                      {r.label}: {r.count} message{r.count === 1 ? '' : 's'} across {r.workspaces} workspace
                      {r.workspaces === 1 ? '' : 's'}, latest {when(r.last_at)}
                    </p>
                    {r.sample ? <p class="mt-1 break-words text-xs text-stone-500">{r.sample}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </section>
  );
}
