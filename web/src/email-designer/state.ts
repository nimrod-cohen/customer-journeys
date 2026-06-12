// Email-designer state (ported from nomentor's editor/src/state.js, narrowed to
// the email model and converted to strict TS). @preact/signals drive the canvas,
// selection, properties panel and history. The designer is EMBEDDABLE: a host
// calls loadDesign() with the stored design and subscribes via onDesignChange —
// there is no fetching or persistence in here.
import { signal } from '@preact/signals';
import {
  emptyDesign,
  type DesignElement,
  type DesignRow,
  type DesignSettings,
  type EmailDesign,
  type GridCell,
  type GridElement,
  type LeafElement,
} from './model.js';

// ── Document state ────────────────────────────────────────────────────────────

export const rows = signal<DesignRow[]>([]);
export const settings = signal<DesignSettings>({});
export const selectedId = signal<string | null>(null);
/** Sidebar mode: toolbox (default) | properties | settings | history. */
export const sidebarMode = signal<'toolbox' | 'properties' | 'settings' | 'history'>('toolbox');

/** Drag state: a toolbox item being dragged onto the canvas. */
export const dragging = signal<{ type: DesignElement['type'] } | null>(null);
export const dropTargetId = signal<string | null>(null);

// ── ids ──────────────────────────────────────────────────────────────────────

let _nextId = 1;
const nextId = (prefix = 'el'): string => `${prefix}-${_nextId++}`;

/** Bump the id counter past every id in a loaded design (avoids collisions). */
function syncIdCounter(list: readonly DesignRow[]): void {
  let max = 0;
  const scanId = (id: string): void => {
    const num = parseInt(id.split('-').pop() ?? '', 10);
    if (Number.isFinite(num) && num > max) max = num;
  };
  for (const row of list) {
    scanId(row.id);
    for (const el of row.elements) {
      scanId(el.id);
      if (el.type === 'grid') {
        for (const cell of el.children) {
          scanId(cell.id);
          for (const sub of cell.elements) scanId(sub.id);
        }
      }
    }
  }
  if (max >= _nextId) _nextId = max + 1;
}

// ── Change notification + history ────────────────────────────────────────────

type DesignListener = (design: EmailDesign) => void;
let _listener: DesignListener | null = null;

/** The current document as a design value. */
export function currentDesign(): EmailDesign {
  return { version: 1, settings: settings.value, rows: rows.value };
}

interface HistoryEntry {
  readonly snapshot: string;
  readonly action: string;
}
export const undoStack = signal<HistoryEntry[]>([]);
export const redoStack = signal<HistoryEntry[]>([]);
const MAX_HISTORY = 100;

function snapshot(): string {
  return JSON.stringify(currentDesign());
}

/**
 * Commit a change: push the PRE-change snapshot for undo, clear redo, notify the
 * host. Call AFTER mutating rows/settings, passing the snapshot taken before —
 * or use mutate() which handles the pairing.
 */
function notify(): void {
  _listener?.(currentDesign());
}

/** Run a mutation as one undoable step (snapshot → fn → history + notify). */
export function mutate(action: string, fn: () => void): void {
  const before = snapshot();
  fn();
  const after = snapshot();
  if (after === before) return;
  const list = [...undoStack.value, { snapshot: before, action }];
  while (list.length > MAX_HISTORY) list.shift();
  undoStack.value = list;
  redoStack.value = [];
  notify();
}

export function undo(): void {
  const list = [...undoStack.value];
  const entry = list.pop();
  if (!entry) return;
  redoStack.value = [...redoStack.value, { snapshot: snapshot(), action: entry.action }];
  undoStack.value = list;
  applySnapshot(entry.snapshot);
}

export function redo(): void {
  const list = [...redoStack.value];
  const entry = list.pop();
  if (!entry) return;
  undoStack.value = [...undoStack.value, { snapshot: snapshot(), action: entry.action }];
  redoStack.value = list;
  applySnapshot(entry.snapshot);
}

function applySnapshot(s: string): void {
  try {
    const d = JSON.parse(s) as EmailDesign;
    rows.value = [...d.rows] as DesignRow[];
    settings.value = d.settings ?? {};
    notify();
  } catch {
    /* corrupt snapshot — ignore */
  }
}

