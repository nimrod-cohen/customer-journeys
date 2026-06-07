// §10 / §18 "IP strategy" — the upgrade-ip flow transitions ip_mode shared →
// warming → dedicated and tracks warmup_status, all inside sending_identity
// (merged, so DKIM/verified/config_set survive). Proven against REAL Postgres
// via the production write path. SES is mocked at the boundary (upgradeIp).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { vi } from 'vitest';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient } from '@cdp/email';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import {
  planCompleteUpgrade,
  upgradeIp,
  warmupSplit,
  type MeteringDeps,
  type WarmupStatus,
} from '../src/index.js';

const RUN = hasDatabaseUrl();
const WS = 'fe730000-0000-4000-8000-0000000000d1';

function fakeSes(provision: () => Promise<void>): SesEmailClient {
  return {
    createDomainIdentity: vi.fn(),
    getIdentityVerificationAttributes: vi.fn(),
    createConfigurationSet: vi.fn(),
    sendEmail: vi.fn(),
    provisionDedicatedIp: vi.fn(provision),
  } as unknown as SesEmailClient;
}

describe.skipIf(!RUN)('metering ip_mode warmup transitions (real Postgres)', () => {
  let admin: Pool;

  function deps(): MeteringDeps {
    return {
      reader: { query: (text, values) => admin.query(text, values) },
      runInWorkspaceTx: (wsId, statements) => runStatementsInWorkspaceTx(admin, wsId, statements),
    };
  }

  async function sendingIdentity(): Promise<Record<string, unknown>> {
    const r = await admin.query('SELECT sending_identity FROM workspaces WHERE id = $1', [WS]);
    return r.rows[0].sending_identity as Record<string, unknown>;
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    // Seed an active, verified workspace on the shared pool with existing keys.
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
      [WS, JSON.stringify({ ip_mode: 'shared', verified: true, config_set: 'ws-cfg', from_domain: 'mail.acme.com' })],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    await admin.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('upgradeIp (SES ok) transitions shared → warming and preserves existing keys', async () => {
    const start = new Date('2026-06-01T00:00:00.000Z');
    await upgradeIp(deps(), fakeSes(async () => undefined), WS, 'cdp-pool-ws73', start);
    const si = await sendingIdentity();
    expect(si.ip_mode).toBe('warming');
    expect(si.ip_pool).toBe('cdp-pool-ws73');
    expect((si.warmup_status as WarmupStatus).startedAt).toBe(start.toISOString());
    // Existing keys survived the jsonb merge.
    expect(si.verified).toBe(true);
    expect(si.config_set).toBe('ws-cfg');
    expect(si.from_domain).toBe('mail.acme.com');

    // The warm-up split is computable from the persisted status.
    const ws73 = si.warmup_status as WarmupStatus;
    expect(warmupSplit(ws73, start)).toBeGreaterThan(0);
    expect(warmupSplit(ws73, new Date(Date.parse(ws73.startedAt) + ws73.durationDays * 86_400_000))).toBe(1);
  });

  it('a SES provisioning failure leaves ip_mode unchanged (no transition)', async () => {
    // Reset to shared first.
    await admin.query(
      "UPDATE workspaces SET sending_identity = sending_identity || '{\"ip_mode\":\"shared\"}'::jsonb WHERE id = $1",
      [WS],
    );
    await expect(
      upgradeIp(
        deps(),
        fakeSes(async () => {
          throw new Error('SES quota exceeded');
        }),
        WS,
        'cdp-pool-ws73',
        new Date(),
      ),
    ).rejects.toThrow(/quota/);
    const si = await sendingIdentity();
    expect(si.ip_mode).toBe('shared');
  });

  it('planCompleteUpgrade cuts warming → dedicated', async () => {
    // Put it into warming first.
    await upgradeIp(deps(), fakeSes(async () => undefined), WS, 'cdp-pool-ws73', new Date('2026-06-01T00:00:00Z'));
    await runStatementsInWorkspaceTx(admin, WS, [planCompleteUpgrade(WS)]);
    const si = await sendingIdentity();
    expect(si.ip_mode).toBe('dedicated');
  });
});
