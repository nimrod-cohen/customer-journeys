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

type SettingsTab = 'workspace' | 'domains' | 'topics';

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
        };
      }>('/workspace/settings')
      .then((r) => {
        setLowercaseEmails(r.settings.lowercase_emails !== false);
        setLinkTracking(r.settings.link_tracking === true);
        setTimezone(r.settings.timezone || 'UTC');
        setLanguage(r.settings.front_facing_language ?? 'auto');
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
      </div>

      {tab === 'domains' ? (
        <SendingDomainsPanel />
      ) : tab === 'topics' ? (
        <TopicsPanel />
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

      </>
      )}
    </section>
  );
}
