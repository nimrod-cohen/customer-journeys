// CompanyUsers (company-centric RBAC, owner-gated / manage_workspace_users): manage
// the COMPANY's users and their company ROLE (owner | marketer | accounting).
//   - owner      → all workspaces + all company settings + user management
//   - marketer   → marketing ONLY in the workspaces GRANTED to them (checkboxes)
//   - accounting → the company Billing & usage section only (no workspace)
// "Pass ownership" = set another user's role to owner (co-owners). A company always
// keeps ≥1 owner (server-enforced last-owner guard). All scoped server-side to the
// caller's company (never a body-supplied company id).
import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../store/store.js';
import { api, sessionStore } from '../store/session.js';
import { Button, Card, Field, Input, Select, Badge } from '../ui/kit.js';
import { askConfirm } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';

interface CompanyUser {
  readonly user_id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: 'owner' | 'marketer' | 'accounting';
  readonly workspace_ids: string[];
}
interface WorkspaceLite {
  readonly id: string;
  readonly name: string;
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', marketer: 'Marketer', accounting: 'Accounting' };
const roleTone = (r: string): 'success' | 'warn' | 'neutral' =>
  r === 'owner' ? 'success' : r === 'accounting' ? 'warn' : 'neutral';

export function CompanyUsersPanel() {
  const session = useStore(sessionStore);
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [loading, setLoading] = useState(true);
  // Add-user form.
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'marketer' | 'accounting'>('marketer');
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [err, setErr] = useState('');

  const load = async () => {
    const r = await api.get<{ users: CompanyUser[]; workspaces: WorkspaceLite[] }>('/company/users');
    setUsers(r.users);
    setWorkspaces(r.workspaces);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, []);

  const addUser = async () => {
    setErr('');
    try {
      const r = await api.post<{ invited?: boolean }>('/company/users', {
        body: { email: email.trim(), role, workspace_ids: role === 'marketer' ? [...grants] : [] },
      });
      setEmail('');
      setRole('marketer');
      setGrants(new Set());
      await load();
      showToast(r.invited ? `Invite sent to ${email.trim()}` : 'User added', { tone: 'success' });
    } catch (e) {
      setErr((e as { error?: string })?.error ?? 'could not add user');
    }
  };

  const changeRole = async (u: CompanyUser, newRole: string) => {
    try {
      await api.patch('/company/users', { body: { user_id: u.user_id, role: newRole } });
      await load();
      showToast(newRole === 'owner' ? `${u.email} is now an owner` : 'Role updated', { tone: 'success' });
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'could not change role', { tone: 'error' });
    }
  };

