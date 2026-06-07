// WorkspaceSettings (§12, owner): members + roles management. Lists the active
// workspace's members and lets an owner add/change roles. The sending-domain
// status links to the OnboardingWizard. All scoped server-side to the token.
// (Visual redesign; all data-testid attributes preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';
import { Button, Card, Field, Input, PageHeader, Select } from '../ui/kit.js';

interface Member {
  user_id: string;
  role: string;
  email: string;
}

const ROLES = ['owner', 'marketer', 'accounting'];

export function WorkspaceSettings() {
  const [members, setMembers] = useState<Member[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('marketer');
  const [addError, setAddError] = useState('');

  const reload = async () => {
    const r = await api.get<{ members: Member[] }>('/workspace/members');
    setMembers(r.members);
  };
  useEffect(() => {
    void reload();
  }, []);

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
          <h2 class="text-base font-bold text-ink-900">Sending domain</h2>
          <p class="mt-1 text-sm text-stone-500">
            Verify a domain (DKIM/SPF/DMARC) before this workspace can send.
          </p>
        </div>
        <Button data-testid="goto-onboarding" variant="secondary" onClick={() => navigate('/onboarding')}>
          Configure sending domain
        </Button>
      </Card>
    </section>
  );
}
