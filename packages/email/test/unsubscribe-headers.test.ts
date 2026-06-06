import { describe, it, expect } from 'vitest';
import {
  buildListUnsubscribeHeaders,
  buildUnsubscribeUrl,
} from '../src/unsubscribe.js';

// §9 step 5 / §10 — RFC 8058 one-click unsubscribe headers. The URL is
// workspace-scoped so unsubscribing from Company A never affects Company B.
const baseUrl = 'https://api.cdp.example/unsubscribe';
const wsA = 'aaaaaaaa-0000-0000-0000-000000000001';
const wsB = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('buildListUnsubscribeHeaders', () => {
  it('emits List-Unsubscribe (angle-bracketed URL) + One-Click post directive', () => {
    const h = buildListUnsubscribeHeaders({
      baseUrl,
      workspaceId: wsA,
      email: 'a@x.com',
    });
    expect(h['List-Unsubscribe']).toMatch(/^<https:\/\/.+>$/);
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('carries the workspace id + email in the URL (workspace-scoped)', () => {
    const url = buildUnsubscribeUrl({ baseUrl, workspaceId: wsA, email: 'a@x.com' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('workspace_id')).toBe(wsA);
    expect(parsed.searchParams.get('email')).toBe('a@x.com');
  });

  it('produces DISTINCT scoped URLs for the same email in different workspaces', () => {
    const a = buildUnsubscribeUrl({ baseUrl, workspaceId: wsA, email: 'same@x.com' });
    const b = buildUnsubscribeUrl({ baseUrl, workspaceId: wsB, email: 'same@x.com' });
    expect(a).not.toBe(b);
    expect(new URL(a).searchParams.get('workspace_id')).toBe(wsA);
    expect(new URL(b).searchParams.get('workspace_id')).toBe(wsB);
  });

  it('url-encodes special characters in the email', () => {
    const url = buildUnsubscribeUrl({
      baseUrl,
      workspaceId: wsA,
      email: 'a+b@x.com',
    });
    expect(url).toContain('a%2Bb%40x.com');
    expect(new URL(url).searchParams.get('email')).toBe('a+b@x.com');
  });

  it('appends an optional token when provided', () => {
    const url = buildUnsubscribeUrl({
      baseUrl,
      workspaceId: wsA,
      email: 'a@x.com',
      token: 'sig123',
    });
    expect(new URL(url).searchParams.get('token')).toBe('sig123');
  });

  it('throws without a workspace id (tenant-isolation guard)', () => {
    expect(() =>
      buildUnsubscribeUrl({ baseUrl, workspaceId: '', email: 'a@x.com' }),
    ).toThrow(/workspaceId/);
  });
});
