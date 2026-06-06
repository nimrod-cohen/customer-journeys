// check-domain entrypoint (§10A step 3). Thin wiring: read the workspace's
// persisted record set, run live DNS lookups (injected resolver) + re-read SES
// DKIM status (injected SES wrapper), and combine via the pure core. SES status
// is the gate; DNS powers the per-record UX. NEVER hits real DNS/SES in tests.
import type { SesEmailClient } from '@cdp/email';
import {
  buildDnsRecordSet,
  checkDomainCore,
  type CheckDomainResult,
  type DnsAnswer,
  type DnsRecord,
  type DnsRecordSet,
  type DnsRecordType,
} from './core.js';

/** Injected DNS resolver — one lookup per (name, type). Real impl uses node:dns. */
export interface DnsResolver {
  resolve(name: string, type: DnsRecordType): Promise<readonly string[]>;
}

/** Reads the persisted sending_identity for a workspace (workspace-scoped). */
export interface SendingIdentityReader {
  read(workspaceId: string): Promise<PersistedSendingIdentity | null>;
}

/** The subset of `workspaces.sending_identity` check-domain depends on. */
export interface PersistedSendingIdentity {
  readonly from_domain: string;
  readonly ses_identity: string;
  readonly dkim_tokens: readonly string[];
  readonly mail_from: string;
}

/** Injected dependencies for check-domain. */
export interface CheckDomainDeps {
  readonly ses: SesEmailClient;
  readonly dns: DnsResolver;
  readonly identity: SendingIdentityReader;
  readonly region: string;
}

export interface CheckDomainInput {
  readonly workspaceId: string;
}

/** Resolve live DNS for every record in the set into DnsAnswer[]. */
export async function resolveAnswers(
  dns: DnsResolver,
  records: readonly DnsRecord[],
): Promise<DnsAnswer[]> {
  // De-dup (name,type) lookups so we query each distinct record once.
  const seen = new Map<string, { name: string; type: DnsRecordType }>();
  for (const r of records) seen.set(`${r.name}|${r.type}`, { name: r.name, type: r.type });

  const answers: DnsAnswer[] = [];
  for (const { name, type } of seen.values()) {
    let values: readonly string[] = [];
    try {
      values = await dns.resolve(name, type);
    } catch {
      // A failed lookup (NXDOMAIN/timeout) is treated as "no answer yet" → pending.
      values = [];
    }
    answers.push({ name, type, values });
  }
  return answers;
}

/**
 * Reconstruct the workspace's expected record set from its persisted identity.
 * Pure given the persisted fields + region.
 */
export function recordSetFromIdentity(
  identity: PersistedSendingIdentity,
  region: string,
): DnsRecordSet {
  return buildDnsRecordSet(
    identity.from_domain,
    identity.dkim_tokens,
    identity.mail_from,
    region,
  );
}

/**
 * Run a live domain check: rebuild the expected records, resolve them in DNS,
 * read SES DKIM status, and combine. SES status is the activation gate; the
 * per-record DNS states are UX. Throws if the workspace hasn't started onboarding.
 */
export async function checkDomain(
  deps: CheckDomainDeps,
  input: CheckDomainInput,
): Promise<CheckDomainResult> {
  if (!input.workspaceId) {
    throw new Error('checkDomain: workspaceId is required (tenant-isolation guard)');
  }
  const persisted = await deps.identity.read(input.workspaceId);
  if (!persisted) {
    throw new Error('checkDomain: workspace has no sending identity (start-domain first)');
  }
  const records = recordSetFromIdentity(persisted, deps.region);
  const answers = await resolveAnswers(deps.dns, records.records);
  const ses = await deps.ses.getIdentityVerificationAttributes(persisted.ses_identity);
  return checkDomainCore(records, answers, ses.dkimStatus);
}
