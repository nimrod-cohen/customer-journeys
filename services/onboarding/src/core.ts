// Onboarding pure core (§10, §10A). No I/O — entrypoints inject the SES wrapper,
// a DNS resolver, and a SES-status reader and wire these. The cardinal invariant
// (§10A, CLAUDE.md inv. 7): the ACTIVATE GATE is SES DKIM verification status —
// NOT DNS and NOT the registrar. Live DNS lookups power the per-record UX and
// validate SPF/DMARC/MAIL-FROM (which SES does not verify), but SES status is
// the source of truth for "can this workspace send".
import type { DkimStatus } from '@cdp/email';

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** DNS record kinds the wizard asks the user to publish (§10A). */
export type DnsRecordType = 'CNAME' | 'TXT' | 'MX';

/** Why a record matters for activation — DKIM/SPF/MAILFROM are required; DMARC is recommended. */
export type RecordRole = 'dkim' | 'spf' | 'mailfrom_mx' | 'mailfrom_spf' | 'dmarc';

/** One publishable DNS record (a copy-paste row in the wizard, §10A step 2). */
export interface DnsRecord {
  readonly role: RecordRole;
  readonly type: DnsRecordType;
  /** Fully-qualified record name to publish. */
  readonly name: string;
  /** Expected record value SES/SPF/DMARC requires. */
  readonly value: string;
  /** For MX records, the preference; omitted otherwise. */
  readonly priority?: number;
  /** Whether resolving this record is REQUIRED to activate (DMARC is not). */
  readonly required: boolean;
}

/** The full record set returned to the wizard after start-domain. */
export interface DnsRecordSet {
  readonly fromDomain: string;
  readonly mailFromSubdomain: string;
  readonly region: string;
  readonly records: readonly DnsRecord[];
}

/** The DNS answers a resolver returns for one record name (the live lookup). */
export interface DnsAnswer {
  readonly name: string;
  readonly type: DnsRecordType;
  /** Resolved values (e.g. CNAME target(s), TXT strings, MX exchanges). */
  readonly values: readonly string[];
}

/** Per-record check status shown in the wizard (§10A step 3). */
export type RecordStatus = 'found' | 'pending' | 'mismatch';

/** The result of checking a single record against live DNS. */
export interface RecordCheck {
  readonly role: RecordRole;
  readonly name: string;
  readonly type: DnsRecordType;
  readonly required: boolean;
  readonly status: RecordStatus;
  /** A short fix hint when pending/mismatch (UX only). */
  readonly hint?: string;
}

/** The combined domain-check result (per-record DNS + the SES DKIM gate). */
export interface CheckDomainResult {
  /** SES's DKIM status — the activation gate (NOT derived from DNS). */
  readonly dkimStatus: DkimStatus;
  /** True iff SES reports DKIM SUCCESS. */
  readonly dkimVerified: boolean;
  /** Per-record DNS check states (for the live UX). */
  readonly recordChecks: readonly RecordCheck[];
  /** True iff every REQUIRED non-DKIM record resolves (DMARC excluded). */
  readonly requiredRecordsResolved: boolean;
}

/** The activate gate decision (§10A step 4). */
export interface ActivateDecision {
  readonly allowed: boolean;
  /** The Configuration Set name to create on the shared pool, when allowed. */
  readonly configSetName?: string;
  /** Human-readable reason when denied (logged / surfaced in the wizard). */
  readonly reason?: string;
}

/** Default DKIM CNAME suffix for Easy DKIM (§10A). */
const DKIM_DNS_SUFFIX = 'dkim.amazonses.com';

function dkimCnameName(token: string, fromDomain: string): string {
  return `${token}._domainkey.${fromDomain}`;
}
function dkimCnameValue(token: string): string {
  return `${token}.${DKIM_DNS_SUFFIX}`;
}

/**
 * Build the full publishable DNS record set for a sending domain (§10A step 2):
 *   - 3 × DKIM CNAME (Easy DKIM selector tokens) — REQUIRED
 *   - SPF TXT on the from domain (includes amazonses.com) — REQUIRED
 *   - MAIL FROM MX (feedback-smtp.<region>.amazonses.com) — REQUIRED
 *   - MAIL FROM SPF TXT on the subdomain — REQUIRED
 *   - DMARC TXT (p=none starter, tighten later) — RECOMMENDED (not required)
 *
 * Pure: no SES/DNS calls. The DKIM tokens come from createDomainIdentity. The
 * region parameterizes the MAIL FROM MX exchange.
 */
