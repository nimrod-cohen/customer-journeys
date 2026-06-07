// §10 — the owner-triggered upgrade orchestrator provisions SES FIRST, then
// writes the ip_mode DB transition. A provisioning FAILURE must leave the
// workspace on the shared pool (no DB write). SES is a fake here (mocked
// boundary); the tx runner is captured to assert ordering. Pure-ish: no real PG.
import { describe, it, expect, vi } from 'vitest';
import type { SesEmailClient } from '@cdp/email';
import { upgradeIp, type MeteringDeps } from '../src/core.js';

function fakeSes(overrides: Partial<SesEmailClient> = {}): SesEmailClient {
  return {
    createDomainIdentity: vi.fn(),
    getIdentityVerificationAttributes: vi.fn(),
    createConfigurationSet: vi.fn(),
    sendEmail: vi.fn(),
    provisionDedicatedIp: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SesEmailClient;
}

const ws = '55555555-5555-5555-5555-555555555555';

describe('upgradeIp orchestrator (SES-first)', () => {
  it('provisions SES BEFORE writing the DB transition', async () => {
    const order: string[] = [];
    const ses = fakeSes({
      provisionDedicatedIp: vi.fn(async () => {
        order.push('ses');
      }),
    });
    const deps: MeteringDeps = {
      reader: { query: vi.fn() },
      runInWorkspaceTx: vi.fn(async (wsId, statements) => {
        order.push('db');
        expect(wsId).toBe(ws);
        // The transition sets ip_mode warming (merged jsonb at $2).
        const patch = JSON.parse(statements[0]!.values[1] as string) as Record<string, unknown>;
        expect(patch.ip_mode).toBe('warming');
      }),
    };
    await upgradeIp(deps, ses, ws, 'cdp-pool-ws55', new Date('2026-06-01T00:00:00Z'));
    expect(order).toEqual(['ses', 'db']);
  });

  it('leaves ip_mode shared (NO DB write) when SES provisioning fails', async () => {
    const ses = fakeSes({
      provisionDedicatedIp: vi.fn(async () => {
        throw new Error('SES quota exceeded');
      }),
    });
    const runInWorkspaceTx = vi.fn();
    const deps: MeteringDeps = { reader: { query: vi.fn() }, runInWorkspaceTx };
    await expect(
      upgradeIp(deps, ses, ws, 'cdp-pool-ws55', new Date()),
    ).rejects.toThrow(/quota/);
    expect(runInWorkspaceTx).not.toHaveBeenCalled();
  });
});