/** Host entry point: load a design (or start empty) and register the listener. */
export function loadDesign(design: EmailDesign | null, onChange: DesignListener | null): void {
  const d = design ?? emptyDesign();
  rows.value = [...d.rows] as DesignRow[];
  settings.value = d.settings ?? {};
  selectedId.value = null;
  sidebarMode.value = 'toolbox';
  undoStack.value = [];
  redoStack.value = [];
  dragging.value = null;
  dropTargetId.value = null;
  _listener = onChange;
  syncIdCounter(d.rows);
}

/** A settings patch that may explicitly set keys to undefined (= clear them). */
export type SettingsPatch = { [K in keyof DesignSettings]?: DesignSettings[K] | undefined };

/** Update template settings (direction, font, widths, palette…). */
export function updateSettings(patch: SettingsPatch): void {
  mutate('Settings', () => {
    settings.value = { ...settings.value, ...patch } as DesignSettings;
  });
}

// ── Element factory (defaults per type, narrowed to the email model) ─────────

function defaultElement(type: DesignElement['type']): DesignElement {
  const id = nextId();
  switch (type) {
    case 'heading':
      return { id, type, props: { text: 'Heading', level: 'h2' } };
    case 'text':
      return { id, type, props: { html: 'Type your text here…' } };
    case 'image':
      return { id, type, props: { src: '' } };
    case 'button':
      return {
        id,
        type,
        props: { text: 'Click me', url: '', bgColor: '#4a90d9', color: '#ffffff', borderRadius: 6, align: 'center' },
      };
    case 'list':
      return {
        id,
        type,
        props: {
          listType: 'ul',
          items: [
            { id: nextId('li'), text: 'Item 1' },
            { id: nextId('li'), text: 'Item 2' },
            { id: nextId('li'), text: 'Item 3' },
          ],
        },
      };
    case 'separator':
      return { id, type, props: { lineColor: '#dddddd', lineThickness: 1, lineStyle: 'solid' } };
    case 'grid':
      return {
        id,
        type,
        props: { columns: 2 },
        children: [
          { id: nextId('cell'), elements: [] },
          { id: nextId('cell'), elements: [] },
        ],
      };
  }
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

function mapElements(
  elements: readonly DesignElement[],
  id: string,
  fn: (el: DesignElement) => DesignElement,
): DesignElement[] {
  return elements.map((el) => {
    if (el.id === id) return fn(el);
    if (el.type === 'grid') {
      return {
        ...el,
        children: el.children.map((cell) => ({
          ...cell,
          elements: cell.elements.map((sub) => (sub.id === id ? (fn(sub) as LeafElement) : sub)),
        })),
      };
    }
    return el;
  });
}

function filterElements(elements: readonly DesignElement[], id: string): DesignElement[] {
  return elements
    .filter((el) => el.id !== id)
    .map((el) =>
      el.type === 'grid'
        ? { ...el, children: el.children.map((cell) => ({ ...cell, elements: cell.elements.filter((s) => s.id !== id) })) }
        : el,
    );
}

export function findElement(id: string): DesignElement | null {
  for (const row of rows.value) {
    for (const el of row.elements) {
      if (el.id === id) return el;
      if (el.type === 'grid') {
        for (const cell of el.children) {
          const sub = cell.elements.find((s) => s.id === id);
          if (sub) return sub;
        }
      }
    }
  }
  return null;
}

export function findRow(id: string): DesignRow | null {
  return rows.value.find((r) => r.id === id) ?? null;
}

export function findCell(id: string): GridCell | null {
  for (const row of rows.value) {
    for (const el of row.elements) {
      if (el.type === 'grid') {
        const cell = el.children.find((c) => c.id === id);
        if (cell) return cell;
      }
    }
  }
  return null;
}

// ── Row operations ───────────────────────────────────────────────────────────

export function addRow(beforeRowId: string | null = null): string {
  const row: DesignRow = { id: nextId('row'), props: {}, elements: [] };
  const list = [...rows.value];
  const idx = beforeRowId ? list.findIndex((r) => r.id === beforeRowId) : -1;
  if (idx >= 0) list.splice(idx, 0, row);
  else list.push(row);
  rows.value = list;
  return row.id;
}

export function removeRow(rowId: string): void {
  rows.value = rows.value.filter((r) => r.id !== rowId);
  if (selectedId.value === rowId) selectedId.value = null;
}

export function reorderRow(rowId: string, beforeRowId: string | null): void {
  const list = [...rows.value];
  const idx = list.findIndex((r) => r.id === rowId);
  if (idx < 0) return;
  const [row] = list.splice(idx, 1);
  const tIdx = beforeRowId ? list.findIndex((r) => r.id === beforeRowId) : -1;
  if (tIdx >= 0) list.splice(tIdx, 0, row!);
  else list.push(row!);
  rows.value = list;
}

export function updateRowProps(rowId: string, patch: Record<string, unknown>): void {
  rows.value = rows.value.map((r) => (r.id === rowId ? { ...r, props: { ...(r.props ?? {}), ...patch } } : r));
}

// ── Element operations ───────────────────────────────────────────────────────

export function addElementToRow(rowId: string, type: DesignElement['type'], beforeElementId: string | null = null): string {
  const el = defaultElement(type);
  rows.value = rows.value.map((row) => {
    if (row.id !== rowId) return row;
    const elements = [...row.elements];
    const idx = beforeElementId ? elements.findIndex((e) => e.id === beforeElementId) : -1;
    if (idx >= 0) elements.splice(idx, 0, el);
    else elements.push(el);
    return { ...row, elements };
  });
  selectedId.value = el.id;
  return el.id;
}

export function addElementToCell(cellId: string, type: DesignElement['type']): string | null {
  if (type === 'grid') return null; // grids cannot nest (MJML constraint)
  const el = defaultElement(type) as LeafElement;
  rows.value = rows.value.map((row) => ({
    ...row,
    elements: row.elements.map((e) =>
      e.type === 'grid'
        ? { ...e, children: e.children.map((cell) => (cell.id === cellId ? { ...cell, elements: [...cell.elements, el] } : cell)) }
        : e,
    ),
  }));
  selectedId.value = el.id;
  return el.id;
}

export function removeElement(id: string): void {
  rows.value = rows.value.map((row) => ({ ...row, elements: filterElements(row.elements, id) }));
  if (selectedId.value === id) selectedId.value = null;
}

export function updateElementProps(id: string, patch: Record<string, unknown>): void {
  rows.value = rows.value.map((row) => ({
    ...row,
    elements: mapElements(row.elements, id, (el) => ({ ...el, props: { ...el.props, ...patch } }) as DesignElement),
  }));
}

export function updateCellProps(cellId: string, patch: Record<string, unknown>): void {
  rows.value = rows.value.map((row) => ({
    ...row,
    elements: row.elements.map((el) =>
      el.type === 'grid'
        ? {
            ...el,
            children: el.children.map((cell) =>
              cell.id === cellId ? { ...cell, props: { ...(cell.props ?? {}), ...patch } } : cell,
            ),
          }
        : el,
    ),
  }));
}

export function addGridCell(gridId: string): void {
  rows.value = rows.value.map((row) => ({
    ...row,
    elements: row.elements.map((el) =>
      el.id === gridId && el.type === 'grid'
        ? {
            ...el,
            props: { ...el.props, columns: el.children.length + 1 },
            children: [...el.children, { id: nextId('cell'), elements: [] }],
          }
        : el,
    ),
  }));
}

export function removeGridCell(gridId: string, cellId: string): void {
  rows.value = rows.value.map((row) => ({
    ...row,
    elements: row.elements.map((el) =>
      el.id === gridId && el.type === 'grid' && el.children.length > 1
        ? {
            ...el,
            props: { ...el.props, columns: el.children.length - 1 },
            children: el.children.filter((c) => c.id !== cellId),
          }
        : el,
    ),
  }));
}

// ── Duplicate ────────────────────────────────────────────────────────────────

function cloneElement(el: DesignElement): DesignElement {
  if (el.type === 'grid') {
    return {
      ...el,
      id: nextId(),
      props: { ...el.props },
      children: el.children.map((cell) => ({
        id: nextId('cell'),
        ...(cell.props ? { props: { ...cell.props } } : {}),
        elements: cell.elements.map((sub) => cloneElement(sub) as LeafElement),
      })),
    };
  }
  const copy = { ...el, id: nextId(), props: { ...el.props } } as DesignElement;
  if (copy.type === 'list') {
    return { ...copy, props: { ...copy.props, items: copy.props.items.map((i) => ({ ...i, id: nextId('li') })) } };
  }
  return copy;
}

export function duplicateElement(id: string): void {
  const original = findElement(id);
  if (!original) return;
  const clone = cloneElement(original);
  rows.value = rows.value.map((row) => {
    const idx = row.elements.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const elements = [...row.elements];
      elements.splice(idx + 1, 0, clone);
      return { ...row, elements };
    }
    return {
      ...row,
      elements: row.elements.map((el) => {
        if (el.type !== 'grid') return el;
        let found = false;
        const children = el.children.map((cell) => {
          const ci = cell.elements.findIndex((e) => e.id === id);
          if (ci < 0) return cell;
          found = true;
          const elements = [...cell.elements];
          elements.splice(ci + 1, 0, clone as LeafElement);
          return { ...cell, elements };
        });
        return found ? { ...el, children } : el;
      }),
    };
  });
  selectedId.value = clone.id;
}

