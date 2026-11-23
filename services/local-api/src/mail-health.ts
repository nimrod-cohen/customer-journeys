// Is our mail getting through? A platform-admin view of each sending IP.
//
// Three sources, because none is enough alone:
//   1. A probe ON each mail server opens an SMTP session to Google, Microsoft and
//      Apple and stops after MAIL FROM, so nothing is sent. It must run on the server:
//      a provider only reveals a block to a connection from the blocked IP.
//   2. The same probe asks public blocklists about our IPs.
//   3. Real 5.7.x rejections from `email_events`. Some blocks arrive only after the
//      message body (Apple's HM08), which a no-send probe can never see.
//
// The probe forwards raw answers and every decision is made here, where it is tested.
import type { Pool } from 'pg';
import { isPolicyBlock } from '@cdp/service-feedback';

export const HETZNER_IP = '2.28.76.169';
export const LINODE_IP = '194.195.243.92';

const SERVERS = [
  { ip: HETZNER_IP, name: 'Hetzner', role: 'Mail server' },
  { ip: LINODE_IP, name: 'Linode', role: 'Relay' },
] as const;

const PROVIDERS = [
  { id: 'google', label: 'Google', help: 'https://postmaster.google.com/' },
  { id: 'microsoft', label: 'Microsoft', help: 'https://olcsupport.office.com/' },
  { id: 'apple', label: 'Apple', help: 'https://support.apple.com/en-us/102322' },
] as const;
export type ProviderId = (typeof PROVIDERS)[number]['id'];

const BLOCKLISTS = [
  { zone: 'zen.spamhaus.org', name: 'Spamhaus' },
  { zone: 'bl.spamcop.net', name: 'SpamCop' },
  { zone: 'b.barracudacentral.org', name: 'Barracuda' },
] as const;

/** Every DNS blocklist publishes this address as a permanent "listed" test entry. */
const TEST_POINT = '127.0.0.2';
/** Checks run hourly, so three missed runs means the probe has stopped. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const REJECTION_WINDOW_DAYS = 7;
const KEEP_REPORTS_DAYS = 30;
const MAX_SMTP_RESULTS = 20;
const MAX_DNSBL_RESULTS = 60;
const MAX_REPLY_CHARS = 1000;

export interface SmtpResult {
  readonly provider: string;
  readonly mx: string;
  readonly stage: string;
  readonly code: number | null;
  readonly reply: string;
}
export interface DnsblResult {
  readonly target: string;
  readonly zone: string;
  readonly answers: readonly string[];
  readonly error: string | null;
}
export interface ProbeReport {
  readonly ip: string;
  readonly checked_at: string;
  /** Postfix `relayhost` on this server. Empty means it delivers directly. */
  readonly relayhost: string | null;
  readonly smtp: readonly SmtpResult[];
  readonly dnsbl: readonly DnsblResult[];
}
export interface ProviderRejection {
  readonly provider: ProviderId;
  readonly count: number;
  readonly workspaces: number;
  readonly last_at: string;
  readonly sample: string | null;
}
export type HealthStatus = 'ok' | 'warning' | 'critical';
type ProviderStatus = 'ok' | 'blocked' | 'throttled' | 'unreachable' | 'unknown';
type ListStatus = 'clean' | 'listed' | 'unknown';

export interface HealthIssue {
  readonly severity: 'warning' | 'critical';
  readonly title: string;
  readonly detail: string | null;
  readonly help: string | null;
}

