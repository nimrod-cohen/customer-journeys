// Real (production) dispatcher dependencies (§9).
//
// The Dispatcher connects with the SERVICE ROLE which BYPASSES RLS — so
// isolation comes from in-code workspace_id scoping (every statement binds
// workspace_id at $1), NOT RLS. The atomic outbox claim + the single-tx write
// (messages_log + usage_counters + mark-sent) live in the orchestrator; this
// module supplies the pooled reader, the prod SES client, and the tx runner.
import type { Pool, PoolClient } from 'pg';
import { getPool, decryptSecret, isEncryptedSecret } from '@cdp/db';
import { ProdSesEmailClient, unsubscribeLinkSecret } from '@cdp/email';
import { fetchChannelHttpClient, DEFAULT_CHANNEL_CONFIG, type ChannelProviderConfig } from '@cdp/channels';
import type { SqlStatement } from './core.js';
import type { HandlerDeps } from './handler.js';
import type { Reader } from './dispatch.js';

/**
 * Resolve the per-COMPANY text-channel provider config for a sending workspace —
 * the channel twin of local-api's `sesForWorkspace`. MEDIUM-AWARE: a WhatsApp send
 * reads `company_whatsapp_config` (→ a real `MetaWhatsAppProvider` config), an SMS
 * send reads `company_channel_config` (→ a real `Sms019Provider` config). The
 * secret (bearer / access token) is DECRYPTED at call time only (the wire/log never
 * carry plaintext; the stored value stays an envelope). NO row → the deterministic
 * MOCK config, so dev/tests stay green offline. Service-role scoping: the lookup
 * binds `workspace_id` and never trusts a body.
 */
export async function channelConfigForWorkspace(
  reader: Reader,
  workspaceId: string,
  medium: 'sms' | 'whatsapp' = 'sms',
): Promise<ChannelProviderConfig> {
  const dec = (s: string): string => (isEncryptedSecret(s) ? decryptSecret(s) : s);
  if (medium === 'whatsapp') {
    // Connectors first (the unified registry); fall back to the legacy per-provider
    // table for rows not yet migrated (transitional — keeps old tests green).
    const conn = await reader.query<{ config: Record<string, unknown>; secret: string | null }>(
      `SELECT c.config, c.secret FROM company_connectors c JOIN workspaces w ON w.company_id = c.company_id
        WHERE w.id = $1 AND c.channel = 'whatsapp' AND c.provider = 'meta_whatsapp' AND c.enabled
        ORDER BY c.updated_at DESC LIMIT 1`,
      [workspaceId],
    );
    const cc = conn.rows[0];
    if (cc && cc.secret) {
      const cfg = cc.config;
      return {
        kind: 'meta',
        phoneNumberId: String(cfg.phone_number_id ?? ''),
        accessToken: dec(cc.secret),
        apiVersion: (cfg.api_version as string | null) ?? null,
        defaultCountry: (cfg.default_country as string | null) ?? null,
      };
    }
    const { rows } = await reader.query<{
      phone_number_id: string;
      access_token: string;
      api_version: string | null;
      default_country: string | null;
    }>(
      `SELECT c.phone_number_id, c.access_token, c.api_version, c.default_country
         FROM company_whatsapp_config c JOIN workspaces w ON w.company_id = c.company_id
        WHERE w.id = $1`,
      [workspaceId],
    );
    const cfg = rows[0];
    if (cfg) {
      return {
        kind: 'meta',
        phoneNumberId: cfg.phone_number_id,
        accessToken: dec(cfg.access_token),
        apiVersion: cfg.api_version,
        defaultCountry: cfg.default_country ?? null,
      };
    }
    return DEFAULT_CHANNEL_CONFIG;
  }
  const conn = await reader.query<{ config: Record<string, unknown>; secret: string | null }>(
    `SELECT c.config, c.secret FROM company_connectors c JOIN workspaces w ON w.company_id = c.company_id
      WHERE w.id = $1 AND c.channel = 'sms' AND c.provider = '019' AND c.enabled
      ORDER BY c.updated_at DESC LIMIT 1`,
    [workspaceId],
  );
  const cc = conn.rows[0];
  if (cc && cc.secret) {
    const cfg = cc.config;
    return {
      kind: '019',
      apiUrl: String(cfg.api_url ?? ''),
      username: String(cfg.username ?? ''),
      source: String(cfg.source ?? ''),
      bearer: dec(cc.secret),
      defaultCountry: (cfg.default_country as string | null) ?? null,
    };
  }
  const { rows } = await reader.query<{
    provider: string;
    api_url: string;
    username: string;
    source: string;
    secret: string;
    default_country: string | null;
  }>(
    `SELECT c.provider, c.api_url, c.username, c.source, c.secret, c.default_country
       FROM company_channel_config c JOIN workspaces w ON w.company_id = c.company_id
      WHERE w.id = $1`,
    [workspaceId],
  );
  const cfg = rows[0];
  const defaultCountry = cfg?.default_country ?? null;
  if (cfg && cfg.provider === '019') {
    return { kind: '019', apiUrl: cfg.api_url, username: cfg.username, source: cfg.source, bearer: dec(cfg.secret), defaultCountry };
  }
  return defaultCountry ? { kind: 'mock', defaultCountry } : DEFAULT_CHANNEL_CONFIG;
}

/** Minimal pool surface so tests can pass an `adminPool()` directly. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Run a list of workspace-scoped statements in ONE transaction. Each statement
 * already binds workspace_id at $1 (in-code scoping; service role bypasses RLS).
 * We assert each statement's first value matches the requested workspace as a
 * defensive guard. Exported standalone so the integration tests exercise the
 * EXACT production write path against real Postgres (the messages_log +
 * usage_counters + mark-sent atomicity).
 */
export async function runStatementsInWorkspaceTx(
  pool: PoolLike,
  workspaceId: string,
  statements: readonly SqlStatement[],
): Promise<void> {
  for (const s of statements) {
    if (s.values[0] !== workspaceId) {
      throw new Error('runStatementsInWorkspaceTx: statement not scoped to the requested workspace');
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) {
      await client.query(s.text, s.values);
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Assemble the production dependency set (pooled pg, service role, prod SES). */
export function makeProdDeps(): HandlerDeps {
  const pool: Pool = getPool();
  const reader: Reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    },
  };
  return {
    reader,
    ses: new ProdSesEmailClient(),
    // Per-company text-channel provider config (a real '019' SMS gateway when the
    // sending workspace's company configured it, else the deterministic MOCK).
    resolveChannelConfig: (workspaceId, medium) => channelConfigForWorkspace(reader, workspaceId, medium),
    channelHttp: fetchChannelHttpClient(),
    runInWorkspaceTx: (workspaceId, statements) =>
      runStatementsInWorkspaceTx(pool, workspaceId, statements),
    now: () => new Date(),
    unsubscribeBaseUrl:
      process.env.UNSUBSCRIBE_BASE_URL ?? 'https://api.cdp.example/unsubscribe',
    linkTrackingBaseUrl: process.env.LINK_TRACKING_BASE_URL ?? process.env.APP_BASE_URL ?? 'https://api.cdp.example',
    unsubscribeLinkSecret: unsubscribeLinkSecret(),
  };
}
