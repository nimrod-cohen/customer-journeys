// The EMBEDDABLE email designer (§11). A pure component: give it a design and an
// onChange — it never fetches or persists. Hosts (the template editor screen, the
// broadcast wizard's design-email flow, future campaign editors) own load/save.
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
          >
            Add
          </button>
          <button
            type="button"
            data-testid="tab-style"
            class={`nm-tab ${mode === 'properties' ? 'nm-active' : ''}`}
            onClick={() => (sidebarMode.value = 'properties')}
            disabled={!selectedId.value && mode !== 'properties'}
          >
            Style
          </button>
          <button
            type="button"
            data-testid="tab-template"
            class={`nm-tab ${mode === 'settings' ? 'nm-active' : ''}`}
            onClick={() => (sidebarMode.value = 'settings')}
          >
            Template
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
                {vp === 'desktop' ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="4" width="20" height="13" rx="1.5" /><path d="M9 21h6M12 17v4" /></svg>
                ) : vp === 'tablet' ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M11 18.5h2" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7.5" y="2" width="9" height="20" rx="2" /><path d="M11 18.5h2" /></svg>
                )}
              </button>
            ))}
          </div>
          <button type="button" data-testid="designer-undo" class="nm-mini-btn" title="Undo" disabled={undoStack.value.length === 0} onClick={undo}>
            ↶
          </button>
          <button type="button" data-testid="designer-redo" class="nm-mini-btn" title="Redo" disabled={redoStack.value.length === 0} onClick={redo}>
            ↷
          </button>
        </div>
      </div>
      <div class="nm-designer-body">
        <aside class="nm-sidebar">
          {mode === 'settings' ? <SettingsPanel /> : mode === 'properties' ? <Properties /> : <Toolbox />}
        </aside>
        <Canvas />
        <Navigator />
      </div>
    </div>
  );
}
