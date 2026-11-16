// Saved email components (a footer, a header…) used across many emails. An email
// holds a LINKED row: a reference plus a snapshot of the component's rows. The
// snapshot is what renders, so serializing stays pure; the server refreshes it
// from the component table whenever the component or the email is saved.
import type { DesignRow, EmailDesign } from './model.js';

/** Replace every linked row with the component's own rows (what gets sent). */
export function expandComponents(rows: readonly DesignRow[]): DesignRow[] {
  return rows.flatMap((r) => (r.component ? r.component.rows.filter((c) => !c.component) : [r]));
}

/** The distinct component ids an email links to. */
export function componentIdsIn(design: EmailDesign | null | undefined): string[] {
  const ids = new Set<string>();
  for (const r of design?.rows ?? []) if (r.component) ids.add(r.component.id);
  return [...ids];
}

/** Current content of a component, as stored. */
export interface ComponentContent {
  readonly name: string;
  readonly rows: readonly DesignRow[];
}

/**
 * Refresh every linked row's snapshot from `lookup`. A component missing from
 * the lookup (deleted) keeps its last snapshot, so the email still renders.
 */
export function refreshComponents(design: EmailDesign, lookup: ReadonlyMap<string, ComponentContent>): EmailDesign {
  return {
    ...design,
    rows: design.rows.map((r) => {
      const c = r.component ? lookup.get(r.component.id) : undefined;
      if (!r.component || !c) return r;
      return { ...r, elements: [], component: { id: r.component.id, name: c.name, rows: expandComponents(c.rows) } };
    }),
  };
}

/**
 * Deep-copy rows giving every row, element and cell a fresh id from `newId` —
 * used to UNLINK a component into an editable copy (two copies of one footer in
 * one email must not share element ids, or selecting one selects both).
 */
export function cloneRowsWithFreshIds(rows: readonly DesignRow[], newId: (prefix: string) => string): DesignRow[] {
  return expandComponents(rows).map((row) => ({
    ...row,
    id: newId('row'),
    elements: row.elements.map((el) =>
      el.type === 'grid'
        ? {
            ...el,
            id: newId('el'),
            children: el.children.map((cell) => ({
              ...cell,
              id: newId('cell'),
              elements: cell.elements.map((leaf) => ({ ...leaf, id: newId('el') })),
            })),
          }
        : { ...el, id: newId('el') },
    ),
  }));
}