export function buildDnsRecordSet(
  fromDomain: string,
  dkimTokens: readonly string[],
  mailFromSubdomain: string,
  region: string,
): DnsRecordSet {
  if (!fromDomain) throw new Error('buildDnsRecordSet: fromDomain is required');
  if (!region) throw new Error('buildDnsRecordSet: region is required');

  const dkim: DnsRecord[] = dkimTokens.map((token) => ({
    role: 'dkim',
    type: 'CNAME',
    name: dkimCnameName(token, fromDomain),
    value: dkimCnameValue(token),
    required: true,
  }));

  const spf: DnsRecord = {
    role: 'spf',
    type: 'TXT',
    name: fromDomain,
    value: 'v=spf1 include:amazonses.com ~all',
    required: true,
  };

  const mailFromMx: DnsRecord = {
    role: 'mailfrom_mx',
    type: 'MX',
    name: mailFromSubdomain,
    value: `feedback-smtp.${region}.amazonses.com`,
    priority: 10,
    required: true,
  };

  const mailFromSpf: DnsRecord = {
    role: 'mailfrom_spf',
    type: 'TXT',
    name: mailFromSubdomain,
    value: 'v=spf1 include:amazonses.com ~all',
    required: true,
  };

  const dmarc: DnsRecord = {
    role: 'dmarc',
    type: 'TXT',
    name: `_dmarc.${fromDomain}`,
    value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${fromDomain}`,
    required: false,
  };

  return {
    fromDomain,
    mailFromSubdomain,
    region,
    records: [...dkim, spf, mailFromMx, mailFromSpf, dmarc],
  };
}

/** Normalize a DNS value for comparison: trim, strip surrounding quotes, fold case, drop trailing dot. */
function normalize(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/** True if the expected SPF/DMARC/TXT value is satisfied by any answer (token-equivalent for SPF/DMARC). */
function txtMatches(expected: string, answers: readonly string[]): boolean {
  const exp = normalize(expected);
  return answers.some((a) => {
    const got = normalize(a);
    if (got === exp) return true;
    // SPF: accept any record that includes amazonses.com (user may add other includes).
    if (exp.startsWith('v=spf1') && got.startsWith('v=spf1')) {
      return got.includes('include:amazonses.com');
    }
    // DMARC: accept any v=DMARC1 policy the user published (p=none/quarantine/reject).
    if (exp.startsWith('v=dmarc1') && got.startsWith('v=dmarc1')) {
      return true;
    }
    return false;
  });
}

/**
 * Diff a single expected record against the live DNS answer for its name.
 * Returns a per-record status for the UX:
 *   - `pending`  — no answer yet (DNS hasn't propagated / not published)
 *   - `found`    — an answer matches the expected value
 *   - `mismatch` — answers exist but none match (likely a typo)
 *
 * This is DNS-only UX; it NEVER decides activation by itself (that's SES DKIM).
 */
export function diffRecord(
  expected: DnsRecord,
  answer: DnsAnswer | undefined,
): RecordCheck {
  const base = {
    role: expected.role,
    name: expected.name,
    type: expected.type,
    required: expected.required,
  } as const;

  if (!answer || answer.values.length === 0) {
    return { ...base, status: 'pending', hint: 'No DNS record found yet — publish it and allow time to propagate.' };
  }

  let matched: boolean;
  if (expected.type === 'TXT') {
    matched = txtMatches(expected.value, answer.values);
  } else {
    // CNAME / MX: compare host/exchange ignoring case + trailing dot.
    const exp = normalize(expected.value);
    matched = answer.values.some((v) => normalize(v) === exp || normalize(v).endsWith(exp));
  }

  if (matched) return { ...base, status: 'found' };
  return {
    ...base,
    status: 'mismatch',
    hint: `Found a ${expected.type} record but the value does not match the expected value.`,
  };
}

/**
 * Combine per-record DNS checks with the SES DKIM status (§10A step 3/4).
 *
 * CRITICAL (§10A): `dkimVerified` is derived from `sesStatus` ONLY — never from
 * the DKIM CNAME DNS answers. The DNS checks drive the live per-record UX and
 * gate the non-DKIM REQUIRED records (SPF + MAIL FROM). DMARC is checked for UX
 * but is RECOMMENDED, never counted in `requiredRecordsResolved`.
 */
export function checkDomainCore(
  records: DnsRecordSet,
  dnsAnswers: readonly DnsAnswer[],
  sesStatus: DkimStatus,
): CheckDomainResult {
  const answerFor = (name: string, type: DnsRecordType): DnsAnswer | undefined =>
    dnsAnswers.find(
      (a) => normalize(a.name) === normalize(name) && a.type === type,
    );

  const recordChecks: RecordCheck[] = records.records.map((rec) =>
    diffRecord(rec, answerFor(rec.name, rec.type)),
  );

  // REQUIRED, non-DKIM records (SPF + MAIL FROM MX/SPF) must all resolve.
  // DKIM resolution is intentionally NOT part of this — SES status is the gate.
  // DMARC is recommended → excluded from the required set.
  const requiredRecordsResolved = recordChecks
    .filter((c) => c.required && c.role !== 'dkim')
    .every((c) => c.status === 'found');

  return {
    dkimStatus: sesStatus,
    dkimVerified: sesStatus === 'SUCCESS',
    recordChecks,
    requiredRecordsResolved,
  };
}

/**
 * The activation gate (§10A step 4). Activation is ALLOWED only when BOTH hold:
 *   1. SES reports DKIM `SUCCESS` (the source-of-truth gate — NOT DNS), and
 *   2. every REQUIRED non-DKIM record resolves in live DNS (SPF + MAIL FROM).
 * DMARC is recommended, never required. When allowed, the Configuration Set name
 * is returned so the entrypoint creates it on the shared pool, then flips the
 * workspace to `active` + `verified`. Denials carry a reason.
 *
 * Decoupling proof (the invariant): DNS-all-found + SES PENDING → DENY; SES
 * SUCCESS + a required record pending → DENY; only SUCCESS + required resolved →
 * ALLOW.
 */
export function activateDecision(
  sesStatus: DkimStatus,
  check: CheckDomainResult,
  configSetName: string,
): ActivateDecision {
  if (sesStatus !== 'SUCCESS') {
    return {
      allowed: false,
      reason: `SES DKIM not verified (status=${sesStatus}); cannot activate.`,
    };
  }
  if (!check.requiredRecordsResolved) {
    const pending = check.recordChecks
      .filter((c) => c.required && c.role !== 'dkim' && c.status !== 'found')
      .map((c) => c.role);
    return {
      allowed: false,
      reason: `Required DNS records not resolved: ${pending.join(', ')}.`,
    };
  }
  return { allowed: true, configSetName };
}

/**
 * Build the workspace-scoped UPDATE that records the in-progress sending identity
 * after start-domain (§10A "State & components"). Merges the new fields onto the
 * existing `sending_identity` jsonb (so repeated starts don't clobber unrelated
 * keys) and stays in `onboarding`. workspace_id is bound at $1 — the UPDATE
 * touches exactly the one workspace row.
 */
export function buildStartDomainUpdate(
  workspaceId: string,
  identity: {
    readonly from_domain: string;
    readonly ses_identity: string;
    readonly dkim_tokens: readonly string[];
    readonly mail_from: string;
    readonly dmarc_status: string;
    readonly verified: boolean;
    readonly ip_mode: string;
  },
): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildStartDomainUpdate: workspaceId is required (tenant-isolation guard)');
  }
  return {
    text: `UPDATE workspaces
           SET sending_identity = sending_identity || $2::jsonb
           WHERE id = $1`,
    values: [workspaceId, JSON.stringify(identity)],
  };
}

/**
 * Build the workspace-scoped activation UPDATE (§10A step 4). Sets
 * status='active', merges `{verified:true, config_set, record_checks}` onto the
 * sending_identity jsonb, all in ONE row keyed by id=$1. Touches exactly one row.
 */
export function buildActivateUpdate(
  workspaceId: string,
  configSetName: string,
  recordChecks: readonly RecordCheck[],
): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildActivateUpdate: workspaceId is required (tenant-isolation guard)');
  }
  const patch = {
    verified: true,
    config_set: configSetName,
    record_checks: recordChecks,
  };
  return {
    text: `UPDATE workspaces
           SET status = 'active',
               sending_identity = sending_identity || $2::jsonb
           WHERE id = $1`,
    values: [workspaceId, JSON.stringify(patch)],
  };
}
