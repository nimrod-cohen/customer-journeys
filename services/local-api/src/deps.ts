// Injectable dependency boundary for the local API (§12, §16A). SES/SQS/DNS are
// MOCKED here for local dev + integration/e2e; Postgres is REAL. The onboarding,
// broadcast, and campaign cores all take injected SES/DNS/SQS surfaces, so we
// build local/fake implementations once and wire them into the handlers.
//
// This keeps the CRITICAL invariant testable: real role + workspace scope (PG)
// with the external side-effects (sending mail, enqueuing) stubbed so tests are
// deterministic and never hit AWS.
import type { Pool } from 'pg';
import { getPool } from '@cdp/db';
import { compileMjml } from '@cdp/email';
import type {
  SesEmailClient,
  CreateDomainIdentityResult,
  IdentityVerificationAttributes,
  SendEmailResult,
  SendEmailInput,
} from '@cdp/email';
import {
  configSetNameFor,
  makeWorkspaceTxRunner,
  type DnsResolver,
  type ProdOnboardingDeps,
} from '@cdp/service-onboarding';
import { runStatementsInWorkspaceTx, type BroadcastDeps } from '@cdp/service-broadcast';
import { fetchChannelHttpClient, type ChannelHttpClient } from '@cdp/channels';

/** The full dependency set the handlers consume. */
export interface LocalApiDeps {
  readonly pool: Pool;
  /** Compile MJML→HTML at template-save time (reuse @cdp/email). */
  compileMjml(mjml: string): string;
  /** Onboarding deps (SES + DNS mocked). */
  readonly onboarding: ProdOnboardingDeps;
  /** Broadcast deps (SQS mocked). */
  readonly broadcast: BroadcastDeps;
  /**
   * The HTTP client a REAL text-channel adapter (019) POSTs through. Injected so
   * integration tests assert the exact 019 request WITHOUT touching the network;
   * defaults to a real fetch-based client. A company with no '019' config never
   * uses it (the mock provider is offline).
   */
  readonly channelHttp: ChannelHttpClient;
}

/**
 * A local/fake SES client: deterministic DKIM tokens, status driven by env
 * (LOCAL_SES_DKIM_STATUS, default SUCCESS so local activation works), and
 * sendEmail is a no-op returning a fake message id. NEVER sends real mail.
 */
export function makeLocalSes(): SesEmailClient {
  const status = (process.env.LOCAL_SES_DKIM_STATUS as IdentityVerificationAttributes['dkimStatus']) ?? 'SUCCESS';
  return {
    async createDomainIdentity(domain: string): Promise<CreateDomainIdentityResult> {
      return { identity: domain, dkimTokens: ['tok1', 'tok2', 'tok3'], signingHostedZone: 'dkim.amazonses.com' };
    },
    async getIdentityVerificationAttributes(): Promise<IdentityVerificationAttributes> {
      return { dkimStatus: status, signingEnabled: true, dkimTokens: ['tok1', 'tok2', 'tok3'], signingHostedZone: 'dkim.amazonses.com' };
    },
    async createConfigurationSet(): Promise<void> {
      /* no-op locally */
    },
    async sendEmail(_input: SendEmailInput): Promise<SendEmailResult> {
      return { sesMessageId: `local-${Date.now()}` };
    },
    async provisionDedicatedIp(): Promise<void> {
      /* no-op locally */
    },
  };
}

/**
 * A local DNS resolver that reports every required record as RESOLVED so local
 * activation can complete without real DNS. (The onboarding integration test
 * uses its OWN injected resolver to prove the gate logic; this is for dev/e2e.)
 */
export function makeLocalDns(): DnsResolver {
  return {
    async resolve(name: string, type: string): Promise<readonly string[]> {
      if (type === 'CNAME') return [`${name}.dkim.amazonses.com`];
      if (type === 'MX') return ['feedback-smtp.us-east-1.amazonses.com'];
      if (type === 'TXT') return ['v=spf1 include:amazonses.com ~all', 'v=DMARC1; p=none'];
      return [];
    },
  };
}

/** A local SQS sender: no-op (records nothing); broadcasts still write the outbox. */
export function makeLocalSqs(): BroadcastDeps['sqs'] {
  return {
    async send(): Promise<unknown> {
      return { MessageId: `local-sqs-${Date.now()}` };
    },
  };
}

/** Read the persisted sending_identity for a workspace (workspace-scoped, $1). */
function makeIdentityReader(pool: Pool): ProdOnboardingDeps['identity'] {
  return {
    async read(workspaceId: string) {
      const { rows } = await pool.query(
        'SELECT sending_identity FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      const si = rows[0]?.sending_identity as Record<string, unknown> | undefined;
      if (!si || typeof si['ses_identity'] !== 'string') return null;
      return {
        from_domain: String(si['from_domain'] ?? ''),
        ses_identity: String(si['ses_identity']),
        dkim_tokens: Array.isArray(si['dkim_tokens']) ? (si['dkim_tokens'] as string[]) : [],
        mail_from: String(si['mail_from'] ?? ''),
      };
    },
  };
}

/** Build the default local deps: real PG pool, mocked SES/DNS/SQS.
 *  Real SES is NOT chosen here — it's PER-COMPANY: when a company has saved SES
 *  credentials, the sending-domain handlers build a real SES client from them
 *  (createSesClient); otherwise they fall back to this mock (dev/tests). */
export function makeLocalDeps(
  pool: Pool = getPool(),
  channelHttp: ChannelHttpClient = fetchChannelHttpClient(),
): LocalApiDeps {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const ses = makeLocalSes();
  const dns = makeLocalDns();
  const onboarding: ProdOnboardingDeps = {
    ses,
    dns,
    identity: makeIdentityReader(pool),
    runInWorkspaceTx: makeWorkspaceTxRunner(pool),
    region,
    configSetName: configSetNameFor,
  };
  const broadcast: BroadcastDeps = {
    reader: {
      query: async <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const r = await pool.query(text, values ? [...values] : undefined);
        return { rows: r.rows as T[] };
      },
    },
    sqs: makeLocalSqs(),
    runInWorkspaceTx: (workspaceId, statements) =>
      runStatementsInWorkspaceTx(pool, workspaceId, statements),
    now: () => new Date(),
    dispatchQueueUrl: process.env.DISPATCH_QUEUE_URL ?? 'local://dispatch',
  };
  return { pool, compileMjml, onboarding, broadcast, channelHttp };
}
