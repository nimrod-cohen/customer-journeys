// Document tree (port of nomentor's Navigator.jsx, simplified): rows → elements
// → grid columns → elements. Click selects; rows reorder with ↑/↓; ELEMENTS can
// be DRAGGED to relocate them — drop on a row (append), on another element
// (insert before it), or on a grid column (move into it), across rows.
import type { JSX } from 'preact';
import {
  rows,
  selectedId,
  selectNode,
  reorderRow,
  moveElement,
  navDragId,
  navDropTargetId,
  mutate,
} from './state.js';
import { ArrowUp, ArrowDown } from './icons.tsx';
import type { DesignElement } from './model.js';

/** Where a dragged element should land. */
type DropTarget = { rowId?: string; cellId?: string; beforeElementId?: string | null };

/** Apply a navigator drag-drop (no-op if nothing is being dragged). */
function drop(target: DropTarget): void {
  const id = navDragId.value;
  navDropTargetId.value = null;
  navDragId.value = null;
  if (!id) return;
  mutate('Move element', () => moveElement(id, target));
}

/** Allow a drop here while an element is being dragged, and highlight the target. */
function dragOver(e: DragEvent, targetId: string): void {
  if (!navDragId.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  navDropTargetId.value = targetId;
}

export function Navigator(): JSX.Element {
  const list = rows.value;
  return (
    <aside data-testid="designer-navigator" class="nm-navigator">
      <div class="nm-panel-title">Structure</div>
      {list.length === 0 ? <p class="nm-props-empty">Empty design.</p> : null}
      {list.map((row, idx) => (
        <div key={row.id} class="nm-nav-row">
          <div
            data-testid="nav-row"
            data-row-id={row.id}
            class={`nm-nav-item ${selectedId.value === row.id ? 'nm-active' : ''} ${
              navDropTargetId.value === row.id ? 'nm-droptarget' : ''
            }`}
            onClick={() => selectNode(row.id)}
            // Drop onto the row → append the dragged element to it.
            onDragOver={(e) => dragOver(e, row.id)}
            onDragLeave={() => {
              if (navDropTargetId.value === row.id) navDropTargetId.value = null;
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop({ rowId: row.id });
            }}
          >
            <span>▦ row</span>
            <span class="nm-nav-actions">
              <button
                type="button"
                class="nm-mini-btn"
                title="Move up"
                disabled={idx === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  mutate('Reorder row', () => reorderRow(row.id, list[idx - 1]!.id));
                }}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                class="nm-mini-btn"
                title="Move down"
                disabled={idx === list.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  mutate('Reorder row', () => reorderRow(row.id, list[idx + 2]?.id ?? null));
                }}
              >
                <ArrowDown size={12} />
              </button>
            </span>
          </div>
          {row.elements.map((el) => (
            <NavElement key={el.id} el={el} depth={1} parent={{ rowId: row.id }} />
          ))}
        </div>
      ))}
    </aside>
  );
}

function NavElement({
  el,
  depth,
  parent,
}: {
  el: DesignElement;
  depth: number;
  parent: DropTarget;
}): JSX.Element {
  const isSelf = navDragId.value === el.id;
  return (
    <>
      <div
        data-testid="nav-element"
        data-element-id={el.id}
        class={`nm-nav-item nm-draggable ${selectedId.value === el.id ? 'nm-active' : ''} ${
          navDropTargetId.value === el.id ? 'nm-droptarget' : ''
        }`}
        style={{ paddingInlineStart: `${8 + depth * 14}px` }}
        draggable
        onClick={() => selectNode(el.id)}
        onDragStart={(e) => {
          navDragId.value = el.id;
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          navDragId.value = null;
          navDropTargetId.value = null;
        }}
        // Drop onto another element → insert the dragged one BEFORE it, in this
        // element's own container (row or grid cell).
        onDragOver={(e) => {
          if (isSelf) return;
          dragOver(e, el.id);
        }}
        onDragLeave={() => {
          if (navDropTargetId.value === el.id) navDropTargetId.value = null;
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isSelf) {
            navDragId.value = null;
            navDropTargetId.value = null;
            return;
          }
          drop({ ...parent, beforeElementId: el.id });
        }}
      >
        {el.type}
      </div>
      {el.type === 'grid'
        ? el.children.map((cell, i) => (
            <div key={cell.id}>
              <div
                data-testid="nav-cell"
                data-cell-id={cell.id}
                class={`nm-nav-item ${selectedId.value === cell.id ? 'nm-active' : ''} ${
                  navDropTargetId.value === cell.id ? 'nm-droptarget' : ''
                }`}
                style={{ paddingInlineStart: `${8 + (depth + 1) * 14}px` }}
                onClick={() => selectNode(cell.id)}
                onDragOver={(e) => dragOver(e, cell.id)}
                onDragLeave={() => {
                  if (navDropTargetId.value === cell.id) navDropTargetId.value = null;
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  drop({ cellId: cell.id });
                }}
              >
                column {i + 1}
              </div>
              {cell.elements.map((sub) => (
                <NavElement key={sub.id} el={sub} depth={depth + 2} parent={{ cellId: cell.id }} />
              ))}
            </div>
          ))
        : null}
    </>
  );
}
