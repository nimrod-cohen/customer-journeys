// WorkspaceSettings (§12, owner): TABS for the ACTIVE workspace — "Workspace"
// (members + roles + lowercase-emails policy) and "Sending domains" (per-workspace
// domains, §10). Company-level workspace management lives on the Company settings
// page. Scoped to the token.
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store/store.js';
import { api, sessionStore } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, Card, Field, Input, PageHeader, Select } from '../ui/kit.js';
import { SendingDomainsPanel } from './SendingDomainsList.tsx';

type SettingsTab = 'workspace' | 'domains';

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

  const reload = async () => {
    const r = await api.get<{ members: Member[] }>('/workspace/members');
    setMembers(r.members);
  };
  useEffect(() => {
    void reload();
    void api
      .get<{ settings: { lowercase_emails?: boolean } }>('/workspace/settings')
      .then((r) => setLowercaseEmails(r.settings.lowercase_emails !== false));
  }, []);

  const toggleLowercase = async () => {
    const next = !lowercaseEmails;
    setLowercaseEmails(next); // optimistic
    try {
      await api.put('/workspace/settings', { body: { lowercase_emails: next } });
    } catch {
      setLowercaseEmails(!next); // revert on failure
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
      <PageHeader title="Workspace settings" subtitle="Members, roles, and sending domains for this workspace." />

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
      </div>

      {tab === 'domains' ? (
        <SendingDomainsPanel />
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
          onClick={toggleLowercase}
          class={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
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

      </>
      )}
    </section>
  );
}
