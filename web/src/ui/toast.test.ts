import { describe, it, expect } from 'vitest';
import { showToast, currentToasts, runToastAction } from './toast.js';

describe('toast actions', () => {
  it('a toast can carry one action; running it calls it once and closes the toast', () => {
    let calls = 0;
    const id = showToast('Text cleared', { tone: 'info', action: { label: 'Undo', onClick: () => calls++ } });
    expect(currentToasts().find((t) => t.id === id)?.action?.label).toBe('Undo');
    runToastAction(id);
    runToastAction(id);
    expect(calls).toBe(1);
    expect(currentToasts().some((t) => t.id === id)).toBe(false);
  });
});
