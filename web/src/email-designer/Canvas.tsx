// The designer canvas (port of nomentor's Canvas.jsx, narrowed). Renders the
// email approximation: a centered body of settings.bodyWidth on the page
// background, rows as drop targets, HTML5 drag-and-drop from the toolbox plus
// Delete-key removal. Direction (RTL) applies to the whole canvas body.
import { useEffect, useRef, useCallback } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  rows,
  settings,
  selectedId,
  selectNode,
  dragging,
  dropTargetId,
  dropOnCanvas,
  dropOnRow,
  removeRow,
  removeElement,
  findRow,
  mutate,
} from './state.js';
import { borderCss, paddingCss, radiusCss, type Style } from './canvas-styles.js';
import { ElementRenderer } from './elements.tsx';
import type { DesignRow } from './model.js';

export function Canvas(): JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null);

  const getDropBeforeId = useCallback((y: number): string | null => {
    const rowEls = pageRef.current?.querySelectorAll('.nm-canvas-row');
    if (!rowEls) return null;
    for (const el of rowEls) {
      const rect = el.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return (el as HTMLElement).dataset.rowId ?? null;
    }
    return null;
  }, []);

  // Delete key removes the selected node (row or element).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.isContentEditable || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
      const sel = selectedId.value;
      if (!sel) return;
      if (findRow(sel)) {
        mutate('Remove row', () => removeRow(sel));
      } else {
        mutate('Remove element', () => removeElement(sel));
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const st = settings.value;
  const bodyStyle: Style = {
    width: `${st.bodyWidth ?? 600}px`,
    maxWidth: '100%',
    margin: '0 auto',
    backgroundColor: '#ffffff',
  };
  if (st.fontFamily) bodyStyle.fontFamily = `${st.fontFamily}, Helvetica, Arial, sans-serif`;
  if (st.baseFontSize) bodyStyle.fontSize = `${st.baseFontSize}px`;

  return (
    <main
      data-testid="designer-canvas"
      class="nm-canvas"
      style={st.bgColor ? { backgroundColor: st.bgColor } : undefined}
      onClick={() => selectNode(null)}
    >
      <div
        ref={pageRef}
        class={`nm-canvas-page ${dragging.value ? 'nm-drag-active' : ''}`}
        dir={st.direction === 'rtl' ? 'rtl' : 'ltr'}
        style={bodyStyle}
        onDragOver={(e) => {
          if (!dragging.value) return;
          e.preventDefault();
          dropTargetId.value = getDropBeforeId(e.clientY);
        }}
        onDrop={(e) => {
          if (!dragging.value) return;
          e.preventDefault();
          dropOnCanvas(dragging.value.type, dropTargetId.value);
          dragging.value = null;
          dropTargetId.value = null;
        }}
      >
        {rows.value.length === 0 ? (
          <div data-testid="canvas-empty" class="nm-canvas-empty">
            Drag components here — or click one in the toolbox — to start designing
          </div>
        ) : null}
        {rows.value.map((row) => (
          <CanvasRow key={row.id} row={row} />
        ))}
      </div>
    </main>
  );
}

function CanvasRow({ row }: { row: DesignRow }): JSX.Element {
  const isSelected = selectedId.value === row.id;
  const isDropTarget = dropTargetId.value === row.id;
  const p = row.props ?? {};
  const s: Style = { padding: paddingCss(p.padding, '0') };
  if (p.bgColor) s.backgroundColor = p.bgColor;
  const b = borderCss(p.border);
  if (b) s.border = b;
  const r = radiusCss(p.radius);
  if (r) s.borderRadius = r;

  return (
    <>
      {isDropTarget ? <div class="nm-drop-indicator" /> : null}
      <div
        data-testid="canvas-row"
        data-row-id={row.id}
        class={`nm-canvas-row ${isSelected ? 'nm-selected' : ''}`}
        style={s}
        onClick={(e) => {
          e.stopPropagation();
          selectNode(row.id);
        }}
        onDragOver={(e) => {
          if (!dragging.value) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          if (!dragging.value) return;
          e.preventDefault();
          e.stopPropagation();
          dropOnRow(dragging.value.type, row.id);
          dragging.value = null;
          dropTargetId.value = null;
        }}
      >
        <div class="nm-row-label">row</div>
        {row.elements.length === 0 ? <div class="nm-row-empty">Empty row — drop a component here</div> : null}
        {row.elements.map((el) => (
          <ElementRenderer key={el.id} element={el} />
        ))}
      </div>
    </>
  );
}
