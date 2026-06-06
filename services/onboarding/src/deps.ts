// Production onboarding dependencies (§10A). The Onboarding Lambda connects with
// the SERVICE ROLE (BYPASSRLS) → isolation is in-code workspace_id scoping (every
// statement binds workspace_id at $1) plus the workspace-scoped tx runner reused
// from the processor service. SES + DNS are real here; in tests they are injected
// fakes/mocks (SES never really called; DNS never really queried).
import { promises as dnsPromises } from 'node:dns';
import type { Pool } from 'pg';
import { getPool } from '@cdp/db';
import { ProdSesEmailClient, type SesEmailClient } from '@cdp/email';
import { runPlanInWorkspaceTx, type SqlStatement } from '@cdp/service-processor';
import type { DnsResolver } from './check-domain.js';
import type { PersistedSendingIdentity, SendingIdentityReader } from './check-domain.js';
import type { DnsRecordType } from './core.js';

/**
 * Commit a set of workspace-scoped statements in ONE transaction by reusing the
 * processor's `runPlanInWorkspaceTx` (the EXACT production tx path). We wrap the
 * statements in a minimal plan (no segment re-eval); workspace_id is asserted to
 * match. This keeps onboarding's writes on the same atomic, scoped commit path.
 */
export function makeWorkspaceTxRunner(pool: Pool) {
  return async (
    workspaceId: string,
    statements: readonly SqlStatement[],
  ): Promise<void> => {
    await runPlanInWorkspaceTx(pool, workspaceId, {
      workspaceId,
      profileExternalId: '',
      statements,
    });
  };
}

/** Real DNS resolver over node:dns, mapping our record types to lookups. */
export function makeProdDnsResolver(): DnsResolver {
  return {
    async resolve(name: string, type: DnsRecordType): Promise<readonly string[]> {
      switch (type) {
        case 'CNAME':
          return await dnsPromises.resolveCname(name);
        case 'TXT': {
          const records = await dnsPromises.resolveTxt(name);
          // node returns string[][] (chunks) → join each record's chunks.
          return records.map((chunks) => chunks.join(''));
        }
        case 'MX': {
          const mx = await dnsPromises.resolveMx(name);
          return mx.map((r) => r.exchange);
        }
        default:
          return [];
      }
    },
  };
}

/** Reads `workspaces.sending_identity` for a workspace (workspace-scoped, $1). */
export function makeSendingIdentityReader(pool: Pool): SendingIdentityReader {
  return {
    async read(workspaceId: string): Promise<PersistedSendingIdentity | null> {
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

/** Deterministic Configuration Set name per workspace (§10A). */
export function configSetNameFor(workspaceId: string): string {
  return `cdp-ws-${workspaceId}`;
}

/** The full production dependency set wiring SES + DNS + DB. */
export interface ProdOnboardingDeps {
  readonly ses: SesEmailClient;
  readonly dns: DnsResolver;
  readonly identity: SendingIdentityReader;
  readonly runInWorkspaceTx: ReturnType<typeof makeWorkspaceTxRunner>;
  readonly region: string;
  readonly configSetName: (workspaceId: string) => string;
}

/** Assemble production onboarding deps (pooled pg, service role, real SES/DNS). */
export function makeProdDeps(): ProdOnboardingDeps {
  const pool: Pool = getPool();
  const region = process.env.AWS_REGION ?? 'us-east-1';
  return {
    ses: new ProdSesEmailClient(),
    dns: makeProdDnsResolver(),
    identity: makeSendingIdentityReader(pool),
    runInWorkspaceTx: makeWorkspaceTxRunner(pool),
    region,
    configSetName: configSetNameFor,
  };
}
