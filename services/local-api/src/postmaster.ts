// Google Postmaster Tools (API v2) — Gmail reputation, per sending domain.
//
// Gmail reports domain reputation and spam rate ONLY through Postmaster Tools, and
// only to an account that has proven ownership. There is no API key to hand over,
// so the naive design makes every customer create a Google account, verify their
// domain and complete an OAuth consent screen — three places onboarding stalls.
//
// Instead we register THEIR domain under OUR Postmaster account. A domain may be
// verified by several accounts independently, each via its own DNS TXT record, so
// the customer publishes one more record alongside the CNAMEs they already publish
// and never touches Google.
//
// v2 is what makes this fully automatic — v1 was read-only and would have left
// "add the domain in the Postmaster UI" as a manual step per domain:
//
//   domains.create               register the customer's domain under our account
//   domains.getVerificationToken the TXT value we hand the customer
//   domains.verify               ask Google to check DNS and mark it verified
//   domains.getComplianceStatus  SPF/DKIM/DMARC as GOOGLE sees it
//   domainStats.batchQuery       reputation + spam rate for every domain at once
//
// Auth is one platform-level OAuth credential (ours), never per customer. HTTP is
// injectable so tests assert the exact requests without touching the network.

const API = 'https://gmailpostmastertools.googleapis.com/v2';

export interface PostmasterHttp {
  request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; body: string }>;
}

export function fetchPostmasterHttp(): PostmasterHttp {
  return {
    async request(method, url, headers, body) {
      const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
      return { status: res.status, body: await res.text() };
    },
  };
}

/** Supplies a bearer token, refreshing it as needed. Injected so tests never call Google. */
export interface TokenSource {
  accessToken(): Promise<string>;
}

/** Gmail's reputation buckets, plus the spam rate that actually decides placement. */
export interface DomainReputation {
  readonly domain: string;
  /** BAD | LOW | MEDIUM | HIGH, or null when Gmail has too little volume to report. */
  readonly domainReputation: string | null;
  readonly ipReputation: string | null;
  /** Fraction of delivered mail marked as spam by users. Gmail's threshold is 0.003. */
  readonly userReportedSpamRatio: number | null;
  readonly date: string | null;
}

/** SPF/DKIM/DMARC as Google evaluates them — more authoritative than our own lookups. */
export interface ComplianceStatus {
  readonly spf: string | null;
  readonly dkim: string | null;
  readonly dmarc: string | null;
}

export interface PostmasterClient {
  createDomain(domain: string): Promise<{ name: string }>;
  getVerificationToken(domain: string): Promise<string>;
  verifyDomain(domain: string): Promise<{ verified: boolean; detail: string | null }>;
  getComplianceStatus(domain: string): Promise<ComplianceStatus>;
  getReputation(domain: string, days: number): Promise<DomainReputation[]>;
}

function resourceName(domain: string): string {
  return `domains/${encodeURIComponent(domain.trim().toLowerCase())}`;
}

function parse<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Build a Postmaster client.
 *
 * Every call is best-effort from the caller's point of view: reputation data is
 * MONITORING, and a Google outage or a quota error must never break domain
 * onboarding or block a send. Failures surface as thrown errors here so the caller
 * can decide, but nothing in the sending path awaits this.
 */
export function makePostmasterClient(
  tokens: TokenSource,
  http: PostmasterHttp = fetchPostmasterHttp(),
): PostmasterClient {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: string }> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await tokens.accessToken()}`,
      'content-type': 'application/json',
    };
    return http.request(method, `${API}${path}`, headers, body === undefined ? undefined : JSON.stringify(body));
  };

  const ok = (s: number) => s >= 200 && s < 300;

  return {
    async createDomain(domain) {
      const res = await call('POST', '/domains', { name: resourceName(domain) });
      // Already registered is a SUCCESS: onboarding gets retried in practice, and a
      // second attempt must not look like a failure.
      if (res.status === 409) return { name: resourceName(domain) };
      if (!ok(res.status)) throw new Error(`postmaster: create ${domain} failed (${res.status})`);
      return { name: parse<{ name?: string }>(res.body)?.name ?? resourceName(domain) };
    },

    async getVerificationToken(domain) {
      const res = await call('GET', `/${resourceName(domain)}/verificationToken`);
      if (!ok(res.status)) throw new Error(`postmaster: token for ${domain} failed (${res.status})`);
      const token = parse<{ token?: string; verificationToken?: string }>(res.body);
      const value = token?.token ?? token?.verificationToken ?? null;
      if (!value) throw new Error(`postmaster: no verification token returned for ${domain}`);
      return value;
    },

    async verifyDomain(domain) {
      const res = await call('POST', `/${resourceName(domain)}:verify`);
      if (ok(res.status)) {
        const parsed = parse<{ verified?: boolean; state?: string }>(res.body);
        const verified = parsed?.verified === true || parsed?.state === 'VERIFIED';
        return { verified, detail: verified ? null : 'Google did not report the domain as verified' };
      }
      // A failed verification is the NORMAL case while DNS is still propagating, so
      // it is reported rather than thrown — the caller shows it as "not yet".
      if (res.status === 400 || res.status === 404 || res.status === 412) {
        return { verified: false, detail: 'verification record not found yet' };
      }
      throw new Error(`postmaster: verify ${domain} failed (${res.status})`);
    },

    async getComplianceStatus(domain) {
      const res = await call('GET', `/${resourceName(domain)}/complianceStatus`);
      if (!ok(res.status)) throw new Error(`postmaster: compliance for ${domain} failed (${res.status})`);
      const p = parse<{ spfStatus?: string; dkimStatus?: string; dmarcStatus?: string }>(res.body);
      return { spf: p?.spfStatus ?? null, dkim: p?.dkimStatus ?? null, dmarc: p?.dmarcStatus ?? null };
    },

    async getReputation(domain, days) {
      const res = await call('POST', `/${resourceName(domain)}/domainStats:query`, {
        // Gmail publishes stats on a lag, so a window is always requested rather
        // than a single day — asking for "today" reliably returns nothing.
        pageSize: Math.max(1, Math.min(days, 30)),
      });
      if (!ok(res.status)) throw new Error(`postmaster: stats for ${domain} failed (${res.status})`);
      const p = parse<{
        domainStats?: {
          date?: string;
          domainReputation?: string;
          ipReputations?: { reputation?: string }[];
          userReportedSpamRatio?: number;
        }[];
      }>(res.body);
      return (p?.domainStats ?? []).map((s) => ({
        domain,
        domainReputation: s.domainReputation ?? null,
        ipReputation: s.ipReputations?.[0]?.reputation ?? null,
        userReportedSpamRatio: typeof s.userReportedSpamRatio === 'number' ? s.userReportedSpamRatio : null,
        date: s.date ?? null,
      }));
    },
  };
}

/** Gmail's published bulk-sender limits: stay under 0.10%, never reach 0.30%. */
export const SPAM_RATE_WARN = 0.001;
export const SPAM_RATE_CRITICAL = 0.003;

export type SpamRateVerdict = 'ok' | 'warn' | 'critical' | 'unknown';

/**
 * Judge a spam ratio against Gmail's own thresholds. Pure, so the alerting rule is
 * testable without a network call.
 */
export function judgeSpamRate(ratio: number | null | undefined): SpamRateVerdict {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return 'unknown';
  if (ratio >= SPAM_RATE_CRITICAL) return 'critical';
  if (ratio >= SPAM_RATE_WARN) return 'warn';
  return 'ok';
}