/** Recipient addresses must not leave a tenant's data through a server's reply text. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s<>"'@;:,()[\]]+@[^\s<>"'@;:,()[\]]+\.[^\s<>"'@;:,()[\]]+/g, 'address');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIpv4 = (v: unknown): v is string => typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v);

/** Validate a probe's post. The bearer only proves it came from one of our agents. */
export function parseProbeReport(body: unknown): { ok: true; report: ProbeReport } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isObject(body)) return fail('report must be an object');
  const { ip, checked_at: checkedAt, relayhost, smtp, dnsbl } = body;
  if (!SERVERS.some((s) => s.ip === ip)) return fail('unknown server ip');
  if (typeof checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(checkedAt) || Number.isNaN(Date.parse(checkedAt))) {
    return fail('checked_at must be an ISO timestamp');
  }
  if (relayhost !== undefined && relayhost !== null && typeof relayhost !== 'string') return fail('invalid relayhost');
  if (!Array.isArray(smtp) || smtp.length > MAX_SMTP_RESULTS) return fail('invalid smtp results');
  if (!Array.isArray(dnsbl) || dnsbl.length > MAX_DNSBL_RESULTS) return fail('invalid blocklist results');

  const smtpOut: SmtpResult[] = [];
  for (const r of smtp) {
    if (!isObject(r) || !PROVIDERS.some((p) => p.id === r.provider)) return fail('unknown provider');
    if (typeof r.mx !== 'string' || typeof r.stage !== 'string' || typeof r.reply !== 'string') return fail('invalid smtp result');
    if (r.code !== null && (typeof r.code !== 'number' || !Number.isInteger(r.code))) return fail('invalid smtp code');
    smtpOut.push({
      provider: r.provider as string,
      mx: r.mx.slice(0, 255),
      stage: r.stage.slice(0, 20),
      code: r.code as number | null,
      reply: redactAddresses(r.reply).slice(0, MAX_REPLY_CHARS),
    });
  }
  const dnsblOut: DnsblResult[] = [];
  for (const r of dnsbl) {
    if (!isObject(r) || !isIpv4(r.target) || !BLOCKLISTS.some((l) => l.zone === r.zone)) return fail('invalid blocklist result');
    if (!Array.isArray(r.answers) || r.answers.length > 10 || !r.answers.every(isIpv4)) return fail('invalid blocklist answers');
    if (r.error !== null && typeof r.error !== 'string') return fail('invalid blocklist error');
    dnsblOut.push({
      target: r.target,
      zone: r.zone as string,
      answers: r.answers as string[],
      error: r.error === null ? null : (r.error as string).slice(0, 200),
    });
  }
  return {
    ok: true,
    report: { ip: ip as string, checked_at: checkedAt, relayhost: (relayhost as string | null | undefined) ?? null, smtp: smtpOut, dnsbl: dnsblOut },
  };
}

const smtpStatus = (code: number | null): ProviderStatus => {
  if (code === null) return 'unreachable';
  if (code >= 200 && code < 300) return 'ok';
  if (code >= 500) return 'blocked';
  if (code >= 400) return 'throttled';
  return 'unknown';
};
const STATUS_RANK: Record<ProviderStatus, number> = { blocked: 4, throttled: 3, unreachable: 2, unknown: 1, ok: 0 };

function providerRow(provider: (typeof PROVIDERS)[number], report: ProbeReport | undefined) {
  const results = (report?.smtp ?? []).filter((r) => r.provider === provider.id);
  const worst = [...results].sort((a, b) => STATUS_RANK[smtpStatus(b.code)] - STATUS_RANK[smtpStatus(a.code)])[0];
  return {
    provider: provider.id,
    label: provider.label,
    status: worst ? smtpStatus(worst.code) : ('unknown' as ProviderStatus),
    code: worst?.code ?? null,
    block_code: worst ? (/\b(S\d{4}|HM\d{2})\b/.exec(worst.reply)?.[1] ?? null) : null,
    reply: worst && smtpStatus(worst.code) !== 'ok' ? worst.reply : null,
    mx: worst?.mx ?? null,
  };
}

/** Spamhaus answers 127.255.255.x to resolvers it refuses. That is neither listed nor clean. */
const isRefusal = (answers: readonly string[]) => answers.some((a) => a.startsWith('127.255.'));

function spamhausDetail(answers: readonly string[]): string {
  const names = new Set(
    answers.map((a) => {
      const n = Number(a.split('.')[3]);
      if (n === 2) return 'SBL';
      if (n === 3) return 'CSS';
      if (n >= 4 && n <= 7) return 'XBL';
      if (n === 9) return 'DROP';
      if (n === 10 || n === 11) return 'PBL';
      return a;
    }),
  );
  return `Listed on ${[...names].join(', ')}`;
}

/**
 * One list's verdict on one IP, across every server's answers. An empty answer only
 * counts as clean from a resolver that passed that list's test point, because a
 * blocked resolver also returns nothing.
 */
