// The "Save as component" flow, shared by the row's ⋮ menu (Structure panel) and
// the row's side panel, so both behave identically.
import { askText } from '../ui/dialog.js';
import { showToast } from '../ui/toast.js';
import { componentsHost, findRow, linkRow } from './state.js';

/** Ask for a name, store the row as a component, and link the row to it. */
export async function saveRowAsComponent(rowId: string): Promise<void> {
  const host = componentsHost.value;
  if (!host) return;
  const name = await askText({ title: 'Save as component', label: 'Name', placeholder: 'e.g. Footer', confirmLabel: 'Save' });
  if (!name?.trim()) return;
  const row = findRow(rowId);
  if (!row) return;
  try {
    const c = await host.save(name.trim(), [row]);
    linkRow(rowId, c);
    showToast(`Saved “${c.name}” — find it under Add → Saved components`, { tone: 'success' });
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Could not save the component', { tone: 'error' });
  }
}
