// Change-history panel (port of nomentor's History.jsx, narrowed — no pinning).
// Lists this session's committed changes newest-first; clicking an entry
// PREVIEWS the document as it was right after that change (read-only peek, the
// live state is kept aside); "Restore" commits it back as a regular, undoable
// change. The newest entry is the current document.
import type { JSX } from 'preact';
import { undoStack, previewIndex, previewVersion, exitPreview, revertToVersion } from './state.js';
import { Clock, Undo } from './icons.tsx';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function History(): JSX.Element {
  const entries = undoStack.value;
  const previewing = previewIndex.value;
  const count = entries.length;

  return (
    <div data-testid="designer-history" class="nm-props">
      <div class="nm-panel-title nm-history-header">
        <span>
          History <span class="nm-history-count">{count}/100</span>
        </span>
        {previewing !== null ? (
          <button type="button" data-testid="history-exit-preview" class="nm-mini-btn" onClick={exitPreview}>
            Back to live
          </button>
        ) : null}
      </div>
      {count === 0 ? (
        <p class="nm-props-empty">No changes yet.</p>
      ) : (
        <ul class="nm-history-list">
          {[...entries].reverse().map((entry, ri) => {
            const i = count - 1 - ri;
            const isCurrent = i === count - 1 && previewing === null;
            const isActive = previewing === i;
            return (
              <li
                key={`${entry.timestamp}-${i}`}
                data-testid="history-item"
                class={`nm-history-item ${isActive ? 'nm-active' : ''} ${isCurrent ? 'nm-current' : ''}`}
              >
                <button
                  type="button"
                  class="nm-history-row"
                  onClick={() => (i === count - 1 ? exitPreview() : previewVersion(i))}
                  title="Click to preview this version"
                >
                  <span class="nm-history-time">
                    <Clock size={11} /> {formatTime(entry.timestamp)}
                  </span>
                  <span class="nm-history-action">{entry.action || `Version ${i + 1}`}</span>
                  {i === count - 1 ? <span class="nm-history-badge">current</span> : null}
                </button>
                {isActive && i !== count - 1 ? (
                  <button
                    type="button"
                    data-testid="history-restore"
                    class="nm-mini-btn"
                    title="Restore this version"
                    onClick={() => revertToVersion(i)}
                  >
                    <Undo size={12} /> Restore
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
