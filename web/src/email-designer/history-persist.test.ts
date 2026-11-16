// The designer records every transition (change, undo, redo) for the host to save,
// as a chain of BEFORE-states, and restores saved history on load.
import { describe, it, expect } from 'vitest';
import { loadDesign, mutate, undo, redo, takePendingHistory, restorePendingHistory, undoStack, rows } from './state.js';

const design = { version: 1 as const, settings: {}, rows: [] };

describe('designer history persistence', () => {
  it('records changes, undo and redo as a chain; drains once', () => {
    loadDesign(design, null);
    mutate('Add row', () => (rows.value = [{ id: 'row-1', elements: [] }]));
    undo();
    redo();
    const pending = takePendingHistory();
    expect(pending.map((e) => e.action)).toEqual(['Add row', 'Undo Add row', 'Redo Add row']);
    // each entry's before-state is the state the previous transition produced
    expect(JSON.parse(pending[0]!.snapshot).rows).toEqual([]);
    expect(JSON.parse(pending[1]!.snapshot).rows).toHaveLength(1);
    expect(JSON.parse(pending[2]!.snapshot).rows).toEqual([]);
    expect(takePendingHistory()).toEqual([]);
  });

  it('puts failed entries back first, and loads saved history into undo', () => {
    loadDesign(design, null);
    mutate('A', () => (rows.value = [{ id: 'row-1', elements: [] }]));
    const failed = takePendingHistory();
    mutate('B', () => (rows.value = []));
    restorePendingHistory(failed);
    expect(takePendingHistory().map((e) => e.action)).toEqual(['A', 'B']);

    loadDesign(design, null, [{ action: 'Old', snapshot: JSON.stringify(design), timestamp: 1 }]);
    expect(undoStack.value.map((e) => e.action)).toEqual(['Old']);
    expect(takePendingHistory()).toEqual([]);
  });
});
