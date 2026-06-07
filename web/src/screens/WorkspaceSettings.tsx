// WorkspaceSettings (§12, owner): members + roles management. Lists the active
// workspace's members and lets an owner add/change roles. The sending-domain
// status links to the OnboardingWizard. All scoped server-side to the token.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { navigate } from '../router.js';

interface Member {
  user_id: string;
  role: string;
}

export function WorkspaceSettings() {
  const [members, setMembers] = useState<Member[]>([]);
  const [newUser, setNewUser] = useState('');
  const [newRole, setNewRole] = useState('marketer');

  const reload = async () => {
    const r = await api.get<{ members: Member[] }>('/workspace/members');
    setMembers(r.members);
  };
  useEffect(() => {
    void reload();
  }, []);

  const add = async () => {
    await api.post('/workspace/members', { body: { user_id: newUser.trim(), role: newRole } });
    setNewUser('');
    await reload();
  };

  const changeRole = async (userId: string, role: string) => {
    await api.patch('/workspace/members', { body: { user_id: userId, role } });
    await reload();
  };

  return (
    <section data-testid="workspace-settings">
      <h1>Workspace settings</h1>
      <h2>Members</h2>
      <table>
        <tbody>
          {members.map((m) => (
            <tr data-testid="member-row" key={m.user_id}>
              <td>{m.user_id}</td>
              <td>
                <select
                  data-testid="member-role"
                  value={m.role}
                  onChange={(e) => changeRole(m.user_id, (e.target as HTMLSelectElement).value)}
                >
                  {['owner', 'marketer', 'accounting'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <input
          data-testid="new-member-id"
          placeholder="user id"
          value={newUser}
          onInput={(e) => setNewUser((e.target as HTMLInputElement).value)}
        />
        <select
          data-testid="new-member-role"
          value={newRole}
          onChange={(e) => setNewRole((e.target as HTMLSelectElement).value)}
        >
          {['owner', 'marketer', 'accounting'].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button data-testid="add-member" type="button" onClick={add}>
          Add member
        </button>
      </div>
      <h2>Sending domain</h2>
      <button data-testid="goto-onboarding" type="button" onClick={() => navigate('/onboarding')}>
        Configure sending domain
      </button>
    </section>
  );
}
