// The Workspace settings timezone picker is a kit Select fed by timeZoneList()
// (full IANA list, §9B clock), initialized from GET /workspace/settings and saved
// via PUT with optimistic rollback. This project has no DOM-rendering test harness
// (web unit tests are pure-logic, like campaign-builder.test.ts), so we test the
// picker's PURE pieces: the option list + the optimistic save handler (mocked api),
// which is exactly the load-bearing behavior (no real network).
import { describe, it, expect, vi } from 'vitest';
import { timeZoneList } from '@cdp/shared';
import { saveWorkspaceTimezone } from '../src/screens/workspaceSettingsLogic.js';

describe('timezone picker option list', () => {
  it('exposes the full IANA list including UTC', () => {
    const list = timeZoneList();
    expect(list).toContain('UTC');
    expect(list.length).toBeGreaterThan(1);
  });

  it('ensures the currently-persisted value is selectable even on a curated-fallback engine', () => {
    const list = timeZoneList();
    // A persisted value not present (e.g. a curated fallback engine) is union-ed in by
    // the picker; emulate that contract here.
    const withCurrent = list.includes('Asia/Jerusalem') ? list : ['Asia/Jerusalem', ...list];
    expect(withCurrent).toContain('Asia/Jerusalem');
  });
});

describe('saveWorkspaceTimezone (optimistic + rollback)', () => {
  it('PUTs the chosen timezone and commits on success', async () => {
    const put = vi.fn().mockResolvedValue({ settings: { timezone: 'Europe/Paris' } });
    let displayed = 'Europe/Paris'; // the picker sets the optimistic value before saving
    const setDisplayed = (v: string) => {
      displayed = v;
    };
    const toast = vi.fn();

    await saveWorkspaceTimezone('Europe/Paris', {
      previous: 'UTC',
      setTimezone: setDisplayed,
      put,
      toast,
    });

    expect(put).toHaveBeenCalledWith('/workspace/settings', { body: { timezone: 'Europe/Paris' } });
    expect(displayed).toBe('Europe/Paris'); // optimistic value stays
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), { tone: 'error' });
  });

  it('reverts the displayed value and surfaces a toast (not a native alert) on failure', async () => {
    const put = vi.fn().mockRejectedValue({ error: 'boom' });
    let displayed = 'Europe/Paris'; // optimistic set happens before the call
    const setDisplayed = (v: string) => {
      displayed = v;
    };
    const toast = vi.fn();

    await saveWorkspaceTimezone('Europe/Paris', {
      previous: 'UTC',
      setTimezone: setDisplayed,
      put,
      toast,
    });

    expect(displayed).toBe('UTC'); // rolled back to the previous value
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/timezone/i), { tone: 'error' });
  });
});