  const toggleGrant = async (u: CompanyUser, workspaceId: string) => {
    const next = new Set(u.workspace_ids);
    if (next.has(workspaceId)) next.delete(workspaceId);
    else next.add(workspaceId);
    try {
      await api.patch('/company/users', { body: { user_id: u.user_id, workspace_ids: [...next] } });
      await load();
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'could not update access', { tone: 'error' });
    }
  };

  const removeUser = async (u: CompanyUser) => {
    const okd = await askConfirm({
      title: 'Remove user',
      message: `Remove ${u.email} from the company? They lose all access.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!okd) return;
    try {
      await api.del(`/company/users/${u.user_id}`);
      await load();
      showToast('User removed', { tone: 'success' });
    } catch (e) {
      showToast((e as { error?: string })?.error ?? 'could not remove user', { tone: 'error' });
    }
  };

  return (
    <Card data-testid="company-users-screen" class="p-5">
      <h2 class="text-base font-bold text-ink-900">Users</h2>
      <p class="mt-1 text-sm text-stone-500">
        People in this company and what they can do. Owners manage everything; marketers work only in the
        workspaces you grant them; accounting sees Billing &amp; usage only.
      </p>

      {loading ? (
        <p class="mt-4 text-sm text-stone-400">Loading…</p>
      ) : (
        <ul class="mt-4 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
          {users.map((u) => {
            const isSelf = u.user_id === session.sub;
            // The LAST owner can't be demoted or removed — a company always keeps ≥1
            // owner (a system-admin acts cross-tenant but is NOT a company owner, so it
            // never counts here). The server enforces this too (defense in depth).
            const isLastOwner = u.role === 'owner' && users.filter((x) => x.role === 'owner').length <= 1;
            const locked = isSelf || isLastOwner;
            const lockReason = isSelf
              ? 'You can’t change your own role — ask another owner'
              : isLastOwner
                ? 'A company must keep at least one owner — add another owner first'
                : undefined;
            return (
              <li data-testid="company-user-row" data-uid={u.user_id} key={u.user_id} class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 text-sm">
                <div class="min-w-[12rem] flex-1">
                  <div class="font-medium text-ink-900">{u.email}</div>
                  {u.name ? <div class="text-xs text-stone-500">{u.name}</div> : null}
                </div>
                <Badge data-testid="company-user-role-badge" tone={roleTone(u.role)}>
                  {ROLE_LABEL[u.role]}
                </Badge>
                {/* Role picker (a marketer/accounting/owner change; "pass ownership" = owner). */}
                <Select
                  data-testid="company-user-role"
                  value={u.role}
                  disabled={locked}
                  title={lockReason}
                  onChange={(e: Event) => changeRole(u, (e.target as HTMLSelectElement).value)}
                  class="w-36"
                >
                  <option value="owner">Owner</option>
                  <option value="marketer">Marketer</option>
                  <option value="accounting">Accounting</option>
                </Select>
                <div class="flex items-center gap-2">
                  {isSelf ? (
                    <span class="text-xs text-stone-400">you</span>
                  ) : isLastOwner ? (
                    <span data-testid="company-user-lastowner" class="text-xs text-stone-400" title={lockReason}>
                      Last owner
                    </span>
                  ) : (
                    <Button
                      data-testid="company-user-remove"
                      variant="ghost"
                      size="sm"
                      class="text-rose-600 hover:bg-rose-50"
                      onClick={() => removeUser(u)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {/* Marketer workspace grants. */}
                {u.role === 'marketer' ? (
                  <div data-testid="company-user-grants" class="mt-1 flex w-full flex-wrap gap-x-4 gap-y-1 border-t border-stone-100 pt-2 pl-1">
                    <span class="text-xs font-semibold uppercase tracking-wide text-stone-400">Workspaces</span>
                    {workspaces.length === 0 ? (
                      <span class="text-xs text-stone-400">No workspaces yet</span>
                    ) : (
                      workspaces.map((w) => (
                        <label key={w.id} class="flex items-center gap-1.5 text-xs text-ink-800">
                          <input
                            type="checkbox"
                            data-testid="company-user-grant"
                            data-ws={w.id}
                            checked={u.workspace_ids.includes(w.id)}
                            onChange={() => toggleGrant(u, w.id)}
                          />
                          {w.name}
                        </label>
                      ))
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add a user. */}
      <div class="mt-5 rounded-lg border border-stone-200 bg-stone-50/60 p-4">
        <h3 class="text-sm font-bold text-ink-900">Add a user</h3>
        <p class="mt-0.5 text-xs text-stone-500">
          They'll get an email invite to set a password and join (or are added instantly if they already have an account).
        </p>
        <div class="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Email" class="min-w-[14rem] flex-1">
            <Input
              data-testid="company-user-email"
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Role" class="w-40">
            <Select data-testid="company-user-new-role" value={role} onChange={(e: Event) => setRole((e.target as HTMLSelectElement).value as never)}>
              <option value="owner">Owner</option>
              <option value="marketer">Marketer</option>
              <option value="accounting">Accounting</option>
            </Select>
          </Field>
          <Button data-testid="company-user-add" onClick={addUser} disabled={!email.trim()}>
            Add user
          </Button>
        </div>
        {role === 'marketer' && workspaces.length > 0 ? (
          <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            <span class="text-xs font-semibold uppercase tracking-wide text-stone-400">Grant workspaces</span>
            {workspaces.map((w) => (
              <label key={w.id} class="flex items-center gap-1.5 text-xs text-ink-800">
                <input
                  type="checkbox"
                  data-testid="company-user-new-grant"
                  data-ws={w.id}
                  checked={grants.has(w.id)}
                  onChange={() => {
                    const next = new Set(grants);
                    if (next.has(w.id)) next.delete(w.id);
                    else next.add(w.id);
                    setGrants(next);
                  }}
                />
                {w.name}
              </label>
            ))}
          </div>
        ) : null}
        {err ? <p data-testid="company-user-error" class="mt-2 text-sm text-rose-600">{err}</p> : null}
      </div>
    </Card>
  );
}
