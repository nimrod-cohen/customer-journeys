import { describe, it, expect } from 'vitest';
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  buildUnsubscribeEvent,
} from '../src/core.js';

// §10 one-click unsubscribe. parseUnsubscribeRequest extracts workspace_id +
// email from the WORKSPACE-SCOPED link (query string) and honors RFC 8058:
// a POST with body `List-Unsubscribe=One-Click` is the one-click confirmation.
// buildUnsubscribeSuppression writes a per-workspace suppression
// (reason='unsubscribe', ON CONFLICT DO NOTHING).

describe('parseUnsubscribeRequest', () => {
  it('parses workspace_id + email from the link query string', () => {
    const r = parseUnsubscribeRequest('GET', '/unsubscribe?workspace_id=ws-1&email=a%40b.com', null);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.workspaceId).toBe('ws-1');
      expect(r.email).toBe('a@b.com');
      expect(r.oneClick).toBe(false);
    }
  });

  it('lowercases the email', () => {
    const r = parseUnsubscribeRequest('GET', '/unsubscribe?workspace_id=ws-1&email=A%40B.com', null);
    expect(r.valid && r.email).toBe('a@b.com');
  });

  it('honors the RFC 8058 One-Click POST body', () => {
    const r = parseUnsubscribeRequest(
      'POST',
      'https://api.cdp.example/unsubscribe?workspace_id=ws-7&email=x%40y.com',
      'List-Unsubscribe=One-Click',
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.oneClick).toBe(true);
      expect(r.workspaceId).toBe('ws-7');
      expect(r.email).toBe('x@y.com');
    }
  });

  it('rejects a request missing workspace_id', () => {
    const r = parseUnsubscribeRequest('GET', '/unsubscribe?email=a%40b.com', null);
    expect(r.valid).toBe(false);
  });

  it('rejects a request missing email', () => {
    const r = parseUnsubscribeRequest('GET', '/unsubscribe?workspace_id=ws-1', null);
    expect(r.valid).toBe(false);
  });

  it('accepts a full absolute URL', () => {
    const r = parseUnsubscribeRequest('GET', 'https://api.cdp.example/unsubscribe?workspace_id=ws-9&email=z%40q.com', null);
    expect(r.valid && r.workspaceId).toBe('ws-9');
  });

  it('extracts optional broadcast_id / campaign_id for attribution', () => {
    const r = parseUnsubscribeRequest(
      'POST',
      '/unsubscribe?workspace_id=ws-1&email=a%40b.com&broadcast_id=bc1',
      'List-Unsubscribe=One-Click',
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.broadcastId).toBe('bc1');
      expect(r.campaignId).toBeNull();
    }
  });

  it('leaves broadcastId / campaignId null when absent', () => {
    const r = parseUnsubscribeRequest('GET', '/unsubscribe?workspace_id=ws-1&email=a%40b.com', null);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.broadcastId).toBeNull();
      expect(r.campaignId).toBeNull();
      expect(r.compactVerified).toBe(false);
    }
  });

  // ── NEW: the compact self-contained `?t=` token path ─────────────────────
  const unpacker = (decoded: { workspaceId: string; email: string } | null) => () => decoded;

  it('resolves identity from the compact `t` token (VERBATIM email, compactVerified)', () => {
    const r = parseUnsubscribeRequest(
      'GET',
      '/manage-subscription?t=OPAQUE',
      null,
      unpacker({ workspaceId: 'ws-XYZ', email: 'Mixed.Case@Example.com' }),
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.workspaceId).toBe('ws-XYZ');
      expect(r.email).toBe('Mixed.Case@Example.com'); // verbatim, not lowercased
      expect(r.compactVerified).toBe(true);
      expect(r.token).toBeNull();
    }
  });

  it('rejects an invalid/undecodable `t` token (no fallback to query fields)', () => {
    const r = parseUnsubscribeRequest('GET', '/manage-subscription?t=BAD', null, unpacker(null));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/token/i);
  });

  it('parses attribution via the short b/c params alongside `t`', () => {
    const r = parseUnsubscribeRequest(
      'POST',
      '/unsubscribe?t=OPAQUE&b=bc1&c=cm2',
      'List-Unsubscribe=One-Click',
      unpacker({ workspaceId: 'ws-1', email: 'a@b.com' }),
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.oneClick).toBe(true);
      expect(r.broadcastId).toBe('bc1');
      expect(r.campaignId).toBe('cm2');
    }
  });

  it('still accepts legacy broadcast_id / campaign_id when no b/c', () => {
    const r = parseUnsubscribeRequest('GET', '/unsubscribe?workspace_id=ws-1&email=a%40b.com&campaign_id=cmL', null);
    expect(r.valid && r.campaignId).toBe('cmL');
  });
});

describe('buildUnsubscribeEvent', () => {
  it("inserts an email_events row type='unsubscribe' attributed to the broadcast + profile, workspace-scoped", () => {
    const s = buildUnsubscribeEvent('ws-1', 'a@b.com', 'bc1', null);
    expect(s.text).toMatch(/INSERT INTO email_events/i);
    expect(s.text).toContain("'unsubscribe'");
    expect(s.values[0]).toBe('ws-1'); // workspace_id bound at $1
    expect(s.values).toContain('bc1');
    // workspace id is a bound param, never interpolated.
    expect(s.text).not.toContain('ws-1');
  });

  it('omits the row entirely when there is no source broadcast/campaign (returns null)', () => {
    expect(buildUnsubscribeEvent('ws-1', 'a@b.com', null, null)).toBeNull();
  });

  it('throws on a falsy workspaceId (tenant-isolation guard)', () => {
    expect(() => buildUnsubscribeEvent('', 'a@b.com', 'bc1', null)).toThrow(/workspace/i);
  });
});

describe('buildUnsubscribeSuppression', () => {
  it("inserts a per-workspace suppression (reason='unsubscribe') ON CONFLICT DO NOTHING", () => {
    const s = buildUnsubscribeSuppression('ws-1', 'a@b.com');
    expect(s.text).toMatch(/INSERT INTO suppressions/i);
    expect(s.text).toMatch(/ON CONFLICT \(workspace_id, email\) DO NOTHING/i);
    expect(s.values[0]).toBe('ws-1');
    expect(s.values).toContain('a@b.com');
    expect(s.values).toContain('unsubscribe');
  });

  it('throws on a falsy workspaceId (tenant-isolation guard)', () => {
    expect(() => buildUnsubscribeSuppression('', 'a@b.com')).toThrow(/workspace/i);
  });
});

describe('buildUnsubscribedAttribute', () => {
  it('sets the profile attribute unsubscribed=true, workspace-scoped', () => {
    const s = buildUnsubscribedAttribute('ws-1', 'a@b.com');
    expect(s.text).toMatch(/UPDATE profiles/i);
    expect(s.text).toContain('"unsubscribed": true');
    expect(s.text).toMatch(/WHERE workspace_id = \$1 AND email = \$2/i);
    expect(s.values).toEqual(['ws-1', 'a@b.com']);
    // workspace id is a bound param, never interpolated.
    expect(s.text).not.toContain('ws-1');
  });

  it('throws on a falsy workspaceId (tenant-isolation guard)', () => {
    expect(() => buildUnsubscribedAttribute('', 'a@b.com')).toThrow(/workspace/i);
  });
});