export function duplicateRow(rowId: string): void {
  const original = rows.value.find((r) => r.id === rowId);
  if (!original) return;
  const clone: DesignRow = {
    id: nextId('row'),
    ...(original.props ? { props: { ...original.props } } : {}),
    elements: original.elements.map(cloneElement),
  };
  const list = [...rows.value];
  list.splice(list.findIndex((r) => r.id === rowId) + 1, 0, clone);
  rows.value = list;
  selectedId.value = clone.id;
}

// ── Move (navigator drag) ────────────────────────────────────────────────────

export function moveElement(id: string, target: { rowId?: string; cellId?: string; beforeElementId?: string | null }): void {
  const el = findElement(id);
  if (!el) return;
  const moved = JSON.parse(JSON.stringify(el)) as DesignElement;
  if (target.cellId && moved.type === 'grid') return; // grids cannot enter cells

  let next = rows.value.map((row) => ({ ...row, elements: filterElements(row.elements, id) }));
  if (target.cellId) {
    next = next.map((row) => ({
      ...row,
      elements: row.elements.map((e) =>
        e.type === 'grid'
          ? {
              ...e,
              children: e.children.map((cell) => {
                if (cell.id !== target.cellId) return cell;
                const elements = [...cell.elements];
                const idx = target.beforeElementId ? elements.findIndex((x) => x.id === target.beforeElementId) : -1;
                if (idx >= 0) elements.splice(idx, 0, moved as LeafElement);
                else elements.push(moved as LeafElement);
                return { ...cell, elements };
              }),
            }
          : e,
      ),
    }));
  } else if (target.rowId) {
    next = next.map((row) => {
      if (row.id !== target.rowId) return row;
      const elements = [...row.elements];
      const idx = target.beforeElementId ? elements.findIndex((x) => x.id === target.beforeElementId) : -1;
      if (idx >= 0) elements.splice(idx, 0, moved);
      else elements.push(moved);
      return { ...row, elements };
    });
  }
  rows.value = next;
}

