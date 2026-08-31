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

/** Google is called from a user-facing request path, so a hang is not acceptable. */
export const POSTMASTER_TIMEOUT_MS = 8000;

export function fetchPostmasterHttp(timeoutMs = POSTMASTER_TIMEOUT_MS): PostmasterHttp {
  return {
    async request(method, url, headers, body) {
      // Without this, a slow or unresponsive Google would hold the domain-check
      // request open indefinitely — reputation monitoring blocking domain setup is
      // exactly the coupling this module is meant to avoid.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          signal: ctrl.signal,
          ...(body === undefined ? {} : { body }),
        });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Supplies a bearer token, refreshing it as needed. Injected so tests never call Google. */
export interface TokenSource {
  accessToken(): Promise<string>;
}

/**
 * One metric value for one day (or one OVERALL aggregate).
 *
 * v2 dropped v1's coarse reputation buckets (BAD/LOW/MEDIUM/HIGH) in favour of
 * concrete rates, which is strictly better: SPAM_RATE is the number Gmail actually
 * enforces against, not a bucket you have to interpret.
 */
export interface DomainMetric {
  /** The name WE gave the metric in the request, e.g. 'spam'. */
  readonly metric: string;
  readonly value: number | null;
  /** ISO date, or null for an OVERALL aggregate. */
  readonly date: string | null;
}

/** The metrics Gmail exposes. SPAM_RATE is the one that decides inbox placement. */
export type StandardMetric =
  | 'SPAM_RATE'
  | 'AUTH_SUCCESS_RATE'
  | 'DELIVERY_ERROR_RATE'
  | 'DELIVERY_ERROR_COUNT'
  | 'TLS_ENCRYPTION_RATE'
  | 'TLS_ENCRYPTION_MESSAGE_COUNT'
  | 'FEEDBACK_LOOP_SPAM_RATE'
  | 'FEEDBACK_LOOP_ID';

/**
 * Gmail's bulk-sender compliance checklist, as GOOGLE evaluates it — more
 * authoritative than our own DNS lookups, because it reflects what actually
 * happens to the mail rather than what the records say.
 */
export interface ComplianceStatus {
  /** requirement -> status, e.g. SPF_AND_DKIM -> COMPLIANT. */
  readonly requirements: Record<string, string>;
  readonly oneClickUnsubscribe: string | null;
  readonly honorUnsubscribe: string | null;
  readonly deliverability: string | null;
  /** Why Gmail reached that deliverability verdict, when it says. */
  readonly deliverabilityReason: string | null;
}

export interface PostmasterClient {
  createDomain(domain: string): Promise<{ name: string }>;
  getVerificationToken(domain: string): Promise<string>;
  verifyDomain(domain: string): Promise<{ verified: boolean; detail: string | null }>;
  getComplianceStatus(domain: string): Promise<ComplianceStatus>;
  /** Daily values for the last `days`, or a single OVERALL aggregate. */
  getMetrics(
    domain: string,
    days: number,
    metrics?: readonly StandardMetric[],
    granularity?: 'DAILY' | 'OVERALL',
  ): Promise<DomainMetric[]>;
}

/** Google's Date wire type. */
function googleDate(d: Date): { year: number; month: number; day: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The domain itself, normalized — what `domainId` wants (no `domains/` prefix). */
function bareDomain(domain: string): string {
  return domain.trim().toLowerCase();
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
    // Registration is AIP-133 shaped: the id goes in `domainId`, NOT in the body.
    // Sending `{ name: 'domains/<d>' }` — the obvious reading of the resource docs —
    // is rejected with `Unknown name "name": Cannot find field`, since the request
    // message has no such field. Found against the live API.
    async createDomain(domain) {
      const res = await call('POST', `/domains?domainId=${encodeURIComponent(bareDomain(domain))}`, {});
      // Already registered is a SUCCESS: onboarding gets retried in practice, and a
      // second attempt must not look like a failure.
      if (res.status === 409) return { name: resourceName(domain) };
      if (!ok(res.status)) throw new Error(`postmaster: create ${domain} failed (${res.status})`);
      return { name: parse<{ name?: string }>(res.body)?.name ?? resourceName(domain) };
    },

    // `verificationMethod` is REQUIRED and its enum is `TXT` | `CNAME` — not the
    // `DNS_TXT` the site-verification API uses. Omitting it returns a bare
    // INVALID_ARGUMENT that names nothing.
    async getVerificationToken(domain) {
      const res = await call('GET', `/${resourceName(domain)}/verificationToken?verificationMethod=TXT`);
      if (!ok(res.status)) throw new Error(`postmaster: token for ${domain} failed (${res.status})`);
      const token = parse<{ token?: string; verificationToken?: string }>(res.body);
      const value = token?.token ?? token?.verificationToken ?? null;
      if (!value) throw new Error(`postmaster: no verification token returned for ${domain}`);
      return value;
    },

    /**
     * Ask Google to look for the record. The method must match the one the token
     * was issued for, and success is a bare `{}` with a 200 — there is no `verified`
     * field to read, so treating its absence as "not verified" would report every
     * successful verification as a failure.
     */
    async verifyDomain(domain) {
      const res = await call('POST', `/${resourceName(domain)}:verify?verificationMethod=TXT`);
      if (ok(res.status)) return { verified: true, detail: null };
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
      const p = parse<{
        complianceData?: {
          rowData?: { requirement?: string; status?: { status?: string } }[];
          oneClickUnsubscribeVerdict?: { status?: { status?: string } };
          honorUnsubscribeVerdict?: { status?: { status?: string } };
          deliverabilityStatusVerdict?: { state?: { status?: string }; reason?: string };
        };
      }>(res.body);
      const data = p?.complianceData;
      const requirements: Record<string, string> = {};
      for (const row of data?.rowData ?? []) {
        if (row.requirement && row.status?.status) requirements[row.requirement] = row.status.status;
      }
      return {
        requirements,
        oneClickUnsubscribe: data?.oneClickUnsubscribeVerdict?.status?.status ?? null,
        honorUnsubscribe: data?.honorUnsubscribeVerdict?.status?.status ?? null,
        deliverability: data?.deliverabilityStatusVerdict?.state?.status ?? null,
        deliverabilityReason: data?.deliverabilityStatusVerdict?.reason ?? null,
      };
    },

    async getMetrics(domain, days, metrics = ['SPAM_RATE', 'AUTH_SUCCESS_RATE'], granularity = 'DAILY') {
      // Gmail publishes on a lag, so the window ends two days back — asking for
      // today reliably returns nothing and looks like a broken integration.
      const end = new Date(Date.now() - 2 * 86_400_000);
      const start = new Date(Date.now() - (Math.max(1, days) + 2) * 86_400_000);
      const parent = resourceName(domain);

      // `parent` is required in the BODY as well as the URL path. Omitting it is a
      // bare INVALID_ARGUMENT with no field named, which is a long afternoon.
      const res = await call('POST', `/${parent}/domainStats:query`, {
        parent,
        metricDefinitions: metrics.map((m) => ({ name: m.toLowerCase(), baseMetric: { standardMetric: m } })),
        timeQuery: { dateRanges: { dateRanges: [{ start: googleDate(start), end: googleDate(end) }] } },
        aggregationGranularity: granularity,
        pageSize: 200,
      });
      if (!ok(res.status)) throw new Error(`postmaster: metrics for ${domain} failed (${res.status})`);

      const p = parse<{
        domainStats?: {
          metric?: string;
          value?: { floatValue?: number; int64Value?: string };
          date?: { year?: number; month?: number; day?: number };
        }[];
      }>(res.body);

      return (p?.domainStats ?? []).map((row) => {
        const v = row.value;
        const num =
          typeof v?.floatValue === 'number'
            ? v.floatValue
            : v?.int64Value !== undefined
              ? Number(v.int64Value)
              : null;
        const d = row.date;
        return {
          metric: row.metric ?? 'unknown',
          value: num !== null && Number.isFinite(num) ? num : null,
          date:
            d?.year && d.month && d.day
              ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
              : null,
        };
      });
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

// ── wiring ───────────────────────────────────────────────────────────────────

/**
 * Refresh-token-backed access tokens, cached until shortly before expiry.
 *
 * Google's access tokens last an hour; minting a fresh one per API call would
 * burn quota and add a round trip to every request. The 60s safety margin avoids
 * handing out a token that expires mid-flight.
 */
export function makeRefreshTokenSource(
  cfg: { clientId: string; clientSecret: string; refreshToken: string },
  http: PostmasterHttp = fetchPostmasterHttp(),
): TokenSource {
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async accessToken() {
      if (cached && Date.now() < cached.expiresAt) return cached.token;
      const res = await http.request(
        'POST',
        'https://oauth2.googleapis.com/token',
        { 'content-type': 'application/x-www-form-urlencoded' },
        new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: cfg.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      );
      const body = parse<{ access_token?: string; expires_in?: number }>(res.body);
      if (res.status < 200 || res.status >= 300 || !body?.access_token) {
        throw new Error(`postmaster: token refresh failed (${res.status})`);
      }
      cached = {
        token: body.access_token,
        expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
      };
      return cached.token;
    },
  };
}

/**
 * The platform client, or null when Postmaster is not configured.
 *
 * Null is a normal state, not an error: reputation monitoring is optional, so
 * every caller must work without it rather than treating absence as a failure.
 */
export function postmasterFromEnv(env: NodeJS.ProcessEnv = process.env): PostmasterClient | null {
  const clientId = env.GOOGLE_POSTMASTER_CLIENT_ID;
  const clientSecret = env.GOOGLE_POSTMASTER_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_POSTMASTER_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return makePostmasterClient(makeRefreshTokenSource({ clientId, clientSecret, refreshToken }));
}

/** What a domain sync produced, for the setup screen to render. */
export interface PostmasterSync {
  /** The TXT value the customer publishes, when Google has issued one. */
  readonly token: string | null;
  readonly verified: boolean;
  /** Set when the sync could not complete — shown as a hint, never an error. */
  readonly error: string | null;
}

/**
 * Register a domain under our Postmaster account and check its verification.
 *
 * Wholly best-effort: reputation visibility must never break domain setup, so
 * every failure is captured and returned rather than thrown. Idempotent, so it
 * can run on every check.
 */
export async function syncDomainWithPostmaster(
  client: PostmasterClient,
  domain: string,
): Promise<PostmasterSync> {
  try {
    await client.createDomain(domain);
  } catch (e) {
    // A registration failure is not fatal — the domain may already exist under a
    // different account, or Google may simply be unavailable.
    return { token: null, verified: false, error: e instanceof Error ? e.message : 'registration failed' };
  }

  let token: string | null = null;
  try {
    token = await client.getVerificationToken(domain);
  } catch {
    token = null;
  }

  try {
    const v = await client.verifyDomain(domain);
    return { token, verified: v.verified, error: null };
  } catch (e) {
    return { token, verified: false, error: e instanceof Error ? e.message : 'verification failed' };
  }
}
