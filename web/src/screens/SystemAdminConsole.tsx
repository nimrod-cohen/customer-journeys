// SystemAdminConsole (§12, system-admin only): a cross-company list of all
// workspaces + drill-in. EVERY read here is a cross-tenant access that the server
// writes to admin_audit_log (§3A). The nav only shows this to system-admin, and
// the server independently 403s non-admins. (Visual redesign; data-testid preserved.)
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Card, PageHeader, toneFor } from '../ui/kit.js';

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
      <PageHeader
        title="System admin"
        subtitle="Cross-company view — every access here is written to the audit log."
        actions={<Badge tone="warn">platform-admin</Badge>}
      />

      <Card class="overflow-hidden">
        <table class="w-full text-sm">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-4 py-2.5 font-semibold">Workspace</th>
              <th class="px-4 py-2.5 font-semibold">Status</th>
              <th class="px-4 py-2.5 font-semibold"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100">
            {workspaces.map((w) => (
              <tr data-testid="admin-workspace-row" key={w.id} class="hover:bg-stone-50/70">
                <td class="px-4 py-2.5 font-medium text-ink-900">{w.name}</td>
                <td class="px-4 py-2.5">
                  <Badge tone={toneFor(w.status)}>{w.status}</Badge>
                </td>
                <td class="px-4 py-2.5 text-right">
                  <Button data-testid="admin-open-workspace" variant="ghost" size="sm" onClick={() => open(w.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {selected ? (
        <Card class="mt-5 overflow-auto p-4">
          <pre data-testid="admin-workspace-detail" class="font-mono text-xs text-stone-700">
            {JSON.stringify(selected, null, 2)}
          </pre>
        </Card>
      ) : null}
    </section>
  );
}
