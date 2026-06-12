// Document tree (port of nomentor's Navigator.jsx, simplified): rows → elements
// → grid columns → elements. Click selects; rows can be reordered with ↑/↓.
import type { JSX } from 'preact';
import { rows, selectedId, selectNode, reorderRow, mutate } from './state.js';
import { ArrowUp, ArrowDown } from './icons.tsx';
import type { DesignElement } from './model.js';

export function Navigator(): JSX.Element {
  const list = rows.value;
  return (
    <aside data-testid="designer-navigator" class="nm-navigator">
      <div class="nm-panel-title">Structure</div>
      {list.length === 0 ? <p class="nm-props-empty">Empty design.</p> : null}
      {list.map((row, idx) => (
        <div key={row.id} class="nm-nav-row">
          <div
            class={`nm-nav-item ${selectedId.value === row.id ? 'nm-active' : ''}`}
            onClick={() => selectNode(row.id)}
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
            <NavElement key={el.id} el={el} depth={1} />
          ))}
        </div>
      ))}
    </aside>
  );
}

function NavElement({ el, depth }: { el: DesignElement; depth: number }): JSX.Element {
  return (
    <>
      <div
        class={`nm-nav-item ${selectedId.value === el.id ? 'nm-active' : ''}`}
        style={{ paddingInlineStart: `${8 + depth * 14}px` }}
        onClick={() => selectNode(el.id)}
      >
        {el.type}
      </div>
      {el.type === 'grid'
        ? el.children.map((cell, i) => (
            <div key={cell.id}>
              <div
                class={`nm-nav-item ${selectedId.value === cell.id ? 'nm-active' : ''}`}
                style={{ paddingInlineStart: `${8 + (depth + 1) * 14}px` }}
                onClick={() => selectNode(cell.id)}
              >
                column {i + 1}
              </div>
              {cell.elements.map((sub) => (
                <NavElement key={sub.id} el={sub} depth={depth + 2} />
              ))}
            </div>
          ))
        : null}
    </>
  );
}
