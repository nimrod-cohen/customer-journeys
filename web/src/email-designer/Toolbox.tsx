// The component toolbox (port of nomentor's Toolbox.jsx, narrowed to the email
// element set). Items are HTML5-draggable onto the canvas AND clickable
// (click-to-add into the selected row/cell, else a new row) so the designer is
// fully usable — and e2e-testable — without drag-and-drop.
import type { JSX } from 'preact';
import { clickToAdd, dragging } from './state.js';
import { AlignLeft, Grid, Heading, Image, List, MousePointerClick, UnfoldVertical } from './icons.tsx';
import type { DesignElement } from './model.js';

interface ToolboxItem {
  readonly type: DesignElement['type'];
  readonly label: string;
  readonly icon: JSX.Element;
}

const ITEMS: readonly ToolboxItem[] = [
  { type: 'grid', label: 'Columns', icon: <Grid /> },
  { type: 'heading', label: 'Heading', icon: <Heading /> },
  { type: 'text', label: 'Text', icon: <AlignLeft /> },
  { type: 'image', label: 'Image', icon: <Image /> },
  { type: 'button', label: 'Button', icon: <MousePointerClick /> },
  { type: 'list', label: 'List', icon: <List /> },
  { type: 'separator', label: 'Separator', icon: <UnfoldVertical /> },
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
