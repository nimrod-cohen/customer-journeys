// Configuration readiness — the single source of truth for "is this workspace set up
// to send?". Computes a per-channel status (email / sms / whatsapp) plus an informational
// storage check, and derives the channel-enabled booleans that gate the broadcast composer
// + automation runner (so an incomplete channel is HARD-DISABLED, not just warned).
//
// Split into a PURE `computeReadiness(inputs)` (unit-tested exhaustively) and a thin
// `gatherReadiness(pool, workspaceId)` that reads the DB state and calls it.
import type { Pool } from 'pg';

export type ReadinessChannelId = 'email' | 'sms' | 'whatsapp' | 'storage';

/** A route the SPA can navigate to in order to fix a failing item. */
export interface ReadinessFix {
  label: string;
  route: string;
}
/** One sub-requirement of a check (e.g. "A verified sending domain"). */
export interface ReadinessItem {
  label: string;
  ok: boolean;
  fix?: ReadinessFix;
}
export interface ReadinessCheck {
  id: ReadinessChannelId;
  label: string;
  // `error` checks DISABLE the channel when not ready; `warning` is informational only.
  severity: 'error' | 'warning';
  status: 'ready' | 'incomplete' | 'not_configured';
  items: ReadinessItem[];
  summary: string;
}
export interface WorkspaceReadiness {
  checks: ReadinessCheck[];
  // Mirror of each messaging channel's readiness — consumed by the composer/runner gating.
  channels: { email: boolean; sms: boolean; whatsapp: boolean };
  errorCount: number;
  warningCount: number;
  // Split of the error count by WHERE it's fixed, for the settings-nav indicators:
  // COMPANY = connector/provider gaps (email provider, SMS, WhatsApp); WORKSPACE =
  // sending-domain gaps (a verified domain + a sender), only when email uses SES.
  companyErrorCount: number;
  workspaceErrorCount: number;
}

/** The DB-derived facts the pure computation needs. */
export interface ReadinessInputs {
  hasResendConnector: boolean;
  resendFromSet: boolean;
  hasSesConnector: boolean;
  verifiedDomainCount: number;
  senderCount: number;
  hasSmsConnector: boolean;
  hasWhatsappConnector: boolean;
  r2Configured: boolean;
}

const ROUTE_CONNECTORS = '/company/connectors';
const ROUTE_DOMAINS = '/settings/domains';
const ROUTE_STORAGE = '/company/storage';
const FIX_CONNECTORS: ReadinessFix = { label: 'Open Connectors', route: ROUTE_CONNECTORS };
const FIX_DOMAINS: ReadinessFix = { label: 'Open Sending domains', route: ROUTE_DOMAINS };
const FIX_STORAGE: ReadinessFix = { label: 'Open Storage', route: ROUTE_STORAGE };

/** Pure: turn the DB facts into the readiness report. No I/O. */
export function computeReadiness(i: ReadinessInputs): WorkspaceReadiness {
  const email = computeEmail(i);
  const sms = computeSimpleChannel(
    'sms',
    'SMS',
    i.hasSmsConnector,
    'SMS provider (019) connected',
    'Connect an SMS provider (019) under Connectors.',
    'Ready to send SMS.',
  );
  const whatsapp = computeSimpleChannel(
    'whatsapp',
    'WhatsApp',
    i.hasWhatsappConnector,
    'WhatsApp provider (Meta) connected',
    'Connect a Meta WhatsApp provider under Connectors.',
    'Ready to send WhatsApp.',
  );
  const storage = computeStorage(i.r2Configured);

  const checks = [email, sms, whatsapp, storage];
  const errorCount = checks.filter((c) => c.severity === 'error' && c.status !== 'ready').length;
  const warningCount = checks.filter((c) => c.severity === 'warning' && c.status !== 'ready').length;

  // Scope split for the settings-nav indicators.
  const resendReady = i.hasResendConnector && i.resendFromSet;
  const emailProviderOk = resendReady || i.hasSesConnector; // a provider is CONNECTED (company-level)
  const companyErrorCount =
    (emailProviderOk ? 0 : 1) + (i.hasSmsConnector ? 0 : 1) + (i.hasWhatsappConnector ? 0 : 1);
  // Sending-domain gaps (a verified domain + a sender) are shown UNLESS email is already
  // covered by a ready Resend connector (Resend verifies its own domain, so no in-app
  // sending domain is needed). Otherwise — including when NO email provider is connected
  // yet — a missing sending domain / sender is a real workspace-level gap to surface.
  const workspaceErrorCount = resendReady
    ? 0
    : (i.verifiedDomainCount > 0 ? 0 : 1) + (i.senderCount > 0 ? 0 : 1);

  return {
    checks,
    channels: { email: email.status === 'ready', sms: sms.status === 'ready', whatsapp: whatsapp.status === 'ready' },
    errorCount,
    warningCount,
    companyErrorCount,
    workspaceErrorCount,
  };
}

