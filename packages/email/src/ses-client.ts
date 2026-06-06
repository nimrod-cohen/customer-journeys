// Injectable SES wrapper (§10, §10A). The onboarding cores and the (future)
// Dispatcher depend on THIS narrow interface, never the raw AWS SDK — so unit
// tests inject a fake and the integration tier never touches real SES. A single
// production implementation maps these calls to `@aws-sdk/client-sesv2`
// (aws-sdk-client-mock stands in for the SDK in the prod-impl unit test).
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  CreateConfigurationSetCommand,
} from '@aws-sdk/client-sesv2';

/** DKIM verification status as reported by SES (the §10A activate gate). */
export type DkimStatus =
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TEMPORARY_FAILURE'
  | 'NOT_STARTED';

/** Result of creating an Easy-DKIM domain identity — the publishable tokens. */
export interface CreateDomainIdentityResult {
  /** The SES identity (the domain itself). */
  readonly identity: string;
  /** Easy-DKIM CNAME selector tokens (3) to publish as DKIM records (§10A). */
  readonly dkimTokens: readonly string[];
}

/** The DKIM verification attributes SES reports for an identity (§10A gate). */
export interface IdentityVerificationAttributes {
  /** SES's source-of-truth DKIM status — the activate gate, NOT DNS. */
  readonly dkimStatus: DkimStatus;
  /** Whether DKIM signing is enabled for the identity. */
  readonly signingEnabled: boolean;
  /** The DKIM tokens (echoed back; useful for re-rendering records). */
  readonly dkimTokens: readonly string[];
}

/**
 * The injectable SES surface this phase needs:
 *   - createDomainIdentity — create a domain identity with Easy DKIM (returns
 *     the CNAME tokens to publish).
 *   - getIdentityVerificationAttributes — read the DKIM status (the gate).
 *   - createConfigurationSet — create the workspace's Configuration Set at
 *     activation time.
 */
export interface SesEmailClient {
  createDomainIdentity(domain: string): Promise<CreateDomainIdentityResult>;
  getIdentityVerificationAttributes(
    identity: string,
  ): Promise<IdentityVerificationAttributes>;
  createConfigurationSet(name: string): Promise<void>;
}

function normalizeDkimStatus(status: string | undefined): DkimStatus {
  switch (status) {
    case 'PENDING':
    case 'SUCCESS':
    case 'FAILED':
    case 'TEMPORARY_FAILURE':
    case 'NOT_STARTED':
      return status;
    default:
      return 'NOT_STARTED';
  }
}

/**
 * Production SES wrapper over `@aws-sdk/client-sesv2`. Easy DKIM is requested by
 * creating the identity with `DkimSigningAttributes.NextSigningKeyLength` so SES
 * generates and manages the keys (no BYODKIM). The prod-impl unit test asserts
 * the exact commands/inputs via aws-sdk-client-mock; we never send real mail.
 */
export class ProdSesEmailClient implements SesEmailClient {
  private readonly client: SESv2Client;

  constructor(client?: SESv2Client) {
    this.client = client ?? new SESv2Client({});
  }

  async createDomainIdentity(domain: string): Promise<CreateDomainIdentityResult> {
    const out = await this.client.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      }),
    );
    return {
      identity: domain,
      dkimTokens: out.DkimAttributes?.Tokens ?? [],
    };
  }

  async getIdentityVerificationAttributes(
    identity: string,
  ): Promise<IdentityVerificationAttributes> {
    const out = await this.client.send(
      new GetEmailIdentityCommand({ EmailIdentity: identity }),
    );
    return {
      dkimStatus: normalizeDkimStatus(out.DkimAttributes?.Status),
      signingEnabled: out.DkimAttributes?.SigningEnabled ?? false,
      dkimTokens: out.DkimAttributes?.Tokens ?? [],
    };
  }

  async createConfigurationSet(name: string): Promise<void> {
    await this.client.send(
      new CreateConfigurationSetCommand({ ConfigurationSetName: name }),
    );
  }
}
