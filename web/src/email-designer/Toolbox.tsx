// The component toolbox (port of nomentor's Toolbox.jsx, narrowed to the email
// element set). Items are HTML5-draggable onto the canvas AND clickable
// (click-to-add into the selected row/cell, else a new row) so the designer is
// fully usable — and e2e-testable — without drag-and-drop.
import type { JSX } from 'preact';
import { clickToAdd, dragging } from './state.js';
import type { DesignElement } from './model.js';

interface ToolboxItem {
  readonly type: DesignElement['type'];
  readonly label: string;
  readonly icon: JSX.Element;
}

const I = ({ d }: { d: string }): JSX.Element => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d={d} />
  </svg>
);

const ITEMS: readonly ToolboxItem[] = [
  { type: 'heading', label: 'Heading', icon: <I d="M6 4v16M18 4v16M6 12h12" /> },
  { type: 'text', label: 'Text', icon: <I d="M4 6h16M4 12h16M4 18h10" /> },
  { type: 'image', label: 'Image', icon: <I d="M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6" /> },
  { type: 'button', label: 'Button', icon: <I d="M4 9h16v6H4zM9 12h6" /> },
  { type: 'list', label: 'List', icon: <I d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /> },
  { type: 'separator', label: 'Separator', icon: <I d="M4 12h16M8 7l4-3 4 3M8 17l4 3 4-3" /> },
  { type: 'grid', label: 'Columns', icon: <I d="M4 5h16v14H4zM12 5v14" /> },
];

export function Toolbox(): JSX.Element {
  return (
    <div data-testid="designer-toolbox" class="nm-toolbox">
      <div class="nm-panel-title">Components</div>
      <div class="nm-toolbox-grid">
        {ITEMS.map((item) => (
          <button
            key={item.type}
            type="button"
            data-testid={`toolbox-${item.type}`}
            class="nm-toolbox-item"
            draggable
            onDragStart={(e) => {
              dragging.value = { type: item.type };
              e.dataTransfer!.effectAllowed = 'copy';
              e.dataTransfer!.setData('text/plain', item.type);
            }}
            onDragEnd={() => {
              dragging.value = null;
            }}
            onClick={() => clickToAdd(item.type)}
            title={`Add ${item.label}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <p class="nm-toolbox-hint">Drag onto the canvas, or click to add to the selected row.</p>
    </div>
  );
}