function blocklistRow(list: (typeof BLOCKLISTS)[number], target: string, reports: readonly ProbeReport[]) {
  let status: ListStatus = 'unknown';
  let detail: string | null = 'No trusted answer from this list';
  for (const report of reports) {
    const rows = report.dnsbl.filter((r) => r.zone === list.zone);
    const test = rows.find((r) => r.target === TEST_POINT);
    if (!test || test.error || isRefusal(test.answers) || !test.answers.includes(TEST_POINT)) continue;
    const answer = rows.find((r) => r.target === target);
    if (!answer || answer.error || isRefusal(answer.answers)) continue;
    if (answer.answers.length > 0) {
      return {
        zone: list.zone,
        name: list.name,
        status: 'listed' as ListStatus,
        detail: list.zone === 'zen.spamhaus.org' ? spamhausDetail(answer.answers) : `Listed (${answer.answers.join(', ')})`,
      };
    }
    status = 'clean';
    detail = null;
  }
  return { zone: list.zone, name: list.name, status, detail };
}

export function computeMailHealth(input: {
  reports: readonly ProbeReport[];
  rejections: readonly ProviderRejection[];
  now: Date;
}) {
  const { reports, rejections, now } = input;
  const byIp = new Map(reports.map((r) => [r.ip, r]));
  const relayhost = byIp.get(HETZNER_IP)?.relayhost;
  // Unknown route: treat both as delivering, so a block is never played down.
  const deliveringIp = relayhost === undefined || relayhost === null ? null : relayhost.trim() ? LINODE_IP : HETZNER_IP;

  const issues: HealthIssue[] = [];
  const servers = SERVERS.map((s) => {
    const report = byIp.get(s.ip);
    const delivering = deliveringIp === null || deliveringIp === s.ip;
    const severity = delivering ? ('critical' as const) : ('warning' as const);
    const stale = !report || now.getTime() - Date.parse(report.checked_at) > STALE_AFTER_MS;
    const providers = PROVIDERS.map((p) => providerRow(p, report));
    const blocklists = BLOCKLISTS.map((l) => blocklistRow(l, s.ip, reports));

    if (!report) {
      issues.push({ severity: 'warning', title: `${s.name} has not reported any checks`, detail: 'Its probe may not be installed.', help: null });
    } else if (stale) {
      issues.push({ severity: 'warning', title: `Checks from ${s.name} stopped arriving`, detail: `Last check: ${report.checked_at}`, help: null });
    }
    for (const p of providers) {
      const help = PROVIDERS.find((x) => x.id === p.provider)!.help;
      if (p.status === 'blocked') {
        issues.push({ severity, title: `${p.label} is blocking ${s.name} (${s.ip})`, detail: p.reply, help });
      } else if (p.status === 'throttled') {
        issues.push({ severity: 'warning', title: `${p.label} is temporarily refusing ${s.name}`, detail: p.reply, help });
      } else if (p.status === 'unreachable' && report) {
        issues.push({ severity: 'warning', title: `${s.name} cannot reach ${p.label} on port 25`, detail: p.reply, help });
      }
    }
    for (const l of blocklists) {
      if (l.status === 'listed') {
        const help = l.zone === 'zen.spamhaus.org' ? `https://check.spamhaus.org/results/?query=${s.ip}` : null;
        issues.push({ severity, title: `${s.name} (${s.ip}) is on ${l.name}`, detail: l.detail, help });
      } else if (l.status === 'unknown' && l.zone === 'zen.spamhaus.org' && report) {
        issues.push({ severity: 'warning', title: `Could not check ${s.name} on Spamhaus`, detail: l.detail, help: null });
      }
    }
    return { ip: s.ip, name: s.name, role: s.role, delivering: deliveringIp === s.ip, checked_at: report?.checked_at ?? null, stale, providers, blocklists };
  });

  const rejectionRows = rejections.map((r) => {
    const provider = PROVIDERS.find((p) => p.id === r.provider)!;
    const recent = now.getTime() - Date.parse(r.last_at) <= DAY_MS;
    issues.push({
      severity: recent ? 'critical' : 'warning',
      title: `${provider.label} rejected ${r.count} real message${r.count === 1 ? '' : 's'} in the last ${REJECTION_WINDOW_DAYS} days`,
      detail: r.sample,
      help: provider.help,
    });
    return { ...r, label: provider.label };
  });

  issues.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  const status: HealthStatus = issues.some((i) => i.severity === 'critical') ? 'critical' : issues.length ? 'warning' : 'ok';
  return { status, issues, delivering_ip: deliveringIp, servers, rejections: rejectionRows, generated_at: now.toISOString() };
}

