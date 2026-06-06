// start-domain entrypoint (§10A step 1). Thin wiring: create the SES domain
// identity (Easy DKIM) via the injected SES wrapper, build the publishable DNS
// record set (pure core), persist the in-progress sending_identity via the
// injected workspace-scoped tx runner, and return the records for the wizard.
import type { SesEmailClient } from '@cdp/email';
import {
  buildDnsRecordSet,
  buildStartDomainUpdate,
  type DnsRecordSet,
  type SqlStatement,
} from './core.js';

/** Run a set of statements inside ONE workspace-scoped transaction. */
export type RunInWorkspaceTx = (
  workspaceId: string,
  statements: readonly SqlStatement[],
) => Promise<void>;

/** Injected dependencies for start-domain. */
export interface StartDomainDeps {
  readonly ses: SesEmailClient;
  readonly runInWorkspaceTx: RunInWorkspaceTx;
  /** SES region (parameterizes the MAIL FROM MX exchange). */
  readonly region: string;
}

/** Request to begin domain onboarding for a workspace. */
export interface StartDomainInput {
  readonly workspaceId: string;
  readonly fromDomain: string;
  /** Optional explicit MAIL FROM subdomain; defaults to `mail.<fromDomain>`. */
  readonly mailFromSubdomain?: string;
}

/** What start-domain returns to the wizard. */
export interface StartDomainOutput {
  readonly records: DnsRecordSet;
}

/**
 * Begin domain onboarding: create the SES identity + Easy DKIM, derive the DNS
 * record set, and persist it on the workspace (status stays `onboarding`,
 * verified=false). workspace_id is never client-trusted beyond this call — the
 * persist UPDATE binds it at $1 and touches exactly that row.
 */
export async function startDomain(
  deps: StartDomainDeps,
  input: StartDomainInput,
): Promise<StartDomainOutput> {
  if (!input.workspaceId) {
    throw new Error('startDomain: workspaceId is required (tenant-isolation guard)');
  }
  if (!input.fromDomain) {
    throw new Error('startDomain: fromDomain is required');
  }
  const mailFromSubdomain = input.mailFromSubdomain ?? `mail.${input.fromDomain}`;

  const identity = await deps.ses.createDomainIdentity(input.fromDomain);
  const records = buildDnsRecordSet(
    input.fromDomain,
    identity.dkimTokens,
    mailFromSubdomain,
    deps.region,
  );

  const update = buildStartDomainUpdate(input.workspaceId, {
    from_domain: input.fromDomain,
    ses_identity: identity.identity,
    dkim_tokens: identity.dkimTokens,
    mail_from: mailFromSubdomain,
    dmarc_status: 'none',
    verified: false,
    ip_mode: 'shared',
  });
  await deps.runInWorkspaceTx(input.workspaceId, [update]);

  return { records };
}
