// CompanySettings (§12, owner/company-admin): manage the COMPANY's workspaces —
// a company can own several. List them (with Open to switch), add a new one,
// rename, or delete (type-the-name confirmation). All scoped server-side to the
// caller's company; tenant isolation stays at the workspace level.
import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useStore } from '../store/store.js';
import { api, sessionStore, refreshMe, switchWorkspace } from '../store/session.js';
import { Button, Card, Field, Input, PageHeader } from '../ui/kit.js';

export function CompanySettings() {
  const session = useStore(sessionStore);
  const [newWsName, setNewWsName] = useState('');
  const [wsError, setWsError] = useState('');
  const [delTarget, setDelTarget] = useState<{ id: string; name: string } | null>(null);
  const [delConfirm, setDelConfirm] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  // Rename the company itself.
  const [editingCompany, setEditingCompany] = useState(false);
  const [companyNameText, setCompanyNameText] = useState('');
  const [companyErr, setCompanyErr] = useState('');
  const saveCompanyName = async () => {
    const name = companyNameText.trim();
    if (!name) return;
    setCompanyErr('');
    try {
      await api.patch('/company', { body: { name } });
      setEditingCompany(false);
      await refreshMe();
    } catch (e) {
      setCompanyErr((e as { error?: string })?.error ?? 'could not rename company');
    }
  };

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

  const saveRename = async (id: string) => {
    const name = renameText.trim();
    if (!name) return;
    setWsError('');
    try {
      await api.patch(`/workspaces/${id}`, { body: { name } });
      setRenameId(null);
      await refreshMe();
    } catch (e) {
      setWsError((e as { error?: string })?.error ?? 'could not rename workspace');
    }
  };

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

  return (
    <section data-testid="company-settings">
      <PageHeader
        title={session.companyName ? `${session.companyName} — company settings` : 'Company settings'}
        subtitle="Workspaces owned by this company."
      />

      <Card class="mb-6 p-5">
        <h2 class="text-base font-bold text-ink-900">Company name</h2>
        {editingCompany ? (
          <div class="mt-2 flex flex-wrap items-end gap-2">
            <Input
              data-testid="company-name-input"
              class="max-w-sm flex-1"
              value={companyNameText}
              onInput={(e: Event) => setCompanyNameText((e.target as HTMLInputElement).value)}
            />
            <Button data-testid="company-rename-save" onClick={saveCompanyName} disabled={!companyNameText.trim()}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditingCompany(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div class="mt-2 flex items-center justify-between gap-3">
            <span data-testid="company-name" class="text-lg font-semibold text-ink-950">
              {session.companyName ?? '—'}
            </span>
            <Button
              data-testid="rename-company"
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditingCompany(true);
                setCompanyNameText(session.companyName ?? '');
                setCompanyErr('');
              }}
            >
              Rename
            </Button>
          </div>
        )}
        {companyErr ? <p data-testid="company-error" class="mt-2 text-sm text-rose-600">{companyErr}</p> : null}
      </Card>

      <Card data-testid="company-workspaces" class="p-5">
        <h2 class="text-base font-bold text-ink-900">Workspaces</h2>
        <p class="mt-1 text-sm text-stone-500">
          A company can own several workspaces. Add, rename, switch into, or delete them here.
        </p>
        <ul class="mt-3 divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200">
          {session.memberships.map((m) => (
            <li
              data-testid="ws-row"
              key={m.workspaceId}
              class="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              {renameId === m.workspaceId ? (
                <span class="flex flex-1 items-center gap-2">
                  <Input
                    data-testid="rename-input"
                    class="max-w-xs"
                    value={renameText}
                    onInput={(e: Event) => setRenameText((e.target as HTMLInputElement).value)}
                  />
                  <Button data-testid="rename-save" size="sm" onClick={() => void saveRename(m.workspaceId)}>
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRenameId(null)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <>
                  <span class="text-ink-900">
                    {m.name ?? m.workspaceId}
                    {m.workspaceId === session.workspaceId ? (
                      <span class="ml-2 text-[11px] uppercase tracking-wide text-brand-600">active</span>
                    ) : null}
                  </span>
                  <span class="flex items-center gap-1">
                    <Button
                      data-testid="rename-workspace"
                      data-ws={m.workspaceId}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRenameId(m.workspaceId);
                        setRenameText(m.name ?? '');
                      }}
                    >
                      Rename
                    </Button>
                    {m.workspaceId !== session.workspaceId ? (
                      <>
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
                      </>
                    ) : null}
                  </span>
                </>
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
