// SystemAdminConsole (§12, system-admin only): manage the company → workspace
// hierarchy and drill into any workspace. EVERY read/write here is a cross-tenant
// action the server writes to admin_audit_log (§3A). The nav only shows this to
// system-admin; the server independently 403s non-admins. data-testid preserved.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/session.js';
import { Badge, Button, Card, Field, Input, PageHeader, Select, toneFor } from '../ui/kit.js';

interface AdminWorkspace {
  id: string;
  name: string;
  status: string;
}
interface AdminCompany {
  id: string;
  name: string;
  status: string;
  workspaces: AdminWorkspace[];
}

export function SystemAdminConsole() {
  const [companies, setCompanies] = useState<AdminCompany[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);

  const load = () => api.get<{ companies: AdminCompany[] }>('/admin/companies').then((r) => setCompanies(r.companies));
  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/admin/companies', { body: { name } });
      setNewName('');
      await load();
    } catch (e) {
      setErr((e as { error?: string })?.error ?? 'could not create company');
    } finally {
      setBusy(false);
    }
  };

  const assign = async (workspaceId: string, companyId: string) => {
    if (!companyId) return;
    await api.patch(`/admin/workspaces/${workspaceId}`, { body: { company_id: companyId } });
    await load();
  };

  const open = async (id: string) => {
    const r = await api.get<{ workspace: Record<string, unknown> }>(`/admin/workspaces/${id}`);
    setSelected(r.workspace);
  };

  return (
    <section data-testid="system-admin-console">
      <PageHeader
        title="System admin"
        subtitle="Manage companies and their workspaces — every access here is written to the audit log."
        actions={<Badge tone="warn">platform-admin</Badge>}
      />

      {/* Create a company */}
      <Card class="mb-5 p-4">
        <div class="flex items-end gap-3">
          <Field label="New company" class="flex-1">
            <Input
              data-testid="company-name"
              placeholder="e.g. Acme"
              value={newName}
              onInput={(e: Event) => setNewName((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Button data-testid="create-company" onClick={create} disabled={busy || !newName.trim()}>
            {busy ? 'Creating…' : 'Create company'}
          </Button>
        </div>
        {err ? <p data-testid="admin-company-error" class="mt-2 text-sm text-rose-600">{err}</p> : null}
      </Card>

      {/* Companies and their workspaces */}
      <div class="space-y-4">
        {companies.map((c) => (
          <Card data-testid="admin-company" data-id={c.id} key={c.id} class="overflow-hidden">
            <div class="flex items-center justify-between border-b border-stone-200 bg-stone-50 px-4 py-2.5">
              <span data-testid="admin-company-name" class="font-semibold text-ink-900">
                {c.name}
              </span>
              <span class="text-xs text-stone-500">
                {c.workspaces.length} {c.workspaces.length === 1 ? 'workspace' : 'workspaces'}
              </span>
            </div>
            {c.workspaces.length === 0 ? (
              <p class="px-4 py-3 text-sm text-stone-400">No workspaces in this company.</p>
            ) : (
              <table class="w-full text-sm">
                <tbody class="divide-y divide-stone-100">
                  {c.workspaces.map((w) => (
                    <tr data-testid="admin-workspace-row" key={w.id} class="hover:bg-stone-50/70">
                      <td class="px-4 py-2.5 font-medium text-ink-900">{w.name}</td>
                      <td class="px-4 py-2.5">
                        <Badge tone={toneFor(w.status)}>{w.status}</Badge>
                      </td>
                      <td class="px-4 py-2.5">
                        <Select
                          data-testid="assign-company-select"
                          data-ws={w.id}
                          value={c.id}
                          class="w-48"
                          onChange={(e: Event) => void assign(w.id, (e.target as HTMLSelectElement).value)}
                        >
                          {companies.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td class="px-4 py-2.5 text-right">
                        <Button
                          data-testid="admin-open-workspace"
                          variant="ghost"
                          size="sm"
                          onClick={() => open(w.id)}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ))}
      </div>

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
