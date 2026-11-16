// Saved email components for the designer host: loads the library, saves a row
// as a new component, and opens one for editing in its own tab (so the email
// being edited stays open). Re-loads when the tab regains focus, so a component
// edited elsewhere shows its new content here.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from './session.js';
import type { ComponentItem, ComponentsHost } from '../email-designer/state.js';
import type { DesignRow, EmailDesign } from '../email-designer/model.js';

interface ComponentRow {
  id: string;
  name: string;
  design: EmailDesign;
  used_by?: number;
  updated_at?: string;
}

const toItem = (c: ComponentRow): ComponentItem => ({ id: c.id, name: c.name, rows: c.design?.rows ?? [] });

export function useComponentsHost(settings: () => EmailDesign['settings']): ComponentsHost {
  const [list, setList] = useState<ComponentItem[]>([]);
  useEffect(() => {
    const load = (): void => {
      void api
        .get<{ components: ComponentRow[] }>('/email-components')
        .then((r) => setList(r.components.map(toItem)))
        .catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  return useMemo<ComponentsHost>(
    () => ({
      list,
      async save(name: string, rows: readonly DesignRow[]) {
        // The component keeps the email's look (direction, font) for its own editor.
        const r = await api.post<{ component: ComponentRow }>('/email-components', {
          body: { name, design: { version: 1, settings: settings() ?? {}, rows } },
        });
        const item = toItem(r.component);
        setList((l) => [...l, item].sort((a, b) => a.name.localeCompare(b.name)));
        return item;
      },
      edit(id: string) {
        window.open(`#/components/${id}`, '_blank');
      },
    }),
    [list],
  );
}