const providerOfDomain = (domain: string | null): ProviderId | null => {
  if (!domain) return null;
  if (/^(gmail|googlemail)\.com$/.test(domain)) return 'google';
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return 'microsoft';
  if (/^(icloud|me|mac)\.com$/.test(domain)) return 'apple';
  return null;
};

/** Store one probe report and drop this server's old ones. */
export async function recordMailHealthReport(pool: Pool, report: ProbeReport): Promise<void> {
  await pool.query(`INSERT INTO mail_health_reports (ip, checked_at, report) VALUES ($1, $2, $3::jsonb)`, [
    report.ip,
    report.checked_at,
    JSON.stringify(report),
  ]);
  await pool.query(`DELETE FROM mail_health_reports WHERE ip = $1 AND checked_at < now() - make_interval(days => $2)`, [
    report.ip,
    KEEP_REPORTS_DAYS,
  ]);
}

/**
 * Real policy rejections per provider, across all workspaces. Deliberately
 * cross-tenant (platform-admin only, audited by the route) and aggregate: counts and
 * a redacted server reply, never an address or a workspace name.
 */
async function loadProviderRejections(pool: Pool, now: Date): Promise<ProviderRejection[]> {
  const since = new Date(now.getTime() - REJECTION_WINDOW_DAYS * DAY_MS).toISOString();
  const { rows } = await pool.query<{
    workspace_id: string;
    occurred_at: Date;
    sub_type: string;
    diagnostic: string | null;
    domain: string | null;
  }>(
    `SELECT e.workspace_id, e.occurred_at, e.sub_type, e.raw->>'diagnostic' AS diagnostic,
            lower(split_part(COALESCE(e.raw->>'recipient', p.email::text, mp.email::text), '@', 2)) AS domain
       FROM email_events e
       LEFT JOIN profiles p ON p.id = e.profile_id AND p.workspace_id = e.workspace_id
       LEFT JOIN messages_log m ON m.ses_message_id = e.ses_message_id AND m.workspace_id = e.workspace_id
       LEFT JOIN profiles mp ON mp.id = m.profile_id AND mp.workspace_id = m.workspace_id
      WHERE e.type = 'bounce' AND e.sub_type LIKE '5.7.%' AND e.occurred_at >= $1
      ORDER BY e.occurred_at DESC
      LIMIT 2000`,
    [since],
  );
  const groups = new Map<ProviderId, { count: number; workspaces: Set<string>; last: Date; sample: string | null }>();
  for (const r of rows) {
    const provider = providerOfDomain(r.domain);
    if (!provider || !isPolicyBlock(r.sub_type, r.diagnostic)) continue;
    const g = groups.get(provider) ?? { count: 0, workspaces: new Set<string>(), last: r.occurred_at, sample: null };
    g.count += 1;
    g.workspaces.add(r.workspace_id);
    g.sample ??= r.diagnostic ? redactAddresses(r.diagnostic).slice(0, MAX_REPLY_CHARS) : null;
    groups.set(provider, g);
  }
  return [...groups].map(([provider, g]) => ({
    provider,
    count: g.count,
    workspaces: g.workspaces.size,
    last_at: g.last.toISOString(),
    sample: g.sample,
  }));
}

export async function loadMailHealth(pool: Pool, now: Date) {
  const { rows } = await pool.query<{ report: ProbeReport }>(
    `SELECT DISTINCT ON (ip) report FROM mail_health_reports ORDER BY ip, checked_at DESC`,
  );
  const rejections = await loadProviderRejections(pool, now);
  return computeMailHealth({ reports: rows.map((r) => r.report), rejections, now });
}
