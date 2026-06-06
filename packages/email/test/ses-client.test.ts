import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  CreateConfigurationSetCommand,
} from '@aws-sdk/client-sesv2';
import { ProdSesEmailClient } from '../src/ses-client.js';

// §10/§10A — the prod SES wrapper is unit-tested with aws-sdk-client-mock; SES
// is NEVER really called. Asserts the exact commands/inputs and the mapping
// from SDK responses to our domain shapes.
const ses = mockClient(SESv2Client);

describe('ProdSesEmailClient', () => {
  beforeEach(() => ses.reset());

  it('createDomainIdentity requests Easy DKIM and returns the tokens', async () => {
    ses.on(CreateEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'PENDING', Tokens: ['t1', 't2', 't3'] },
    });
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    const res = await client.createDomainIdentity('mail.acme.com');
    expect(res.identity).toBe('mail.acme.com');
    expect(res.dkimTokens).toEqual(['t1', 't2', 't3']);

    const calls = ses.commandCalls(CreateEmailIdentityCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.EmailIdentity).toBe('mail.acme.com');
    // Easy DKIM (SES-managed keys), NOT BYODKIM.
    expect(calls[0]!.args[0].input.DkimSigningAttributes?.NextSigningKeyLength).toBe(
      'RSA_2048_BIT',
    );
  });

  it('getIdentityVerificationAttributes reads DKIM status (the gate)', async () => {
    ses.on(GetEmailIdentityCommand).resolves({
      DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true, Tokens: ['t1'] },
    });
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    const attrs = await client.getIdentityVerificationAttributes('mail.acme.com');
    expect(attrs.dkimStatus).toBe('SUCCESS');
    expect(attrs.signingEnabled).toBe(true);
    expect(attrs.dkimTokens).toEqual(['t1']);
  });

  it('normalizes an unknown/absent DKIM status to NOT_STARTED', async () => {
    ses.on(GetEmailIdentityCommand).resolves({ DkimAttributes: {} });
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    const attrs = await client.getIdentityVerificationAttributes('mail.acme.com');
    expect(attrs.dkimStatus).toBe('NOT_STARTED');
    expect(attrs.signingEnabled).toBe(false);
  });

  it('createConfigurationSet sends a CreateConfigurationSetCommand with the name', async () => {
    ses.on(CreateConfigurationSetCommand).resolves({});
    const client = new ProdSesEmailClient(ses as unknown as SESv2Client);
    await client.createConfigurationSet('ws-cfgset-123');
    const calls = ses.commandCalls(CreateConfigurationSetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.ConfigurationSetName).toBe('ws-cfgset-123');
  });
});
