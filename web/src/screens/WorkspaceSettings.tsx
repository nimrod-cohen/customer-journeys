// WorkspaceSettings (§12, owner): TABS for the ACTIVE workspace — "Workspace"
// (members + roles + lowercase-emails policy) and "Sending domains" (per-workspace
// domains, §10). Company-level workspace management lives on the Company settings
// page. Scoped to the token.
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store/store.js';
import { api, sessionStore } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, Card, Field, Input, PageHeader, Select } from '../ui/kit.js';
import { showToast } from '../ui/toast.tsx';
import { timeZoneList } from '@cdp/shared';
import { saveWorkspaceTimezone, saveWorkspaceLanguage, type FrontFacingLanguage } from './workspaceSettingsLogic.js';
import { SendingDomainsPanel } from './SendingDomainsList.tsx';
import { TopicsPanel } from './Topics.tsx';
import { IngestKeys } from './IngestKeys.tsx';

type SettingsTab = 'workspace' | 'domains' | 'topics' | 'api-keys';

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
  // Sending guardrails (CLAUDE.md inv.7): frequency cap + quiet-hours window (UTC).
  const [freqCap, setFreqCap] = useState(0);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState(22);
  const [quietEnd, setQuietEnd] = useState(8);

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
          frequency_cap_per_days?: number;
          quiet_hours?: { startHour?: number; endHour?: number } | null;
        };
      }>('/workspace/settings')
      .then((r) => {
        setLowercaseEmails(r.settings.lowercase_emails !== false);
        setLinkTracking(r.settings.link_tracking === true);
        setTimezone(r.settings.timezone || 'UTC');
        setLanguage(r.settings.front_facing_language ?? 'auto');
        setFreqCap(typeof r.settings.frequency_cap_per_days === 'number' ? r.settings.frequency_cap_per_days : 0);
        const qh = r.settings.quiet_hours;
        if (qh && typeof qh === 'object') {
          setQuietEnabled(true);
          if (typeof qh.startHour === 'number') setQuietStart(qh.startHour);
          if (typeof qh.endHour === 'number') setQuietEnd(qh.endHour);
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
    const quiet_hours = quietEnabled ? { startHour: quietStart, endHour: quietEnd } : null;
    return api
      .put('/workspace/settings', { body: { frequency_cap_per_days: freqCap, quiet_hours } })
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
        <div class="mb-3">
          <h2 class="text-base font-bold text-ink-900">Sending guardrails</h2>
          <p class="mt-1 text-sm text-stone-500">
            Optional safety limits applied to every send (broadcasts and campaigns). A frequency cap holds a recipient
            who has already received too many messages recently; a quiet-hours window (UTC) holds sends until the window
            closes.
          </p>
        </div>
        <div class="flex flex-wrap items-end gap-4">
          <Field label="Frequency cap (max sends / recipient)">
            <Input
              data-testid="settings-frequency-cap"
              type="number"
              min={0}
              class="w-40"
              value={String(freqCap)}
              onInput={(e: Event) => setFreqCap(Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0)))}
            />
          </Field>
          <label class="flex items-center gap-2 pb-2 text-sm text-ink-800">
            <input
              data-testid="settings-quiet-enabled"
              type="checkbox"
              checked={quietEnabled}
              onChange={(e: Event) => setQuietEnabled((e.target as HTMLInputElement).checked)}
            />
            Quiet hours
          </label>
          <Field label="From (UTC)">
            <Select
              data-testid="settings-quiet-start"
              class="w-24"
              value={String(quietStart)}
              disabled={!quietEnabled}
              onChange={(e: Event) => setQuietStart(Number((e.target as HTMLSelectElement).value))}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </Select>
          </Field>
          <Field label="Until (UTC)">
            <Select
              data-testid="settings-quiet-end"
              class="w-24"
              value={String(quietEnd)}
              disabled={!quietEnabled}
              onChange={(e: Event) => setQuietEnd(Number((e.target as HTMLSelectElement).value))}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>
              ))}
            </Select>
          </Field>
          <Button data-testid="settings-guardrails-save" onClick={saveGuardrails}>
            Save
          </Button>
        </div>
        <p class="mt-2 text-xs text-stone-400">
          Cap of <span class="font-mono">N</span> means at most <span class="font-mono">N</span> sends to a recipient in
          the last <span class="font-mono">N</span> days; <span class="font-mono">0</span> disables it.
        </p>
      </Card>

      </>
      )}
    </section>
  );
}