function computeEmail(i: ReadinessInputs): ReadinessCheck {
  const hasProvider = i.hasResendConnector || i.hasSesConnector;
  const items: ReadinessItem[] = [
    { label: 'Email provider connected (Amazon SES or Resend)', ok: hasProvider, fix: FIX_CONNECTORS },
  ];

  // Resend is trusted (domain verified in Resend's dashboard); it only needs a From.
  if (i.hasResendConnector) {
    items.push({ label: 'Resend “From” address set', ok: i.resendFromSet, fix: FIX_CONNECTORS });
    const ready = i.resendFromSet;
    return {
      id: 'email',
      label: 'Email',
      severity: 'error',
      status: ready ? 'ready' : 'incomplete',
      items,
      summary: ready ? 'Ready to send email (Resend).' : 'Set your Resend “From” address under Connectors.',
    };
  }

  // SES path: needs a verified sending domain AND a named sender.
  const domainOk = i.verifiedDomainCount > 0;
  const senderOk = i.senderCount > 0;
  items.push({ label: 'A verified sending domain', ok: i.hasSesConnector && domainOk, fix: FIX_DOMAINS });
  items.push({ label: 'A sender address (From)', ok: i.hasSesConnector && senderOk, fix: FIX_DOMAINS });

  const ready = i.hasSesConnector && domainOk && senderOk;
  let summary: string;
  if (!hasProvider) summary = 'Connect an email provider (Amazon SES or Resend) under Connectors.';
  else if (!domainOk) summary = 'Verify a sending domain under Workspace settings → Sending domains.';
  else if (!senderOk) summary = 'Add a sender address (From) for your verified domain.';
  else summary = 'Ready to send email.';

  return {
    id: 'email',
    label: 'Email',
    severity: 'error',
    status: ready ? 'ready' : hasProvider ? 'incomplete' : 'not_configured',
    items,
    summary,
  };
}

function computeSimpleChannel(
  id: 'sms' | 'whatsapp',
  label: string,
  connected: boolean,
  itemLabel: string,
  missingSummary: string,
  readySummary: string,
): ReadinessCheck {
  return {
    id,
    label,
    severity: 'error',
    status: connected ? 'ready' : 'not_configured',
    items: [{ label: itemLabel, ok: connected, fix: FIX_CONNECTORS }],
    summary: connected ? readySummary : missingSummary,
  };
}

function computeStorage(r2Configured: boolean): ReadinessCheck {
  return {
    id: 'storage',
    label: 'Image storage',
    severity: 'warning',
    status: r2Configured ? 'ready' : 'not_configured',
    items: [{ label: 'Cloudflare R2 connected', ok: r2Configured, fix: FIX_STORAGE }],
    summary: r2Configured
      ? 'Images are stored in Cloudflare R2.'
      : 'Images are stored in the database. Connect Cloudflare R2 for CDN-backed storage.',
  };
}

/** Read the workspace's (and its company's) config state and compute readiness. */
export async function gatherReadiness(pool: Pool, workspaceId: string): Promise<WorkspaceReadiness> {
  const { rows: wsRows } = await pool.query<{ company_id: string | null }>(
    'SELECT company_id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  const companyId = wsRows[0]?.company_id ?? null;
  if (!companyId) {
    return computeReadiness({
      hasResendConnector: false,
      resendFromSet: false,
      hasSesConnector: false,
      verifiedDomainCount: 0,
      senderCount: 0,
      hasSmsConnector: false,
      hasWhatsappConnector: false,
      r2Configured: false,
    });
  }

  const { rows: conns } = await pool.query<{ channel: string; provider: string; config: Record<string, unknown> }>(
    'SELECT channel, provider, config FROM company_connectors WHERE company_id = $1 AND enabled',
    [companyId],
  );
  const resend = conns.find((c) => c.channel === 'email' && c.provider === 'resend');
  const hasResendConnector = !!resend;
  const resendFromSet = !!resend && typeof resend.config?.['from'] === 'string' && (resend.config['from'] as string).trim() !== '';
  const hasSesConnector = conns.some((c) => c.channel === 'email' && c.provider === 'ses');
  const hasSmsConnector = conns.some((c) => c.channel === 'sms' && c.provider === '019');
  const hasWhatsappConnector = conns.some((c) => c.channel === 'whatsapp' && c.provider === 'meta_whatsapp');

  const [dom, snd, r2] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM sending_domains WHERE workspace_id = $1 AND verified', [workspaceId]),
    pool.query('SELECT count(*)::int AS n FROM domain_senders WHERE workspace_id = $1', [workspaceId]),
    pool.query('SELECT 1 FROM company_r2_config WHERE company_id = $1 LIMIT 1', [companyId]),
  ]);

  return computeReadiness({
    hasResendConnector,
    resendFromSet,
    hasSesConnector,
    verifiedDomainCount: (dom.rows[0] as { n: number }).n,
    senderCount: (snd.rows[0] as { n: number }).n,
    hasSmsConnector,
    hasWhatsappConnector,
    r2Configured: (r2.rowCount ?? 0) > 0,
  });
}
