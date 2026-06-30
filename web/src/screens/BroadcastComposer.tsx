// Broadcasts (§12, §9A): a LIST screen + a multi-step creation/edit WIZARD.
// - BroadcastComposer (/broadcasts): all broadcasts; "New broadcast" → the wizard;
//   draft/scheduled rows can be edited or sent; sent/sending rows are read-only.
// - BroadcastWizard (/broadcasts/new, /broadcasts/:id): Audience → Content →
//   Schedule. Editing is allowed only while draft or scheduled.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { takeReturnedTemplate, takeReturnedTo } from '../store/editorReturn.js';
import { openEmailDesigner } from '../store/emailDesignerDrawer.js';
import { ActionMenu, Badge, Button, Card, Field, Input, PageHeader, Pagination, Select, DirectionalTextarea, EmptyState, toneFor } from '../ui/kit.js';
import { usePagedList } from '../ui/usePagedList.js';
import type { ActionMenuItem } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { askConfirm } from '../ui/dialog.tsx';
import { timeZoneList, zonedInputToUtcIso, utcIsoToZonedInput } from '@cdp/shared';
import { RuleBuilder } from '../segments/RuleBuilder.js';
import {
  emptyRow,
  buildAstFromGroup,
  groupHasCriteria,
  groupFromAst,
  type RuleRow,
  type RuleGroup,
  type Combinator,
  type AstNode,
} from '../segments/ast-builder.js';

interface Segment {
  id: string;
  name: string;
}
interface Template {
  id: string;
  name: string;
}
interface BroadcastStats {
  sent: number;
  delivered: number;
  failed: number;
  clicked: number;
  opened: number;
  unsubscribed: number;
}
/** The sending channel of a broadcast. */
type Medium = 'email' | 'sms' | 'whatsapp';
const MEDIUM_LABEL: Record<Medium, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

interface Broadcast {
  id: string;
  name: string;
  status: string;
  /** Sending channel (email default). */
  medium?: Medium;
  scheduled_at: string | null;
  /** The IANA zone the send time was expressed in (null unless scheduled). */
  scheduled_tz?: string | null;
  sent_at: string | null;
  updated_at: string | null;
  stats?: BroadcastStats;
}

const EDITABLE = new Set(['draft', 'scheduled']);

/** "today at 8:15 AM" / "tomorrow at 10:45 AM" / "Jun 7 at 8:22 PM" + the tz abbr.
 *  When `tz` (an IANA zone) is given, the time + abbreviation are shown in it. */
