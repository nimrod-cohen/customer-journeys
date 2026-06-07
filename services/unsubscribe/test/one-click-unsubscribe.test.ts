import { describe, it, expect } from 'vitest';
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
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
