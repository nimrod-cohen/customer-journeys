import { describe, it, expect, vi } from 'vitest';
import { startDomain, type StartDomainDeps } from '../src/start-domain.js';
import type { SesEmailClient } from '@cdp/email';
import type { SqlStatement } from '../src/core.js';

// §10A step 1 — start-domain wiring: creates the SES identity (Easy DKIM),
// builds the record set, and persists the in-progress sending_identity via the
// injected workspace-scoped tx runner. SES is a fake; no real calls.
const ws = '11111111-0000-0000-0000-000000000001';

function fakeSes(tokens: string[]): SesEmailClient {
  return {
    createDomainIdentity: vi.fn(async (domain: string) => ({
      identity: domain,
      dkimTokens: tokens,
    })),
    getIdentityVerificationAttributes: vi.fn(),
    createConfigurationSet: vi.fn(),
  } as unknown as SesEmailClient;
}

describe('startDomain', () => {
  it('creates the SES identity, returns records, and persists scoped identity', async () => {
    const ses = fakeSes(['a', 'b', 'c']);
    const captured: { ws?: string; statements?: readonly SqlStatement[] } = {};
    const deps: StartDomainDeps = {
      ses,
      region: 'us-east-1',
      runInWorkspaceTx: async (workspaceId, statements) => {
        captured.ws = workspaceId;
        captured.statements = statements;
      },
    };

    const out = await startDomain(deps, { workspaceId: ws, fromDomain: 'mail.acme.com' });

    expect(ses.createDomainIdentity).toHaveBeenCalledWith('mail.acme.com');
    expect(out.records.records.filter((r) => r.role === 'dkim')).toHaveLength(3);

    // Persisted via the workspace-scoped tx runner, workspace bound at $1.
    expect(captured.ws).toBe(ws);
    expect(captured.statements).toHaveLength(1);
    const stmt = captured.statements![0]!;
    expect(stmt.values[0]).toBe(ws);
    expect(stmt.text).toMatch(/UPDATE workspaces/i);
    expect(stmt.text).toMatch(/WHERE id = \$1/);
    const patch = JSON.parse(String(stmt.values[1]));
    expect(patch.from_domain).toBe('mail.acme.com');
    expect(patch.dkim_tokens).toEqual(['a', 'b', 'c']);
    expect(patch.verified).toBe(false);
    expect(patch.ip_mode).toBe('shared');
  });

  it('defaults the MAIL FROM subdomain to mail.<fromDomain>', async () => {
    const ses = fakeSes(['a', 'b', 'c']);
    const deps: StartDomainDeps = {
      ses,
      region: 'us-east-1',
      runInWorkspaceTx: async () => {},
    };
    const out = await startDomain(deps, { workspaceId: ws, fromDomain: 'acme.com' });
    expect(out.records.mailFromSubdomain).toBe('mail.acme.com');
  });

  it('throws without workspace id / fromDomain (guards)', async () => {
    const deps: StartDomainDeps = {
      ses: fakeSes([]),
      region: 'us-east-1',
      runInWorkspaceTx: async () => {},
    };
    await expect(startDomain(deps, { workspaceId: '', fromDomain: 'x.com' })).rejects.toThrow(
      /workspaceId/,
    );
    await expect(startDomain(deps, { workspaceId: ws, fromDomain: '' })).rejects.toThrow(
      /fromDomain/,
    );
  });
});
