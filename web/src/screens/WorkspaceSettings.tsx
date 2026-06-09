// WorkspaceSettings (§12, owner): members + roles management. Lists the active
// workspace's members and lets an owner add/change roles. The sending-domain
// status links to the OnboardingWizard. All scoped server-side to the token.
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useStore } from '../store/store.js';
import { api, sessionStore, refreshMe, switchWorkspace } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, Card, Field, Input, PageHeader, Select } from '../ui/kit.js';

interface Member {
  user_id: string;
  role: string;
  email: string;
}

const ROLES = ['owner', 'marketer', 'accounting'];

export function WorkspaceSettings() {
  const session = useStore(sessionStore);
  const [members, setMembers] = useState<Member[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('marketer');
  const [addError, setAddError] = useState('');
  const [lowercaseEmails, setLowercaseEmails] = useState(true);
  const [newWsName, setNewWsName] = useState('');
  const [wsError, setWsError] = useState('');
  // Type-the-name confirmation for the destructive workspace delete.
  const [delTarget, setDelTarget] = useState<{ id: string; name: string } | null>(null);
  const [delConfirm, setDelConfirm] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');

  const deleteWorkspace = async () => {
    if (!delTarget) return;
    setDelBusy(true);
    setDelErr('');
    try {
      await api.del(`/workspaces/${delTarget.id}`, { body: { confirm_name: delConfirm.trim() } });
      setDelTarget(null);
      setDelConfirm('');
      await refreshMe();
    } catch (e) {
      setDelErr((e as { error?: string })?.error ?? 'could not delete workspace');
    } finally {
      setDelBusy(false);
    }
  };

  // Create a new workspace IN THIS COMPANY (owner only). The server scopes it to
  // the active workspace's company and makes the creator an owner; refreshMe then
  // pulls the new membership so the switcher and list update.
  const createWorkspace = async () => {
    const name = newWsName.trim();
    if (!name) return;
    setWsError('');
    try {
      await api.post('/workspaces', { body: { name } });
      setNewWsName('');
      await refreshMe();
    } catch (e) {
      setWsError((e as { error?: string })?.error ?? 'could not create workspace');
    }
  };

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
      <PageHeader title="Workspace settings" subtitle="Members, roles, and sending domain." />

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
                <td class="px-5 py-2.5 text-sm text-ink-900">{m.email}</td>
                <td class="px-5 py-2.5">
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

      <Card data-testid="company-workspaces" class="mt-6 p-5">
        <h2 class="text-base font-bold text-ink-900">
          Workspaces{session.companyName ? ` in ${session.companyName}` : ''}
        </h2>
        <p class="mt-1 text-sm text-stone-500">
          A company can own several workspaces. As an owner you can add another one here.
        </p>
        <ul class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
          {session.memberships.map((m) => (
            <li
              data-testid="ws-row"
              key={m.workspaceId}
              class="flex items-center justify-between px-3 py-2 text-sm"
            >
              <span class="text-ink-900">
                {m.name ?? m.workspaceId}
                {m.workspaceId === session.workspaceId ? (
                  <span class="ml-2 text-[11px] uppercase tracking-wide text-brand-600">active</span>
                ) : null}
              </span>
              {m.workspaceId !== session.workspaceId ? (
                <span class="flex items-center gap-1">
                  <Button
                    data-testid="ws-open"
                    variant="ghost"
                    size="sm"
                    onClick={() => void switchWorkspace(m.workspaceId)}
                  >
                    Open
                  </Button>
                  <Button
                    data-testid="delete-workspace"
                    data-ws={m.workspaceId}
                    variant="ghost"
                    size="sm"
                    class="text-rose-600 hover:bg-rose-50"
                    onClick={() => {
                      setDelTarget({ id: m.workspaceId, name: m.name ?? m.workspaceId });
                      setDelConfirm('');
                      setDelErr('');
                    }}
                  >
                    Delete
                  </Button>
                </span>
              ) : (
                <span class="text-[11px] text-stone-400">switch away to delete</span>
              )}
            </li>
          ))}
        </ul>
        <div class="mt-3 flex flex-wrap items-end gap-3">
          <Field label="New workspace" class="min-w-[16rem] flex-1">
            <Input
              data-testid="new-workspace-name"
              placeholder="e.g. Acme – West"
              value={newWsName}
              onInput={(e: Event) => setNewWsName((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Button data-testid="create-workspace" onClick={createWorkspace} disabled={!newWsName.trim()}>
            Add workspace
          </Button>
        </div>
        {wsError ? <p data-testid="workspace-error" class="mt-2 text-sm text-rose-600">{wsError}</p> : null}
      </Card>

      <Card class="mt-6 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="text-base font-bold text-ink-900">Sending domain</h2>
          <p class="mt-1 text-sm text-stone-500">
            Verify a domain (DKIM/SPF/DMARC) before this workspace can send.
          </p>
        </div>
        <Button data-testid="goto-onboarding" variant="secondary" onClick={() => navigate('/onboarding')}>
          Configure sending domain
        </Button>
      </Card>

      {delTarget
        ? createPortal(
            <div
              data-testid="delete-workspace-modal"
              class="fixed inset-0 z-50 grid place-items-center bg-ink-950/50 p-4"
              onClick={() => setDelTarget(null)}
            >
              <div
                class="w-full max-w-md rounded-xl bg-white p-5 shadow-soft"
                onClick={(e: Event) => e.stopPropagation()}
              >
                <h3 class="text-lg font-bold text-ink-950">Delete workspace</h3>
                <p class="mt-2 text-sm text-stone-600">
                  This permanently deletes <b>{delTarget.name}</b> and <b>all of its data</b> —
                  profiles, events, segments, campaigns, broadcasts, suppressions and members. This
                  cannot be undone.
                </p>
                <p class="mt-3 text-sm text-stone-600">
                  Type <span class="font-mono font-semibold text-ink-900">{delTarget.name}</span> to
                  confirm:
                </p>
                <Input
                  data-testid="delete-confirm-input"
                  class="mt-1"
                  value={delConfirm}
                  onInput={(e: Event) => setDelConfirm((e.target as HTMLInputElement).value)}
                />
                {delErr ? (
                  <p data-testid="delete-workspace-error" class="mt-2 text-sm text-rose-600">
                    {delErr}
                  </p>
                ) : null}
                <div class="mt-4 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setDelTarget(null)}>
                    Cancel
                  </Button>
                  <Button
                    data-testid="confirm-delete-workspace"
                    variant="danger"
                    disabled={delConfirm.trim() !== delTarget.name || delBusy}
                    onClick={deleteWorkspace}
                  >
                    {delBusy ? 'Deleting…' : 'Delete workspace'}
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