function whenLabel(ts: string, tz?: string | null): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const zone = tz || undefined;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: zone });
  const day0 = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const diff = day0(d) - day0(new Date());
  const rel = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff === -1 ? 'yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: zone });
  const tzName = new Intl.DateTimeFormat([], { timeZoneName: 'short', timeZone: zone }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${rel} at ${time}${tzName ? ` (${tzName})` : ''}`;
}

/** Countdown to a future send: "in 2 days, 5 hours, 30 minutes" (top 3 units).
 *  `nowMs` is passed in so the caller can re-render it live on a timer. */
function untilLabel(ts: string, nowMs: number): string {
  const target = new Date(ts).getTime();
  if (Number.isNaN(target)) return '';
  const secs = Math.floor((target - nowMs) / 1000);
  if (secs <= 0) return 'sending now';
  const unit = (n: number, s: number, label: string) => {
    const v = Math.floor(n / s);
    return { v, rest: n - v * s, txt: v ? `${v} ${label}${v === 1 ? '' : 's'}` : '' };
  };
  const d = unit(secs, 86_400, 'day');
  const h = unit(d.rest, 3_600, 'hour');
  const m = unit(h.rest, 60, 'minute');
  const parts = [d.txt, h.txt, m.txt].filter(Boolean);
  // Always show at least minutes (e.g. "in 0 minutes" → show "in 1 minute" floor).
  if (parts.length === 0) parts.push('less than a minute');
  return `in ${parts.join(', ')}`;
}

/** "a day ago" / "3 hours ago" via Intl.RelativeTimeFormat. */
function agoLabel(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.round((d.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3_600], ['minute', 60],
  ];
  for (const [unit, s] of units) {
    if (Math.abs(secs) >= s || unit === 'minute') return rtf.format(Math.round(secs / s), unit);
  }
  return 'just now';
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '0%';
}

/** One compact funnel cell: a label, a COUNT, and a small % beneath it. */
function FunnelCell({
  label,
  count,
  denom,
  testid,
  tone,
}: {
  label: string;
  count: number;
  /** Denominator for the % (sent or delivered, per the funnel). 0 → "0%". */
  denom: number;
  testid: string;
  tone?: string;
}) {
  return (
    <span class="flex flex-col items-center" data-testid={testid} title={`${count} (${pct(count, denom)})`}>
      <span class="text-[10px] uppercase tracking-wide text-stone-400">{label}</span>
      <span class={`font-semibold tabular-nums ${tone ?? 'text-ink-900'}`} data-testid={`${testid}-count`}>
        {count}
      </span>
      <span class="text-[10px] tabular-nums text-stone-400" data-testid={`${testid}-pct`}>
        {pct(count, denom)}
      </span>
    </span>
  );
}


// --- List screen ------------------------------------------------------------

export function BroadcastComposer() {
  // Server-paged + server-searched list (numbered pages).
  const list = usePagedList<Broadcast>(async ({ limit, page, q }) => {
    const b = await api.get<{ broadcasts: Broadcast[]; total: number }>('/broadcasts', {
      query: { limit: String(limit), page: String(page), q },
    });
    return { rows: b.broadcasts, total: b.total };
  });
  const broadcasts = list.loaded ? list.rows : null;
  // Sending is refused server-side (409) unless the workspace has a verified
  // sending domain. We learn this up front so we can warn + disable Send rather
  // than letting the user click into the refusal. null = not yet known.
  const [hasVerifiedDomain, setHasVerifiedDomain] = useState<boolean | null>(null);
  // The broadcast currently being sent → lock + spin its Send button so it can't
  // be double-clicked while the request is in flight.
  const [sendingId, setSendingId] = useState<string | null>(null);
  // Ticks once a minute so the "in X days, Y hours" countdown on scheduled
  // broadcasts stays live without a reload.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const reload = async () => list.reload();
  useEffect(() => {
    void api
      .get<{ domains: Array<{ verified: boolean }> }>('/sending-domains')
      .then((r) => setHasVerifiedDomain(r.domains.some((d) => d.verified)))
      .catch(() => setHasVerifiedDomain(true)); // don't block on a fetch error — the server still gates
  }, []);

  const send = async (id: string) => {
    if (sendingId) return; // a send is already in flight
    setSendingId(id);
    try {
      const res = await api.post<{ result: { result?: string } }>(`/broadcasts/${id}/send`, {});
      const outcome = res.result?.result ?? 'queued';
      showToast(`Broadcast ${outcome}.`, { tone: 'success' });
      await reload();
    } catch (e) {
      // e.g. 409 when the workspace has no verified sending domain.
      showToast((e as { error?: string })?.error ?? 'Could not send the broadcast.', { tone: 'error' });
    } finally {
      setSendingId(null);
    }
  };

  // Duplicate any broadcast → a fresh DRAFT (its own email copy) you can tweak/resend.
  const duplicate = async (id: string) => {
    try {
      await api.post(`/broadcasts/${id}/duplicate`, {});
      showToast('Broadcast duplicated as a draft.', { tone: 'success' });
      await reload();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not duplicate the broadcast.', { tone: 'error' });
    }
  };

  // Delete an UNSENT broadcast (draft/scheduled). Styled confirm — never native.
  const remove = async (id: string, name: string) => {
    const ok = await askConfirm({
      title: 'Delete broadcast?',
      message: `“${name}” will be permanently deleted. This can't be undone.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await api.del(`/broadcasts/${id}`);
      showToast('Broadcast deleted.', { tone: 'success' });
      await reload();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'Could not delete the broadcast.', { tone: 'error' });
    }
  };

  // Don't disable Send while we're still discovering the domain state (null) —
  // only once we KNOW there's no verified domain.
  const blockSend = hasVerifiedDomain === false;

  return (
    <section data-testid="broadcast-composer">
      <PageHeader
        title="Broadcasts"
        subtitle="Send a one-off email to a segment or manual group."
        actions={
          <span class="flex items-center gap-2">
            <Button data-testid="new-broadcast" onClick={() => navigate('/broadcasts/new')}>
              New broadcast
            </Button>
          </span>
        }
      />

      {blockSend ? (
        <div
          data-testid="no-domain-banner"
          role="alert"
          class="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <svg viewBox="0 0 20 20" fill="none" class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" stroke="currentColor" stroke-width="2">
            <path d="M10 2 1.5 17h17L10 2Z" stroke-linejoin="round" />
            <path d="M10 8v4M10 14.5h.01" stroke-linecap="round" />
          </svg>
          <span class="min-w-0 flex-1">
            No verified sending domain — broadcasts can’t be sent yet. Verify one in Workspace settings → Sending domains.
          </span>
          <button
            type="button"
            data-testid="no-domain-open-settings"
            class="shrink-0 rounded-lg border border-amber-400 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            onClick={() => navigate('/settings/domains')}
          >
            Open settings →
          </button>
        </div>
      ) : null}

      <div class="mb-4 max-w-sm">
        <Input
          data-testid="broadcast-search"
          type="search"
          placeholder="Search broadcasts by name…"
          value={list.q}
          onInput={(e: Event) => list.setQ((e.target as HTMLInputElement).value)}
        />
      </div>

      {broadcasts === null ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : broadcasts.length ? (
        <ul data-testid="broadcast-list" class="space-y-2">
          {broadcasts.map((b) => {
            const editable = EDITABLE.has(b.status);
            const subtitle =
              b.status === 'scheduled' && b.scheduled_at
                ? `Scheduled to send ${whenLabel(b.scheduled_at, b.scheduled_tz)} · ${untilLabel(b.scheduled_at, nowMs)}`
                : b.status === 'sent' && b.sent_at
                  ? `Sent ${whenLabel(b.sent_at)}`
                  : b.status === 'sending'
                    ? 'Sending…'
                    : 'Draft — not scheduled';
            const s = b.stats;
            return (
              <li
                data-testid="broadcast-item"
                key={b.id}
                // Fixed grid columns so the status badge and the right-hand slot
                // line up across rows (icon · name/1fr · status · right slot). On
                // mobile it collapses to two columns (icon · name) with the status
                // and right slot wrapping onto their own full-width rows.
                class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-card sm:grid-cols-[auto_minmax(0,1fr)_7rem_auto] sm:gap-4"
              >
                {/* Icon */}
                <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5 shrink-0 self-start text-stone-400" stroke="currentColor" stroke-width="1.8">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m4 7 8 6 8-6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>

                {/* Name + subtitle + edited */}
                <span class="flex min-w-0 flex-col">
                  <a
                    data-testid="broadcast-open"
                    class="cursor-pointer truncate font-semibold text-ink-900 hover:text-brand-700"
                    onClick={() => navigate(`/broadcasts/${b.id}`)}
                  >
                    {b.name}
                  </a>
                  <span class="truncate text-xs text-stone-500">{subtitle}</span>
                  {b.updated_at ? <span class="truncate text-[11px] text-stone-400">Edited {agoLabel(b.updated_at)}</span> : null}
                </span>

                {/* Status + channel badges — fixed column → aligned across rows.
                    On mobile they wrap below the name (full row, col 2). */}
                <span class="col-start-2 flex flex-row flex-wrap items-start gap-1 justify-self-start sm:col-start-auto sm:flex-col">
                  <Badge data-testid="broadcast-status" tone={toneFor(b.status)}>
                    {b.status}
                  </Badge>
                  <Badge data-testid="broadcast-medium-badge" tone="neutral">
                    {MEDIUM_LABEL[(b.medium ?? 'email') as Medium]}
                  </Badge>
                </span>

                {/* Right slot: metrics (sent) OR actions (draft/scheduled). On mobile
                    it spans the full row and wraps; right-aligned at sm+. */}
                <span class="col-start-2 flex flex-wrap items-center justify-start gap-x-4 gap-y-2 sm:col-start-auto sm:flex-nowrap sm:justify-end">
                  {b.status === 'sent' && s ? (
                    // The conversion funnel: Sent · Delivered · Failed (of sent) ·
                    // Opened · Clicked · Unsubscribed (of delivered). Each cell is a
                    // count + a small %. (0% when the denominator is 0.)
                    <span data-testid="broadcast-metrics" class="flex items-center gap-4 text-center text-sm">
                      <FunnelCell label="Sent" count={s.sent} denom={s.sent} testid="bc-sent" />
                      <FunnelCell label="Delivered" count={s.delivered} denom={s.sent} testid="bc-delivered" />
                      <FunnelCell label="Failed" count={s.failed} denom={s.sent} testid="bc-failed" tone={s.failed > 0 ? 'text-rose-600' : 'text-stone-500'} />
                      <FunnelCell label="Opened" count={s.opened} denom={s.delivered} testid="bc-opened" tone="text-sky-700" />
                      <FunnelCell label="Clicked" count={s.clicked} denom={s.delivered} testid="bc-clicked" tone="text-emerald-700" />
                      <FunnelCell label="Unsub" count={s.unsubscribed} denom={s.delivered} testid="bc-unsubscribed" tone={s.unsubscribed > 0 ? 'text-amber-700' : 'text-stone-500'} />
                    </span>
                  ) : null}
                  {/* All row actions consolidated into one kebab (⋮) menu. Edit/Send/
                      Delete only for unsent (draft/scheduled); Duplicate always. */}
                  <ActionMenu
                    data-testid="broadcast-actions"
                    items={[
                      ...(editable
                        ? [
                            {
                              label: b.status === 'scheduled' ? 'Continue editing' : 'Edit',
                              onSelect: () => navigate(`/broadcasts/${b.id}`),
                              'data-testid': 'broadcast-edit',
                            } satisfies ActionMenuItem,
                          ]
                        : []),
                      {
                        label: 'Duplicate',
                        onSelect: () => duplicate(b.id),
                        'data-testid': 'broadcast-duplicate',
                      },
                      ...(editable
                        ? [
                            {
                              label: 'Send',
                              onSelect: () => send(b.id),
                              // The no-verified-domain block is EMAIL-only — SMS/
                              // WhatsApp don't need a sending domain.
                              disabled: (blockSend && (b.medium ?? 'email') === 'email') || sendingId !== null,
                              ...(blockSend && (b.medium ?? 'email') === 'email'
                                ? { title: 'Verify a sending domain in Workspace settings before sending.' }
                                : {}),
                              'data-testid': 'send-broadcast',
                            } satisfies ActionMenuItem,
                            {
                              label: 'Delete',
                              onSelect: () => remove(b.id, b.name),
                              danger: true,
                              'data-testid': 'broadcast-delete',
                            } satisfies ActionMenuItem,
                          ]
                        : []),
                    ]}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div data-testid="broadcast-list">
          <EmptyState>{list.q ? 'No broadcasts match your search.' : 'No broadcasts yet — create one with “New broadcast”.'}</EmptyState>
        </div>
      )}

      <Pagination page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
    </section>
  );
}

// --- Creation / edit wizard -------------------------------------------------

const STEPS = ['Audience', 'Content', 'Schedule'] as const;

/** A scheduled send must be at least this far in the future — you can't schedule
 *  in the past or so close the sweep can't act on it. Mirrored on the server. */
const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

// DST-correct zoned↔UTC helpers + the IANA picker list now live in @cdp/shared
// (timeZoneList / tzOffsetMs / zonedInputToUtcIso / utcIsoToZonedInput) so the
// broadcast scheduler and campaign time math share ONE implementation (§9B).

/** The browser's IANA zone — the sensible default for "send at this time". */
const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export function BroadcastWizard({ id }: { id?: string }) {
  // When designing an email for a BRAND-NEW broadcast we create the draft up front
  // and keep its id here (the route prop stays undefined since we don't navigate) —
  // so the designer drawer + later saves act on that same draft, not a new one.
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const effectiveId = id ?? createdId;
  const editing = Boolean(effectiveId);
  const [step, setStep] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState('');
  // The AUDIENCE is now a comprehensive segment-style RULE (§9A): attribute + event
  // conditions AND segment-membership leaves ("is / is NOT a member of segment X")
  // combined with AND/OR groups. State mirrors SegmentBuilder; compiled with
  // buildAstFromGroup → sent as `audience`. A legacy single-segment broadcast hydrates
  // as one "is a member of <segment>" row.
  const [audRows, setAudRows] = useState<RuleRow[]>([emptyRow()]);
  const [audCombinator, setAudCombinator] = useState<Combinator>('and');
  const [audGroups, setAudGroups] = useState<RuleGroup[]>([]);
  // Live recipient estimate for the current rule (debounced /broadcasts/audience-preview).
  const [audCount, setAudCount] = useState<number | null>(null);
  const [audCountErr, setAudCountErr] = useState('');
  // The sending channel. Email uses the email-instance/envelope flow; sms/whatsapp
  // use a plain-text body (merge-tag enabled) sent to the recipient phone.
  const [medium, setMedium] = useState<Medium>('email');
  const [textBody, setTextBody] = useState('');
  const [tplId, setTplId] = useState('');
  // Optional TOPIC tag (subscription gating): a recipient unsubscribed from this
  // topic is skipped at send. '' = no topic (sends to everyone not opted out).
  const [topics, setTopics] = useState<{ id: string; name: string }[]>([]);
  const [topicId, setTopicId] = useState('');
  // Reusable text templates (SMS/WhatsApp). Picking one COPIES its body into the
  // text-body field below (copy-on-select — the user can still edit). No live ref.
  const [textTemplates, setTextTemplates] = useState<{ id: string; name: string; body: string }[]>([]);
  // The broadcast's WORKING COPY of a template (kind='copy'): picking a library
  // template clones it so this broadcast's content is independently editable and
  // the library original stays pristine.
  const [attachedCopy, setAttachedCopy] = useState<{ id: string; name: string } | null>(null);
  // Bumped when the designer drawer closes so the envelope re-fetches even when the
  // copy id is unchanged (re-designing the SAME copy must reflect new From/Subject).
  const [envelopeTick, setEnvelopeTick] = useState(0);
  // The attached email's envelope (From sender / To / Subject). All three must be
  // filled to leave the Content step — fetched whenever the instance changes.
  const [envelope, setEnvelope] = useState<{ subject: string; sender_id: string | null; to_address: string } | null>(
    null,
  );
  const [scheduleMode, setScheduleMode] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [timeZone, setTimeZone] = useState(BROWSER_TZ);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A sent/sending/cancelled broadcast is no longer editable → show a read-only
  // preview of the email instead of the wizard (and instead of bouncing away).
  const [viewOnly, setViewOnly] = useState(false);
  // Ticks each minute so the "≥ 5 minutes from now" schedule check stays current.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void Promise.all([
      api.get<{ segments: Segment[] }>('/segments'),
      api.get<{ templates: Template[] }>('/templates'),
      api.get<{ topics: { id: string; name: string }[] }>('/topics'),
      api.get<{ templates: { id: string; name: string; body: string }[] }>('/text-templates'),
    ]).then(([s, t, tp, tt]) => {
      setSegments(s.segments);
      setTemplates(t.templates);
      setTopics(tp.topics);
      setTextTemplates(tt.templates);
    });
  }, []);

  // Edit mode: load the broadcast and prefill. A sent/sending broadcast is not
  // editable → bounce back to the list.
  useEffect(() => {
    if (!id) return;
    void api
      .get<{ broadcast: Broadcast & { audience_ref: string | null; audience: AstNode | null; template_id: string | null; text_body: string | null; topic_id: string | null } }>(`/broadcasts/${id}`)
      .then((r) => {
        const b = r.broadcast;
        if (!EDITABLE.has(b.status)) {
          setViewOnly(true); // sent/sending/cancelled → read-only preview
          return;
        }
        setName(b.name);
        // Hydrate the audience rule: a new broadcast carries the `audience` AST; a LEGACY
        // single-segment one (audience_ref, no audience) opens as one "is a member of X" row.
        const audAst: AstNode | null = b.audience ?? (b.audience_ref ? { segment: b.audience_ref } : null);
        const g = groupFromAst(audAst);
        setAudRows(g.rows);
        setAudCombinator(g.combinator);
        setAudGroups(g.groups);
        setMedium((b.medium ?? 'email') as Medium);
        setTextBody(b.text_body ?? '');
        setTplId(b.template_id ?? '');
        setTopicId(b.topic_id ?? '');
        if (b.scheduled_at) {
          const tz = b.scheduled_tz || BROWSER_TZ;
          setScheduleMode('later');
          setTimeZone(tz);
          setScheduledAt(utcIsoToZonedInput(b.scheduled_at, tz));
        }
        // Returning from the email editor (Design email): jump to the Content step
        // and select the template we just saved. Applied AFTER the broadcast's own
        // fields so it wins over the (older) saved template_id. We land on Content
        // whenever we came back from designing THIS broadcast's email — even if no
        // copy was saved (returnedTo), not only when a template id came back.
        const justSaved = takeReturnedTemplate();
        const returnedHere = takeReturnedTo() === `/broadcasts/${id}`;
        if (justSaved) setTplId(justSaved);
        if (justSaved || returnedHere) setStep(1);
        // Resolve the attached template: a kind='copy' row is this broadcast's
        // working copy (shown as such in the dropdown).
        const attached = justSaved || b.template_id;
        if (attached) {
          void api
            .get<{ template: { id: string; name: string; kind: string } }>(`/templates/${attached}`)
            .then((t) => {
              if (t.template.kind === 'copy') setAttachedCopy({ id: t.template.id, name: t.template.name });
            })
            .catch(() => undefined);
        }
      })
      .catch(() => navigate('/broadcasts'));
  }, [id]);

  // Live recipient estimate for the current audience rule (debounced). A null rule (no
  // conditions) shows no count; a compile/validation error surfaces inline.
  useEffect(() => {
    const grp = { combinator: audCombinator, rows: audRows, groups: audGroups };
    const ast = groupHasCriteria(grp) ? buildAstFromGroup(grp) : null;
    if (ast === null) {
      setAudCount(null);
      setAudCountErr('');
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void api
        .post<{ count: number }>('/broadcasts/audience-preview', { body: { audience: ast } })
        .then((r) => {
          if (!cancelled) {
            setAudCount(r.count);
            setAudCountErr('');
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setAudCount(null);
            setAudCountErr((e as { error?: string })?.error ?? 'Could not estimate the audience.');
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [audRows, audCombinator, audGroups]);

  // Load the attached email's envelope (From/To/Subject) so the Content step can
  // require all three before advancing. Re-runs whenever the instance changes
  // (picked a template, designed one, or returned from the editor).
  useEffect(() => {
    if (!attachedCopy) {
      setEnvelope(null);
      return;
    }
    void api
      .get<{ template: { subject: string | null; sender_id: string | null; to_address: string | null } }>(
        `/templates/${attachedCopy.id}`,
      )
      .then((r) =>
        setEnvelope({
          subject: r.template.subject ?? '',
          sender_id: r.template.sender_id ?? null,
          to_address: r.template.to_address ?? '',
        }),
      )
      .catch(() => setEnvelope(null));
  }, [attachedCopy?.id, envelopeTick]);

  /**
   * Template picked in the dropdown. A LIBRARY template is CLONED on the spot —
   * the broadcast then points at its own mutable copy (re-editable via Design
   * email) and the library original is never touched. Re-picking the existing
   * copy just selects it.
   */
  const pickTemplate = async (value: string): Promise<void> => {
    if (!value || value === attachedCopy?.id) {
      setTplId(value);
      return;
    }
    const lib = templates.find((t) => t.id === value);
    if (!lib) {
      setTplId(value);
      return;
    }
    const r = await api.post<{ template: { id: string; name: string } }>(`/templates/${value}/clone`, { body: {} });
    setAttachedCopy({ id: r.template.id, name: r.template.name });
    setTplId(r.template.id);
  };

  /**
   * Discard the chosen email and start over (choose a different template, or a
   * blank design). The previously cloned working copy simply becomes unreferenced
   * — it was never a library entry — and the next choice replaces it.
   */
  const resetEmail = (): void => {
    setAttachedCopy(null);
    setTplId('');
  };

  /** Select a just-designed template and resolve its working copy (mirrors the
   *  old editor-return handling, now driven by the designer drawer's onClose). */
  const applyDesignedTemplate = (tid: string): void => {
    setTplId(tid);
    void api
      .get<{ template: { id: string; name: string; kind: string } }>(`/templates/${tid}`)
      .then((t) => {
        if (t.template.kind === 'copy') setAttachedCopy({ id: t.template.id, name: t.template.name });
      })
      .catch(() => undefined);
  };

  /**
   * Design content for THIS broadcast. We persist the broadcast as a draft first
   * (so the wizard state survives and there's a row to attach the copy to), then
   * open the email designer in a sliding DRAWER over the wizard (no navigation).
   */
  const designEmail = async () => {
    const scheduledIso = scheduleMode === 'later' && scheduledAt ? zonedInputToUtcIso(scheduledAt, timeZone) : null;
    const body = {
      name: name || 'Untitled broadcast',
      medium,
      text_body: medium === 'email' ? null : textBody,
      audience: audienceAst,
      template_id: tplId || null,
      topic_id: topicId || null,
      scheduled_at: scheduledIso,
      scheduled_tz: scheduledIso ? timeZone : null,
    };
    let bid = effectiveId;
    if (effectiveId) {
      await api.put(`/broadcasts/${effectiveId}`, { body });
    } else {
      const r = await api.post<{ broadcast: { id: string } }>('/broadcasts', { body });
      bid = r.broadcast.id;
      setCreatedId(bid); // keep editing THIS draft (no route nav)
      history.replaceState(null, '', `#/broadcasts/${bid}`); // so a refresh reloads it
    }
    // Open the email designer in a sliding DRAWER over the wizard (no navigation;
    // the wizard stays mounted). On close: a blank design created a NEW copy →
    // select it; an existing copy edited in place → just refresh the Content step.
    openEmailDesigner({
      id: tplId || undefined,
      createAs: tplId ? undefined : 'copy',
      title: 'Design email',
      onClose: (savedId) => {
        if (savedId) applyDesignedTemplate(savedId);
        setEnvelopeTick((t) => t + 1); // re-fetch the envelope even if the copy id is unchanged
        setStep(1);
      },
    });
  };

  // The compiled audience rule (null = no MEANINGFUL conditions yet). `groupHasCriteria`
  // is stricter than `!= null`: the starter row has a pre-filled field but empty value,
  // which would otherwise compile to `tier = ''` and gate the step as "valid".
  const audienceGroup = { combinator: audCombinator, rows: audRows, groups: audGroups };
  const audienceAst = groupHasCriteria(audienceGroup) ? buildAstFromGroup(audienceGroup) : null;
  const audienceSummary =
    audienceAst === null ? '—' : audCount !== null ? `${audCount.toLocaleString()} recipient${audCount === 1 ? '' : 's'}` : 'Custom audience rule';
  const tplName =
    tplId === attachedCopy?.id && attachedCopy
      ? `${attachedCopy.name} (this broadcast's copy)`
      : (templates.find((t) => t.id === tplId)?.name ?? '—');

  // Per-step validity → which steps the breadcrumbs can jump to (you can always
  // go back; you can jump forward only as far as the entered data is valid). The
  // audience must have at least one condition (never blast-all by accident).
  const step0Valid = name.trim().length > 0 && audienceAst !== null;
  // To leave Content, the attached email must have ALL of From (a real named
  // sender — no no-reply fallback), To, and Subject filled. The list of what's
  // still missing drives the inline hint.
  const missingEnvelope: string[] = !attachedCopy
    ? ['an email']
    : [
        envelope?.sender_id ? null : 'From',
        envelope && envelope.to_address.trim() !== '' ? null : 'To',
        envelope && envelope.subject.trim() !== '' ? null : 'Subject',
      ].filter((x): x is string => x !== null);
  // EMAIL needs a complete email instance; the TEXT channels need a non-blank body.
  const step1Valid =
    medium === 'email' ? tplId !== '' && missingEnvelope.length === 0 : textBody.trim() !== '';
  const canReach = (target: number): boolean =>
    target === 0 ? true : target === 1 ? step0Valid : step0Valid && step1Valid;

  const canNext = step === 0 ? step0Valid : step === 1 ? step1Valid : true;
  // A scheduled send must be ≥ 5 minutes from now (`nowMs` re-renders each minute,
  // and the server re-checks on save). The picker's `min` is now+5min in the zone.
  const scheduledMs =
    scheduleMode === 'later' && scheduledAt ? new Date(zonedInputToUtcIso(scheduledAt, timeZone)).getTime() : NaN;
  const scheduleTooEarly =
    scheduleMode === 'later' &&
    scheduledAt !== '' &&
    !Number.isNaN(scheduledMs) &&
    scheduledMs < nowMs + MIN_SCHEDULE_LEAD_MS;
  const minScheduledInput = utcIsoToZonedInput(new Date(nowMs + MIN_SCHEDULE_LEAD_MS).toISOString(), timeZone);
  const canSave =
    step0Valid && step1Valid && (scheduleMode === 'now' || (scheduledAt !== '' && !scheduleTooEarly));

  // Finish the wizard one of three ways:
  //  - 'now'      → persist + send immediately (status flips to sending/sent),
  //  - 'schedule' → persist with a send time (status 'scheduled'),
  //  - 'draft'    → persist with NO send time and don't send (status 'draft' —
  //                 a broadcast created but not sent or scheduled).
  // A send failure (no verified domain, missing subject) is surfaced and the
  // broadcast remains saved (as a draft) so the user can fix it.
  const finish = async (action: 'now' | 'schedule' | 'draft') => {
    setSaving(true);
    setError('');
    try {
      const scheduledIso = action === 'schedule' && scheduledAt ? zonedInputToUtcIso(scheduledAt, timeZone) : null;
      const body = {
        name: name || 'Untitled broadcast',
        medium,
        text_body: medium === 'email' ? null : textBody,
        audience: audienceAst,
        template_id: medium === 'email' ? tplId : null,
        topic_id: topicId || null,
        scheduled_at: scheduledIso,
        scheduled_tz: scheduledIso ? timeZone : null,
      };
      let bid = effectiveId;
      if (effectiveId) {
        await api.put(`/broadcasts/${effectiveId}`, { body });
      } else {
        const r = await api.post<{ broadcast: { id: string } }>('/broadcasts', { body });
        bid = r.broadcast.id;
      }
      if (action === 'now' && bid) {
        const res = await api.post<{ result: { result?: string } }>(`/broadcasts/${bid}/send`, {});
        showToast(`Broadcast ${res.result?.result ?? 'sent'}.`, { tone: 'success' });
      }
      navigate('/broadcasts');
    } catch (e) {
      setError((e as { error?: string })?.error ?? (e instanceof Error ? e.message : 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  // Sent/sending/cancelled broadcasts aren't editable — show the email preview.
  if (viewOnly && id) return <BroadcastPreview id={id} />;

  return (
    <section data-testid="broadcast-wizard">
      <PageHeader
        title={editing ? 'Edit broadcast' : 'New broadcast'}
        subtitle="Pick an audience and content, then send now or schedule."
        back={
          <button data-testid="broadcasts-back" class="btn-ghost btn-sm whitespace-nowrap" onClick={() => navigate('/broadcasts')}>
            ← Back to broadcasts
          </button>
        }
      />

      {/* Step indicator — click any reachable step to jump straight to it. */}
      <ol class="mb-5 flex items-center gap-2 text-sm">
        {STEPS.map((label, i) => {
          const reachable = canReach(i);
          return (
            <li key={label} class="flex items-center gap-2">
              <button
                type="button"
                data-testid={`wizard-step-${i}`}
                disabled={!reachable}
                onClick={() => reachable && setStep(i)}
                class={`flex items-center gap-2 rounded-lg ${reachable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                title={reachable ? `Go to ${label}` : `Complete earlier steps first`}
              >
                <span
                  class={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                    i === step
                      ? 'bg-brand-600 text-white'
                      : i < step
                        ? 'bg-brand-100 text-brand-700'
                        : 'bg-stone-100 text-stone-400'
                  }`}
                >
                  {i + 1}
                </span>
                <span
                  class={
                    i === step
                      ? 'font-semibold text-ink-900'
                      : reachable
                        ? 'text-stone-600 hover:text-ink-900'
                        : 'text-stone-400'
                  }
                >
                  {label}
                </span>
              </button>
              {i < STEPS.length - 1 ? <span class="text-stone-300">›</span> : null}
            </li>
          );
        })}
      </ol>

      <Card class="max-w-2xl p-5">
        {step === 0 ? (
          <div class="space-y-4">
            <Field label="Broadcast name">
              <Input
                data-testid="broadcast-name"
                placeholder="Spring announcement"
                value={name}
                onInput={(e: Event) => setName((e.target as HTMLInputElement).value)}
              />
            </Field>
            <Field label="Channel">
              <Select
                data-testid="broadcast-medium"
                value={medium}
                onChange={(e: Event) => setMedium((e.target as HTMLSelectElement).value as Medium)}
              >
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
              </Select>
              {medium !== 'email' ? (
                <p class="mt-1 text-xs text-stone-500">
                  {MEDIUM_LABEL[medium]} messages send to each recipient's phone ({'{{customer.phone}}'}). Recipients
                  without a phone are skipped.
                </p>
              ) : null}
            </Field>
            <Field label="Audience">
              <p class="mb-2 text-xs text-stone-500">
                Build the audience like a segment — combine profile attributes, events, and
                segment membership (include with &ldquo;is a member of&rdquo;, exclude with
                &ldquo;is NOT a member of&rdquo;) under AND/OR groups.
              </p>
              <div data-testid="broadcast-audience">
                <RuleBuilder
                  context="audience"
                  segments={segments}
                  group={{ combinator: audCombinator, rows: audRows, groups: audGroups }}
                  onChange={(g) => {
                    setAudCombinator(g.combinator);
                    setAudRows(g.rows);
                    setAudGroups(g.groups);
                  }}
                />
              </div>
              <p class="mt-2 text-sm" data-testid="broadcast-audience-count">
                {audienceAst === null ? (
                  <span class="text-stone-500">Add at least one condition to define the audience.</span>
                ) : audCountErr ? (
                  <span class="text-rose-600">{audCountErr}</span>
                ) : audCount === null ? (
                  <span class="text-stone-400">Estimating recipients…</span>
                ) : (
                  <span class="text-ink-900">
                    ≈ <strong>{audCount.toLocaleString()}</strong> recipient{audCount === 1 ? '' : 's'}
                  </span>
                )}
              </p>
            </Field>
            <Field label="Topic (optional)">
              <Select
                data-testid="broadcast-topic"
                value={topicId}
                onChange={(e: Event) => setTopicId((e.target as HTMLSelectElement).value)}
              >
                <option value="">No topic</option>
                {topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <p class="mt-1 text-xs text-stone-500">
                Recipients who unsubscribed from this topic are skipped automatically.
              </p>
            </Field>
          </div>
        ) : step === 1 && medium !== 'email' ? (
          <div class="space-y-3">
            <p class="text-sm text-stone-600">
              Write the {MEDIUM_LABEL[medium]} message. It's sent as plain text to each recipient's phone. Use merge
              tags like <code class="rounded bg-stone-100 px-1">{'{{customer.first_name}}'}</code> to personalize.
            </p>
            {textTemplates.length ? (
              <Field label="Use a text template (optional)">
                <Select
                  data-testid="text-template-pick"
                  value=""
                  onChange={(e: Event) => {
                    const tid = (e.target as HTMLSelectElement).value;
                    const tpl = textTemplates.find((t) => t.id === tid);
                    if (tpl) setTextBody(tpl.body);
                    (e.target as HTMLSelectElement).value = '';
                  }}
                >
                  <option value="">— none —</option>
                  {textTemplates.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
                <p class="mt-1 text-xs text-stone-500">
                  Fills the message below with the template's body. You can still edit it.
                </p>
              </Field>
            ) : null}
            <Field label={`${MEDIUM_LABEL[medium]} message`}>
              <DirectionalTextarea
                data-testid="broadcast-text-body"
                testIdPrefix="broadcast-text-dir"
                storageKey="broadcast-text-body"
                rows={6}
                placeholder={'Hi {{customer.first_name}}, your order has shipped!'}
                value={textBody}
                onInput={(e: Event) => setTextBody((e.target as HTMLTextAreaElement).value)}
              />
            </Field>
            {textBody.trim() === '' ? (
              <p data-testid="text-body-incomplete" class="text-xs font-medium text-amber-700">
                Add a message body before continuing.
              </p>
            ) : (
              <p data-testid="text-body-complete" class="text-xs text-emerald-700">
                Message ready.
              </p>
            )}
          </div>
        ) : step === 1 ? (
          <div class="space-y-3">
            {attachedCopy ? (
              <>
                {/* An email instance exists. The template was only a starting point;
                    this copy is independent — you edit it or start over, you don't
                    swap the underlying template. */}
                <div
                  data-testid="email-instance"
                  class="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50/60 p-4"
                >
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-medium text-ink-900">{attachedCopy.name}</span>
                    <span class="text-xs text-stone-500">This broadcast's own email</span>
                  </span>
                  <span class="flex shrink-0 items-center gap-2">
                    <Button data-testid="design-email" variant="secondary" onClick={designEmail}>
                      Edit email
                    </Button>
                    <Button data-testid="email-replace" variant="ghost" onClick={resetEmail}>
                      Start over
                    </Button>
                  </span>
                </div>
                {missingEnvelope.length > 0 ? (
                  <p data-testid="email-incomplete" class="text-xs font-medium text-amber-700">
                    Before continuing, set {missingEnvelope.join(', ')} in the email — open “Edit email”. The From must
                    be a real sender (add one under Sending domains); there is no no-reply fallback.
                  </p>
                ) : (
                  <p data-testid="email-complete" class="text-xs text-emerald-700">
                    From, To and Subject are all set — ready to continue.
                  </p>
                )}
                <p class="text-xs text-stone-500">
                  This is the broadcast's own copy — the template was only a starting point, so edits here
                  don't change the library.
                </p>
              </>
            ) : (
              <>
                {/* No email yet — start from a template or from a blank design. Once
                    chosen it becomes this broadcast's own copy (no re-picking). */}
                <p class="text-sm text-stone-600">
                  Create the email for this broadcast — start from a template, or from a blank design.
                </p>
                <Field label="Start from a template">
                  <Select
                    data-testid="broadcast-template"
                    value=""
                    onChange={(e: Event) => void pickTemplate((e.target as HTMLSelectElement).value)}
                  >
                    <option value="">Choose a template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div class="flex items-center gap-3 text-xs uppercase tracking-wide text-stone-400">
                  <span class="h-px flex-1 bg-stone-200" />
                  or
                  <span class="h-px flex-1 bg-stone-200" />
                </div>
                <Button data-testid="design-email" variant="secondary" onClick={designEmail}>
                  Start from a blank design
                </Button>
              </>
            )}
          </div>
        ) : (
          <div class="space-y-4">
            <Field label="When to send">
              <Select
                data-testid="schedule-mode"
                value={scheduleMode}
                onChange={(e: Event) => {
                  const mode = (e.target as HTMLSelectElement).value as 'now' | 'later';
                  setScheduleMode(mode);
                  // Default the picker to TODAY (now + 1h, a valid ≥5-min lead) when
                  // switching to scheduling and nothing is set yet.
                  if (mode === 'later' && !scheduledAt) {
                    setScheduledAt(utcIsoToZonedInput(new Date(Date.now() + 60 * 60 * 1000).toISOString(), timeZone));
                  }
                }}
              >
                <option value="now">Send now</option>
                <option value="later">Schedule for a date &amp; time</option>
              </Select>
            </Field>
            {scheduleMode === 'later' ? (
              <div class="grid gap-4 sm:grid-cols-2">
                <Field label="Scheduled time">
                  <Input
                    data-testid="broadcast-scheduled-at"
                    type="datetime-local"
                    min={minScheduledInput}
                    value={scheduledAt}
                    onInput={(e: Event) => setScheduledAt((e.target as HTMLInputElement).value)}
                  />
                  {scheduleTooEarly ? (
                    <p data-testid="schedule-too-early" class="mt-1 text-xs font-medium text-amber-700">
                      Pick a time at least 5 minutes from now.
                    </p>
                  ) : null}
                </Field>
                <Field label="Timezone">
                  <Select
                    data-testid="schedule-tz"
                    value={timeZone}
                    onChange={(e: Event) => setTimeZone((e.target as HTMLSelectElement).value)}
                  >
                    {timeZoneList().map((z) => (
                      <option key={z} value={z}>
                        {z.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}

            {/* Review */}
            <dl
              data-testid="wizard-review"
              class="mt-2 grid grid-cols-[8rem_1fr] gap-y-1.5 rounded-lg border border-stone-200 bg-stone-50/60 p-3 text-sm"
            >
              <dt class="text-stone-500">Name</dt>
              <dd class="text-ink-900">{name || '—'}</dd>
              <dt class="text-stone-500">Channel</dt>
              <dd class="text-ink-900" data-testid="review-medium">{MEDIUM_LABEL[medium]}</dd>
              <dt class="text-stone-500">Audience</dt>
              <dd class="text-ink-900">{audienceSummary}</dd>
              {medium === 'email' ? (
                <>
                  <dt class="text-stone-500">Email</dt>
                  <dd class="text-ink-900">{tplName}</dd>
                </>
              ) : (
                <>
                  <dt class="text-stone-500">Message</dt>
                  <dd class="text-ink-900 whitespace-pre-wrap" data-testid="review-text-body">{textBody || '—'}</dd>
                </>
              )}
              <dt class="text-stone-500">When</dt>
              <dd class="text-ink-900">
                {scheduleMode === 'later' && scheduledAt
                  ? `${whenLabel(zonedInputToUtcIso(scheduledAt, timeZone), timeZone)} · ${timeZone.replace(/_/g, ' ')}`
                  : 'Immediately'}
              </dd>
            </dl>
          </div>
        )}

        {error ? <p data-testid="wizard-error" class="mt-3 text-sm text-rose-600">{error}</p> : null}

        <div class="mt-5 flex items-center gap-3 border-t border-stone-100 pt-4">
          {step > 0 ? (
            <Button data-testid="wizard-back" variant="ghost" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <Button data-testid="wizard-next" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
              Next
            </Button>
          ) : (
            <div class="ml-auto flex items-center gap-3">
              {/* Save without sending OR scheduling → a plain draft. */}
              <Button
                data-testid="wizard-save-draft"
                variant="ghost"
                disabled={saving || !(step0Valid && step1Valid)}
                onClick={() => finish('draft')}
              >
                Save as draft
              </Button>
              <Button
                data-testid="wizard-save"
                loading={saving}
                disabled={!canSave || saving}
                onClick={() => finish(scheduleMode === 'now' ? 'now' : 'schedule')}
              >
                {saving
                  ? scheduleMode === 'now'
                    ? 'Sending…'
                    : 'Saving…'
                  : scheduleMode === 'now'
                    ? 'Send now'
                    : editing
                      ? 'Save schedule'
                      : 'Schedule send'}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

// --- Read-only preview of a sent (non-editable) broadcast -------------------

interface PreviewData {
  name: string;
  status: string;
  sent_at: string | null;
  medium?: Medium;
  text_body?: string;
  subject: string;
  from: string;
  to_address: string;
  audience: string;
  html: string;
}

/** A read-only view of a sent/scheduled broadcast — opened by clicking it in the
 *  list. For EMAIL it shows the resolved envelope + the compiled HTML body in a
 *  sandboxed iframe; for SMS/WhatsApp it shows the channel, the recipient phone
 *  token, and the plain text message that was sent. */
function BroadcastPreview({ id }: { id: string }) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .get<PreviewData>(`/broadcasts/${id}/preview`)
      .then(setData)
      .catch(() => setError('Could not load this broadcast.'));
  }, [id]);

  const medium = (data?.medium ?? 'email') as Medium;
  const isText = medium !== 'email';

  return (
    <section data-testid="broadcast-preview">
      <PageHeader
        title={data?.name ?? 'Broadcast'}
        subtitle={`A read-only preview of the ${isText ? `${MEDIUM_LABEL[medium]} message` : 'email'} for this broadcast.`}
        back={
          <button data-testid="broadcasts-back" class="btn-ghost btn-sm whitespace-nowrap" onClick={() => navigate('/broadcasts')}>
            ← Back to broadcasts
          </button>
        }
        actions={
          data ? (
            <div class="flex items-center gap-2">
              <Badge data-testid="preview-medium" tone="neutral">{MEDIUM_LABEL[medium]}</Badge>
              <Badge tone={toneFor(data.status)}>{data.status}</Badge>
            </div>
          ) : undefined
        }
      />
      {error ? (
        <p class="text-sm text-rose-600">{error}</p>
      ) : !data ? (
        <p class="text-sm text-stone-500">Loading…</p>
      ) : isText ? (
        <Card class="max-w-3xl overflow-hidden p-0">
          <dl class="grid grid-cols-[5rem_1fr] gap-y-1.5 border-b border-stone-200 p-4 text-sm">
            <dt class="text-stone-500">Channel</dt>
            <dd class="text-ink-900">{MEDIUM_LABEL[medium]}</dd>
            <dt class="text-stone-500">To</dt>
            <dd class="font-mono text-ink-900">{data.to_address || '—'}</dd>
            <dt class="text-stone-500">Audience</dt>
            <dd class="text-ink-900">{data.audience}</dd>
          </dl>
          <div class="p-4">
            <p class="mb-1.5 text-xs font-medium uppercase tracking-wide text-stone-400">Message</p>
            <pre
              data-testid="preview-text-body"
              class="whitespace-pre-wrap break-words rounded-lg bg-stone-50 p-3 text-sm text-ink-900 ring-1 ring-inset ring-stone-100"
            >
              {data.text_body || '—'}
            </pre>
          </div>
        </Card>
      ) : (
        <Card class="max-w-3xl overflow-hidden p-0">
          <dl class="grid grid-cols-[5rem_1fr] gap-y-1.5 border-b border-stone-200 p-4 text-sm">
            <dt class="text-stone-500">From</dt>
            <dd data-testid="preview-from" class="text-ink-900">{data.from}</dd>
            <dt class="text-stone-500">To</dt>
            <dd class="text-ink-900">{data.to_address || '—'}</dd>
            <dt class="text-stone-500">Subject</dt>
            <dd data-testid="preview-subject" class="font-medium text-ink-900">{data.subject || '—'}</dd>
            <dt class="text-stone-500">Audience</dt>
            <dd class="text-ink-900">{data.audience}</dd>
          </dl>
          <iframe
            data-testid="preview-body"
            title="Email preview"
            sandbox=""
            srcdoc={data.html}
            class="h-[600px] w-full bg-white"
          />
        </Card>
      )}
    </section>
  );
}
