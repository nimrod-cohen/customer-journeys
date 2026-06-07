import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SESv2Client, CreateDedicatedIpPoolCommand } from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient } from '../src/ses-client.js';

// §10 — the dedicated-IP upgrade orchestrator provisions an SES dedicated IP
// pool BEFORE writing the DB transition. The prod wrapper's provisionDedicatedIp
// is unit-tested with aws-sdk-client-mock; SES is NEVER really called. A
// provisioning failure must propagate so the orchestrator leaves ip_mode shared.
const ses = mockClient(SESv2Client);

describe('ProdSesEmailClient.provisionDedicatedIp', () => {
  beforeEach(() => ses.reset());

  it('creates a STANDARD dedicated IP pool with the given name', async () => {
    ses.on(CreateDedicatedIpPoolCommand).resolves({});
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    await client.provisionDedicatedIp('cdp-pool-ws1');

    const calls = ses.commandCalls(CreateDedicatedIpPoolCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.PoolName).toBe('cdp-pool-ws1');
    expect(calls[0]!.args[0].input.ScalingMode).toBe('STANDARD');
  });

  it('propagates a provisioning failure (so the upgrade leaves ip_mode shared)', async () => {
    ses.on(CreateDedicatedIpPoolCommand).rejects(new Error('SES quota exceeded'));
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    await expect(client.provisionDedicatedIp('cdp-pool-ws1')).rejects.toThrow(/quota/);
  });
});
