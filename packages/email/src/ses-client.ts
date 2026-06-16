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
  CreateDedicatedIpPoolCommand,
  SendEmailCommand,
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
  /**
   * The DKIM "signing hosted zone" SES reports (`DkimAttributes.SigningHostedZone`):
   * the exact CNAME target host the customer must point selectors at —
   * `<token>.<signingHostedZone>`. AUTHORITATIVE (region-specific); use this
   * instead of constructing `dkim.<region>.amazonses.com` ourselves. Absent on
   * older API versions → caller falls back.
   */
  readonly signingHostedZone?: string;
}

/** The DKIM verification attributes SES reports for an identity (§10A gate). */
export interface IdentityVerificationAttributes {
  /** SES's source-of-truth DKIM status — the activate gate, NOT DNS. */
  readonly dkimStatus: DkimStatus;
  /** Whether DKIM signing is enabled for the identity. */
  readonly signingEnabled: boolean;
  /** The DKIM tokens (echoed back; useful for re-rendering records). */
  readonly dkimTokens: readonly string[];
  /** The authoritative CNAME target host (see CreateDomainIdentityResult). */
  readonly signingHostedZone?: string;
}

/**
 * A single outbound email, fully prepared by the Dispatcher core (§9 step 5/6).
 * The Dispatcher builds this (no hand-rolled HTML — `html` is the workspace's
 * compiled template with merge tags substituted) and the wrapper maps it 1:1
 * onto the SESv2 SendEmailCommand. `configurationSetName` routes via the
 * workspace's Configuration Set / sending identity (§10).
 */
export interface SendEmailInput {
  /** From address built from the workspace sending identity (§10). */
  readonly from: string;
  /** Single recipient address. */
  readonly to: string;
  /** Subject line. */
  readonly subject: string;
  /** Compiled, merge-substituted HTML body (never hand-rolled). */
  readonly html: string;
  /** The workspace's Configuration Set name (routes IP pool + tracking). */
  readonly configurationSetName?: string;
  /** Extra message headers — the RFC 8058 List-Unsubscribe pair (§9 step 5). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Result of a successful SES send — the message id for messages_log (§9). */
export interface SendEmailResult {
  /** SES's MessageId (empty string if SES omits one). */
  readonly sesMessageId: string;
}

/**
 * The injectable SES surface this phase needs:
 *   - createDomainIdentity — create a domain identity with Easy DKIM (returns
 *     the CNAME tokens to publish).
 *   - getIdentityVerificationAttributes — read the DKIM status (the gate).
 *   - createConfigurationSet — create the workspace's Configuration Set at
 *     activation time.
 *   - sendEmail — send one prepared email via SESv2 SendEmail (§9 step 6),
 *     returning the SES message id. Mocked in tests; never sends real mail.
 */
export interface SesEmailClient {
  createDomainIdentity(domain: string): Promise<CreateDomainIdentityResult>;
  getIdentityVerificationAttributes(
    identity: string,
  ): Promise<IdentityVerificationAttributes>;
  createConfigurationSet(name: string): Promise<void>;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  /**
   * Provision a STANDARD dedicated IP pool (§10). The upgrade orchestrator calls
   * this FIRST; only if it succeeds does it write the ip_mode DB transition, so
   * a provisioning failure leaves the workspace on the shared pool.
   */
  provisionDedicatedIp(poolName: string): Promise<void>;
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
      ...(out.DkimAttributes?.SigningHostedZone ? { signingHostedZone: out.DkimAttributes.SigningHostedZone } : {}),
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
      ...(out.DkimAttributes?.SigningHostedZone ? { signingHostedZone: out.DkimAttributes.SigningHostedZone } : {}),
    };
  }

  async createConfigurationSet(name: string): Promise<void> {
    await this.client.send(
      new CreateConfigurationSetCommand({ ConfigurationSetName: name }),
    );
  }

  async provisionDedicatedIp(poolName: string): Promise<void> {
    await this.client.send(
      new CreateDedicatedIpPoolCommand({ PoolName: poolName, ScalingMode: 'STANDARD' }),
    );
  }

  async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
    const headers = Object.entries(input.headers ?? {}).map(([Name, Value]) => ({
      Name,
      Value,
    }));
    const out = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: input.from,
        Destination: { ToAddresses: [input.to] },
        ...(input.configurationSetName
          ? { ConfigurationSetName: input.configurationSetName }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: input.subject },
            Body: { Html: { Data: input.html } },
            ...(headers.length > 0 ? { Headers: headers } : {}),
          },
        },
      }),
    );
    return { sesMessageId: out.MessageId ?? '' };
  }
}

/** Explicit credentials + region for a per-company SES client (§10). */
export interface SesClientConfig {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Build a real SES client bound to a SPECIFIC AWS account + region — used when a
 * company brings its own SES credentials (stored per company). Each company's
 * domains are verified/sent through its OWN account.
 */
export function createSesClient(cfg: SesClientConfig): SesEmailClient {
  return new ProdSesEmailClient(
    new SESv2Client({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    }),
  );
}
