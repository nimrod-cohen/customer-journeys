// The EMBEDDABLE email designer (§11). A pure component: give it a design and an
// onChange — it never fetches or persists. Hosts (the template editor screen, the
// broadcast wizard's design-email flow, future automation editors) own load/save.
// Layout: tabbed left sidebar (Add/Style/Template) + canvas + structure tree.
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import './email-designer.css';
import {
  loadDesign,
  sidebarMode,
  selectedId,
  viewportMode,
  undo,
  redo,
  undoStack,
  redoStack,
} from './state.js';
import { Toolbox } from './Toolbox.tsx';
import { Canvas } from './Canvas.tsx';
import { Properties } from './Properties.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { Navigator } from './Navigator.tsx';
import { History } from './History.tsx';
import { Monitor, Tablet, Smartphone, Undo as UndoIcon, Redo as RedoIcon, Plus, Paintbrush, Settings2, HistoryIcon } from './icons.tsx';
import type { EmailDesign } from './model.js';

export interface EmailDesignerProps {
  /** The design to edit (null/undefined → start empty). */
  readonly design: EmailDesign | null;
  /** Fired after every committed change with the full design document. */
  readonly onChange: (design: EmailDesign) => void;
  /**
   * Identity of the document being edited. When it changes the designer reloads
   * from `design`; in-progress edits for the same key are NOT clobbered by
   * re-renders (the design prop is only read on key change).
   */
  readonly documentKey: string;
}

export function EmailDesigner({ design, onChange, documentKey }: EmailDesignerProps): JSX.Element {
  // (Re)load when the edited document changes. onChange is registered with the
  // loaded document so every committed mutation reaches the host.
  useEffect(() => {
    loadDesign(design, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey]);

  const mode = sidebarMode.value;
  return (
    <div data-testid="email-designer-component" class="nm-designer">
      <div class="nm-designer-toolbar">
        <div class="nm-tabs">
          <button
            type="button"
            data-testid="tab-add"
            class={`nm-tab ${mode === 'toolbox' ? 'nm-active' : ''}`}
            onClick={() => (sidebarMode.value = 'toolbox')}
            title="Add components"
          >
            <Plus size={15} /> Add
          </button>
          <button
            type="button"
            data-testid="tab-style"
            class={`nm-tab ${mode === 'properties' ? 'nm-active' : ''}`}
            onClick={() => (sidebarMode.value = 'properties')}
            disabled={!selectedId.value && mode !== 'properties'}
            title="Style the selected element"
          >
            <Paintbrush size={15} /> Style
          </button>
          <button
            type="button"
            data-testid="tab-template"
            class={`nm-tab ${mode === 'settings' ? 'nm-active' : ''}`}
            onClick={() => (sidebarMode.value = 'settings')}
            title="Template settings"
          >
            <Settings2 size={15} /> Template
          </button>
          <button
            type="button"
            data-testid="tab-history"
            class={`nm-tab ${mode === 'history' ? 'nm-active' : ''}`}
            onClick={() => (sidebarMode.value = 'history')}
            title="Change history"
          >
            <HistoryIcon size={15} /> History
          </button>
        </div>
        <div class="nm-toolbar-actions">
          {/* Viewport preview: resize the canvas frame; mobile stacks columns. */}
          <div class="nm-vp-group">
            {(['desktop', 'tablet', 'mobile'] as const).map((vp) => (
              <button
                key={vp}
                type="button"
                data-testid={`viewport-${vp}`}
                class={`nm-mini-btn ${viewportMode.value === vp ? 'nm-active' : ''}`}
                title={`Preview on ${vp}`}
                onClick={() => (viewportMode.value = vp)}
              >
                {vp === 'desktop' ? <Monitor size={15} /> : vp === 'tablet' ? <Tablet size={15} /> : <Smartphone size={15} />}
              </button>
            ))}
          </div>
          <button type="button" data-testid="designer-undo" class="nm-mini-btn" title="Undo" disabled={undoStack.value.length === 0} onClick={undo}>
            <UndoIcon size={15} />
          </button>
          <button type="button" data-testid="designer-redo" class="nm-mini-btn" title="Redo" disabled={redoStack.value.length === 0} onClick={redo}>
            <RedoIcon size={15} />
          </button>
        </div>
      </div>
      <div class="nm-designer-body">
        <aside class="nm-sidebar">
          {mode === 'settings' ? <SettingsPanel /> : mode === 'properties' ? <Properties /> : mode === 'history' ? <History /> : <Toolbox />}
        </aside>
        <Canvas />
        <Navigator />
      </div>
    </div>
  );
}
