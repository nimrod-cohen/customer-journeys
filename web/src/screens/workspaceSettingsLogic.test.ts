// Pure save logic for the Workspace settings pickers (timezone + front-facing
// language): optimistic value already set by the caller; PUT, and on failure roll
// back + toast (never a native dialog).
import { describe, it, expect, vi } from 'vitest';
import { saveWorkspaceTimezone, saveWorkspaceLanguage, type FrontFacingLanguage } from './workspaceSettingsLogic.js';

describe('saveWorkspaceTimezone', () => {
  it('PUTs the timezone (no rollback/toast on success)', async () => {
    const put = vi.fn().mockResolvedValue({});
    const setTimezone = vi.fn();
    const toast = vi.fn();
    await saveWorkspaceTimezone('Asia/Tokyo', { previous: 'UTC', setTimezone, put, toast });
    expect(put).toHaveBeenCalledWith('/workspace/settings', { body: { timezone: 'Asia/Tokyo' } });
    expect(setTimezone).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('rolls back + toasts on failure', async () => {
    const put = vi.fn().mockRejectedValue(new Error('nope'));
    const setTimezone = vi.fn();
    const toast = vi.fn();
    await saveWorkspaceTimezone('Asia/Tokyo', { previous: 'UTC', setTimezone, put, toast });
    expect(setTimezone).toHaveBeenCalledWith('UTC');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('timezone'), { tone: 'error' });
  });
});

describe('saveWorkspaceLanguage', () => {
  it('PUTs front_facing_language (no rollback/toast on success)', async () => {
    const put = vi.fn().mockResolvedValue({});
    const setLanguage = vi.fn();
    const toast = vi.fn();
    await saveWorkspaceLanguage('he', { previous: 'auto', setLanguage, put, toast });
    expect(put).toHaveBeenCalledWith('/workspace/settings', { body: { front_facing_language: 'he' } });
    expect(setLanguage).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('rolls back to the previous language + toasts on failure', async () => {
    const put = vi.fn().mockRejectedValue(new Error('nope'));
    const setLanguage = vi.fn();
    const toast = vi.fn();
    const previous: FrontFacingLanguage = 'en';
    await saveWorkspaceLanguage('he', { previous, setLanguage, put, toast });
    expect(setLanguage).toHaveBeenCalledWith('en');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('language'), { tone: 'error' });
  });
});
