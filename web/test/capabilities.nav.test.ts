// buildNav is capability-driven via the §3A matrix (`can()`), proving the UI
// shows only what each role permits (§12). This is UX; the server still enforces
// every route — but the nav must hide what a role can't reach.
import { describe, it, expect } from 'vitest';
import { buildNav } from '../src/nav/nav.js';

describe('capability-driven nav (buildNav via can())', () => {
  it('marketer sees content nav but NOT billing/settings/admin', () => {
    const ids = buildNav('marketer').map((n) => n.id);
    expect(ids).toContain('segments');
    expect(ids).toContain('campaigns');
    expect(ids).not.toContain('billing');
    expect(ids).not.toContain('settings'); // settings (with the sending-domains tab) is owner-only
    expect(ids).not.toContain('admin');
  });

  it('accounting sees billing only (no content/settings/admin)', () => {
    const ids = buildNav('accounting').map((n) => n.id);
    expect(ids).toContain('billing');
    expect(ids).not.toContain('segments');
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('admin');
  });

  it('owner sees content + billing + settings (sending domains live in a settings tab; no admin console)', () => {
    const ids = buildNav('owner').map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['segments', 'billing', 'settings']));
    expect(ids).not.toContain('onboarding'); // folded into Workspace settings → Sending domains tab
    expect(ids).not.toContain('admin');
  });

  it('system-admin sees everything including the cross-company console', () => {
    const ids = buildNav('system-admin').map((n) => n.id);
    expect(ids).toContain('admin');
    expect(ids).toContain('billing');
    expect(ids).toContain('settings');
  });

  it('logged out (null role) yields an empty nav', () => {
    expect(buildNav(null)).toEqual([]);
  });
});
