// WorkspaceSettings (§12, owner): TABS for the ACTIVE workspace — "Workspace"
// (members + roles + lowercase-emails policy) and "Sending domains" (per-workspace
// domains, §10). Company-level workspace management lives on the Company settings
// page. Scoped to the token.
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store/store.js';
import { api, sessionStore } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, Card, Field, Input, PageHeader, Select, Switch } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { timeZoneList } from '@cdp/shared';
import { saveWorkspaceTimezone, saveWorkspaceLanguage, type FrontFacingLanguage } from './workspaceSettingsLogic.js';
import { SendingDomainsPanel } from './SendingDomainsList.tsx';
import { TopicsPanel } from './Topics.tsx';
import { IngestKeys } from './IngestKeys.tsx';

type SettingsTab = 'workspace' | 'domains' | 'topics' | 'api-keys';

/** A quiet-hours window (UI shape): from (startDay, startMin) to (endDay, endMin). */
type QuietWin = { startDay: number; startMin: number; endDay: number; endMin: number };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => i * 30); // 0, 30, … 1410 minutes
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

interface Member {
  user_id: string;
  role: string;
  email: string;
}

const ROLES = ['owner', 'marketer', 'accounting'];

export function WorkspaceSettings({ tab = 'workspace' }: { tab?: SettingsTab }) {
  const session = useStore(sessionStore);
  const [members, setMembers] = useState<Member[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('marketer');
  const [addError, setAddError] = useState('');
  const [lowercaseEmails, setLowercaseEmails] = useState(true);
  const [linkTracking, setLinkTracking] = useState(false);
  const [timezone, setTimezone] = useState('UTC');
  const [language, setLanguage] = useState<FrontFacingLanguage>('auto');
  // Lock the toggles while a settings PUT is in flight (no racing re-toggles).
  const [savingSettings, setSavingSettings] = useState(false);
  // Sending guardrails (CLAUDE.md inv.7). Frequency cap: at most `freqMax` messages
  // per `freqDays` days (a switch). Quiet hours: a per-weekday schedule (each day
  // on/off + start/end), evaluated in the workspace timezone (a switch).
  const [freqEnabled, setFreqEnabled] = useState(false);
  const [freqMax, setFreqMax] = useState(3);
  const [freqDays, setFreqDays] = useState(7);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietWindows, setQuietWindows] = useState<QuietWin[]>([]);

  const reload = async () => {
    const r = await api.get<{ members: Member[] }>('/workspace/members');
    setMembers(r.members);
  };
  useEffect(() => {
    void reload();
    void api
      .get<{
        settings: {
          lowercase_emails?: boolean;
          link_tracking?: boolean;
          timezone?: string;
          front_facing_language?: FrontFacingLanguage;
          frequency_cap?: { max?: number; days?: number } | null;
          quiet_hours?: Array<{ startDay?: number; startMinute?: number; endDay?: number; endMinute?: number }> | null;
        };
      }>('/workspace/settings')
      .then((r) => {
        setLowercaseEmails(r.settings.lowercase_emails !== false);
        setLinkTracking(r.settings.link_tracking === true);
        setTimezone(r.settings.timezone || 'UTC');
        setLanguage(r.settings.front_facing_language ?? 'auto');
        const fc = r.settings.frequency_cap;
        if (fc && typeof fc === 'object') {
          setFreqEnabled(true);
          if (typeof fc.max === 'number') setFreqMax(fc.max);
          if (typeof fc.days === 'number') setFreqDays(fc.days);
        }
        const qh = r.settings.quiet_hours;
        if (Array.isArray(qh) && qh.length) {
          setQuietEnabled(true);
          setQuietWindows(
            qh.map((w) => ({
              startDay: typeof w.startDay === 'number' ? w.startDay : 0,
              startMin: typeof w.startMinute === 'number' ? w.startMinute : 0,
              endDay: typeof w.endDay === 'number' ? w.endDay : 0,
              endMin: typeof w.endMinute === 'number' ? w.endMinute : 0,
            })),
          );
        }
      });
  }, []);

  // The workspace clock for all campaign time math (§9B). The kit Button below
  // auto-locks while this promise is in flight (we RETURN it). Optimistic + rollback.
  const saveTimezone = (next: string) => {
    const previous = timezone;
    setTimezone(next); // optimistic
    return saveWorkspaceTimezone(next, { previous, setTimezone, put: api.put, toast: showToast });
  };
  // The picker list always includes the currently-persisted value (some engines
  // omit a literal 'UTC' from supportedValuesOf — timeZoneList prepends it).
  const zones = (() => {
    const list = timeZoneList();
    return list.includes(timezone) ? list : [timezone, ...list];
  })();

  // The PUBLIC unsubscribe/preference-center page language. Optimistic + rollback;
  // RETURN the promise so the kit Button auto-locks (standing button rule).
  const saveLanguage = (next: FrontFacingLanguage) => {
    const previous = language;
    setLanguage(next); // optimistic
    return saveWorkspaceLanguage(next, { previous, setLanguage, put: api.put, toast: showToast });
  };

  const toggleLinkTracking = async () => {
    if (savingSettings) return;
    const next = !linkTracking;
    setLinkTracking(next); // optimistic
    setSavingSettings(true);
    try {
      await api.put('/workspace/settings', { body: { link_tracking: next } });
    } catch {
      setLinkTracking(!next);
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleLowercase = async () => {
    if (savingSettings) return;
    const next = !lowercaseEmails;
    setLowercaseEmails(next); // optimistic
    setSavingSettings(true);
    try {
      await api.put('/workspace/settings', { body: { lowercase_emails: next } });
    } catch {
      setLowercaseEmails(!next); // revert on failure
    } finally {
      setSavingSettings(false);
    }
  };

  // Sending guardrails: persist the cap + quiet-hours window together. RETURN the
  // promise so the kit Save button auto-locks (standing button rule).
  const saveGuardrails = () => {
    const frequency_cap = freqEnabled ? { max: freqMax, days: freqDays } : null;
    const quiet_hours =
      quietEnabled && quietWindows.length
        ? quietWindows.map((w) => ({
            startDay: w.startDay,
            startMinute: w.startMin,
            endDay: w.endDay,
            endMinute: w.endMin,
          }))
        : null;
    return api
      .put('/workspace/settings', { body: { frequency_cap, quiet_hours } })
      .then(() => showToast('Sending guardrails saved.', { tone: 'success' }))
      .catch((e) => showToast((e as { error?: string })?.error ?? 'Could not save guardrails.', { tone: 'error' }));
  };

  const add = async () => {
    setAddError('');
    try {
      await api.post('/workspace/members', { body: { email: newEmail.trim(), role: newRole } });
      setNewEmail('');
      await reload();
    } catch (e) {
      setAddError((e as { error?: string })?.error ?? 'could not add member');
    }
  };

  const changeRole = async (userId: string, role: string) => {
    await api.patch('/workspace/members', { body: { user_id: userId, role } });
    await reload();
  };

  return (
    <section data-testid="workspace-settings">
      <PageHeader title="Workspace settings" subtitle="Members, roles, sending domains, and subscription topics for this workspace." />

      {/* Tabs */}
      <div class="mb-5 flex gap-1 border-b border-stone-200">
        <button
          type="button"
          data-testid="settings-tab-workspace"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'workspace' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => navigate('/settings')}
        >
          Workspace
        </button>
        <button
          type="button"
          data-testid="settings-tab-domains"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'domains' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => navigate('/settings/domains')}
        >
          Sending domains
        </button>
        <button
          type="button"
          data-testid="settings-tab-topics"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'topics' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => navigate('/settings/topics')}
        >
          Topics
        </button>
        <button
          type="button"
          data-testid="settings-tab-api-keys"
          class={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${
            tab === 'api-keys' ? 'border-brand-500 text-ink-900' : 'border-transparent text-stone-500 hover:text-ink-800'
          }`}
          onClick={() => navigate('/settings/api-keys')}
        >
          API keys
        </button>
      </div>

      {tab === 'domains' ? (
        <SendingDomainsPanel />
      ) : tab === 'topics' ? (
        <TopicsPanel />
      ) : tab === 'api-keys' ? (
        <IngestKeys />
      ) : (
      <>
      <Card class="overflow-hidden">
        <div class="border-b border-stone-100 px-5 py-4">
          <h2 class="text-base font-bold text-ink-900">Members</h2>
        </div>
        <table class="w-full text-sm">
          <thead class="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-5 py-2.5 font-semibold">Member</th>
              <th class="px-5 py-2.5 font-semibold">Role</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100">
            {members.map((m) => (
              <tr data-testid="member-row" key={m.user_id} class="hover:bg-stone-50/70">
                <td class="px-5 py-2.5 text-sm text-ink-900">
                  {m.email}
                  {m.user_id === session.sub ? (
                    <span class="ml-2 text-[11px] uppercase tracking-wide text-stone-400">you</span>
                  ) : null}
                </td>
                <td class="px-5 py-2.5">
                  {m.user_id === session.sub ? (
                    // You can't change your OWN role — only another owner can.
                    <span data-testid="member-role-self" class="inline-block w-40 text-sm capitalize text-stone-500">
                      {m.role}
                    </span>
                  ) : (
                    <Select
                      data-testid="member-role"
                      class="w-40"
                      value={m.role}
                      onChange={(e: Event) => changeRole(m.user_id, (e.target as HTMLSelectElement).value)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="flex flex-wrap items-end gap-3 border-t border-stone-100 bg-stone-50/50 px-5 py-4">
          <Field label="Add member (email)" class="min-w-[16rem] flex-1">
            <Input
              data-testid="new-member-id"
              type="email"
              placeholder="person@company.com"
              value={newEmail}
              onInput={(e: Event) => setNewEmail((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Role">
            <Select
              data-testid="new-member-role"
              class="w-40"
              value={newRole}
              onChange={(e: Event) => setNewRole((e.target as HTMLSelectElement).value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Button data-testid="add-member" onClick={add}>
            Add member
          </Button>
        </div>
        {addError ? (
          <p class="border-t border-stone-100 bg-rose-50 px-5 py-2 text-sm text-rose-700">{addError}</p>
        ) : null}
      </Card>

      <Card class="mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="text-base font-bold text-ink-900">Lowercase emails</h2>
          <p class="mt-1 text-sm text-stone-500">
            Store every customer email in lowercase (applied on ingestion and manual edits).
          </p>
        </div>
        <button
          data-testid="toggle-lowercase-emails"
          type="button"
          role="switch"
          aria-checked={lowercaseEmails}
          disabled={savingSettings}
          onClick={toggleLowercase}
          class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${
            lowercaseEmails ? 'bg-brand-500' : 'bg-stone-300'
          }`}
        >
          <span
            class={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
              lowercaseEmails ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </Card>

      <Card class="mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="text-base font-bold text-ink-900">Link tracking</h2>
          <p class="mt-1 text-sm text-stone-500">
            Rewrite links in outgoing emails through <code class="font-mono">/t/…</code> on your app domain to count
            clicks (the Clicked metric on broadcasts). Off by default.
          </p>
        </div>
        <button
          data-testid="toggle-link-tracking"
          type="button"
          role="switch"
          aria-checked={linkTracking}
          disabled={savingSettings}
          onClick={toggleLinkTracking}
          class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${
            linkTracking ? 'bg-brand-500' : 'bg-stone-300'
          }`}
        >
          <span
            class={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
              linkTracking ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </Card>

      <Card class="mt-6 flex flex-wrap items-end justify-between gap-3 p-5">
        <div class="min-w-[16rem] flex-1">
          <h2 class="text-base font-bold text-ink-900">Timezone</h2>
          <p class="mt-1 text-sm text-stone-500">
            The clock for campaign waits, wait-until and hour-of-day windows. Sends are scheduled against this zone
            (DST-correct). Default UTC.
          </p>
        </div>
        <div class="flex items-end gap-2">
          <Field label="Workspace timezone">
            <Select
              data-testid="workspace-timezone-select"
              class="w-64"
              value={timezone}
              onChange={(e: Event) => {
                void saveTimezone((e.target as HTMLSelectElement).value);
              }}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Button data-testid="workspace-timezone-save" onClick={() => saveTimezone(timezone)}>
            Save
          </Button>
        </div>
      </Card>

      <Card class="mt-6 flex flex-wrap items-end justify-between gap-3 p-5">
        <div class="min-w-[16rem] flex-1">
          <h2 class="text-base font-bold text-ink-900">Front-facing language</h2>
          <p class="mt-1 text-sm text-stone-500">
            The language of the public unsubscribe and subscription-preference pages your recipients see. Choose the
            visitor&rsquo;s browser language, or force English or Hebrew (Hebrew renders right-to-left).
          </p>
        </div>
        <div class="flex items-end gap-2">
          <Field label="Page language">
            <Select
              data-testid="workspace-language-select"
              class="w-64"
              value={language}
              onChange={(e: Event) => {
                void saveLanguage((e.target as HTMLSelectElement).value as FrontFacingLanguage);
              }}
            >
              <option value="auto">Visitor&rsquo;s browser language (auto)</option>
              <option value="en">English</option>
              <option value="he">עברית (Hebrew)</option>
            </Select>
          </Field>
          <Button data-testid="workspace-language-save" onClick={() => saveLanguage(language)}>
            Save
          </Button>
        </div>
      </Card>

      <Card class="mt-6 p-5" data-testid="settings-guardrails">
        <div class="mb-4">
          <h2 class="text-base font-bold text-ink-900">Sending guardrails</h2>
          <p class="mt-1 text-sm text-stone-500">
            Optional safety limits on every send (broadcasts and campaigns). All hours are in your workspace timezone
            (<span class="font-mono">{timezone}</span>).
          </p>
        </div>

        {/* Frequency cap */}
        <div class="border-t border-stone-100 pt-4">
          <label class="flex items-center gap-3">
            <Switch data-testid="settings-frequency-enabled" checked={freqEnabled} onChange={setFreqEnabled} />
            <span class="text-sm font-semibold text-ink-900">Frequency cap</span>
          </label>
          {freqEnabled ? (
            <div class="mt-2 flex flex-wrap items-center gap-2 pl-14 text-sm text-stone-700">
              At most
              <Input
                data-testid="settings-frequency-max"
                type="number"
                min={1}
                class="w-20"
                value={String(freqMax)}
                onInput={(e: Event) => setFreqMax(Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1)))}
              />
              message(s) per
              <Input
                data-testid="settings-frequency-days"
                type="number"
                min={1}
                class="w-20"
                value={String(freqDays)}
                onInput={(e: Event) => setFreqDays(Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1)))}
              />
              day(s) per recipient.
            </div>
          ) : null}
        </div>

        {/* Quiet hours — a list of windows (start day/time → end day/time) */}
        <div class="mt-5 border-t border-stone-100 pt-4">
          <label class="flex flex-wrap items-center gap-3">
            <Switch data-testid="settings-quiet-enabled" checked={quietEnabled} onChange={setQuietEnabled} />
            <span class="text-sm font-semibold text-ink-900">Quiet hours</span>
            <span class="text-xs text-stone-400">held sends resume when the window closes</span>
          </label>
          {quietEnabled ? (
            <div class="mt-3 pl-14" data-testid="settings-quiet-windows">
              <div class="space-y-2">
                {quietWindows.map((w, i) => {
                  const patch = (p: Partial<QuietWin>) =>
                    setQuietWindows((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));
                  const num = (e: Event) => Number((e.target as HTMLSelectElement).value);
                  return (
                    <div key={i} class="flex flex-wrap items-center gap-2 text-sm" data-testid="quiet-window">
                      <Select class="w-32" data-testid="quiet-start-day" value={String(w.startDay)} onChange={(e: Event) => patch({ startDay: num(e) })}>
                        {DAY_NAMES.map((n, d) => (
                          <option key={d} value={d}>{n}</option>
                        ))}
                      </Select>
                      <Select class="w-24" data-testid="quiet-start-time" value={String(w.startMin)} onChange={(e: Event) => patch({ startMin: num(e) })}>
                        {HALF_HOURS.map((m) => (
                          <option key={m} value={m}>{hhmm(m)}</option>
                        ))}
                      </Select>
                      <span class="text-stone-400">→</span>
                      <Select class="w-32" data-testid="quiet-end-day" value={String(w.endDay)} onChange={(e: Event) => patch({ endDay: num(e) })}>
                        {DAY_NAMES.map((n, d) => (
                          <option key={d} value={d}>{n}</option>
                        ))}
                      </Select>
                      <Select class="w-24" data-testid="quiet-end-time" value={String(w.endMin)} onChange={(e: Event) => patch({ endMin: num(e) })}>
                        {HALF_HOURS.map((m) => (
                          <option key={m} value={m}>{hhmm(m)}</option>
                        ))}
                      </Select>
                      <button
                        type="button"
                        data-testid="quiet-window-remove"
                        title="Remove window"
                        class="ml-1 text-stone-400 hover:text-rose-600"
                        onClick={() => setQuietWindows((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                data-testid="quiet-add-window"
                class="mt-2 text-sm font-semibold text-brand-700 hover:underline"
                onClick={() => setQuietWindows((prev) => [...prev, { startDay: 0, startMin: 1320, endDay: 1, endMin: 360 }])}
              >
                + Add quiet hours window
              </button>
              <div
                class="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600 ring-1 ring-inset ring-stone-200"
                data-testid="quiet-summary"
              >
                {quietWindows.length ? (
                  <span>
                    No emails will send during ({timezone}):{' '}
                    {quietWindows.map((w, i) => (
                      <span key={i} class="font-medium text-ink-800">
                        {i > 0 ? '; ' : ''}
                        {DAY_ABBR[w.startDay]} {hhmm(w.startMin)} → {DAY_ABBR[w.endDay]} {hhmm(w.endMin)}
                      </span>
                    ))}
                    .
                  </span>
                ) : (
                  'No windows yet — add one, or messages can send at any time.'
                )}
              </div>
            </div>
          ) : null}
        </div>

        <div class="mt-5 border-t border-stone-100 pt-4">
          <Button data-testid="settings-guardrails-save" onClick={saveGuardrails}>
            Save guardrails
          </Button>
        </div>
      </Card>

      </>
      )}
    </section>
  );
}