// ── Drops ────────────────────────────────────────────────────────────────────

/** Drop on the canvas background: a new row containing the element. */
export function dropOnCanvas(type: DesignElement['type'], beforeRowId: string | null = null): void {
  mutate(`Add ${type}`, () => {
    const rowId = addRow(beforeRowId);
    addElementToRow(rowId, type);
  });
}

/** Drop on an existing row: append the element to it. */
export function dropOnRow(type: DesignElement['type'], rowId: string): void {
  mutate(`Add ${type}`, () => {
    addElementToRow(rowId, type);
  });
}

/** Drop into a grid cell. */
export function dropOnCell(type: DesignElement['type'], cellId: string): void {
  if (type === 'grid') return;
  mutate(`Add ${type}`, () => {
    addElementToCell(cellId, type);
  });
}

/**
 * Click-to-add (toolbox click): into the selected row/cell when one is selected,
 * else a new row at the end. Keeps the designer fully usable without drag-and-
 * drop (and e2e-testable).
 */
export function clickToAdd(type: DesignElement['type']): void {
  const sel = selectedId.value;
  if (sel) {
    if (findRow(sel)) {
      dropOnRow(type, sel);
      return;
    }
    if (findCell(sel) && type !== 'grid') {
      dropOnCell(type, sel);
      return;
    }
  }
  dropOnCanvas(type, null);
}

// ── Selection ────────────────────────────────────────────────────────────────

export function selectNode(id: string | null): void {
  selectedId.value = id;
  if (id) sidebarMode.value = 'properties';
}

/** Whether the GRID containing this cell id exists (for cell property panels). */
export function parentGridOfCell(cellId: string): GridElement | null {
  for (const row of rows.value) {
    for (const el of row.elements) {
      if (el.type === 'grid' && el.children.some((c) => c.id === cellId)) return el;
    }
  }
  return null;
}
