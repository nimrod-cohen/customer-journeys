// SystemAdminConsole (§12, system-admin only): a cross-company list of all
// workspaces + drill-in. EVERY read here is a cross-tenant access that the server
// writes to admin_audit_log (§3A). The nav only shows this to system-admin, and
// the server independently 403s non-admins.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';

interface Workspace {
  id: string;
  name: string;
  status: string;
}

export function SystemAdminConsole() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void api.get<{ workspaces: Workspace[] }>('/admin/workspaces').then((r) => setWorkspaces(r.workspaces));
  }, []);

  const open = async (id: string) => {
    const r = await api.get<{ workspace: Record<string, unknown> }>(`/admin/workspaces/${id}`);
    setSelected(r.workspace);
  };

  return (
    <section data-testid="system-admin-console">
      <h1>System admin — all companies</h1>
      <table>
        <tbody>
          {workspaces.map((w) => (
            <tr data-testid="admin-workspace-row" key={w.id}>
              <td>{w.name}</td>
              <td>{w.status}</td>
              <td>
                <button data-testid="admin-open-workspace" type="button" onClick={() => open(w.id)}>
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected ? (
        <pre data-testid="admin-workspace-detail">{JSON.stringify(selected)}</pre>
      ) : null}
    </section>
  );
}
