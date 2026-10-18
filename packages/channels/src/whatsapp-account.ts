// WhatsApp ACCOUNT checks over the Meta Graph API, run when a workspace saves its
// WhatsApp config:
//   phone number → GET  /<version>/<PHONE_NUMBER_ID>?fields=…   (proves the token + id)
//   subscribe    → POST /<version>/<WABA_ID>/subscribed_apps    (routes the WABA's
//                  webhooks to OUR platform app — without it no inbound message or
//                  delivery status ever reaches us)
// Same injectable GraphHttpClient as the templates module, so tests never touch Meta.

import { DEFAULT_META_API_VERSION } from './index.js';
import { fetchGraphHttpClient, type GraphHttpClient } from './whatsapp-templates.js';

/** Credentials for the account checks (token decrypted by the caller). */
export interface WhatsAppAccountConfig {
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly accessToken: string;
  readonly apiUrl?: string | null;
  readonly apiVersion?: string | null;
}

export interface WhatsAppPhoneNumberInfo {
  readonly displayPhoneNumber: string | null;
  readonly verifiedName: string | null;
  readonly qualityRating: string | null;
}

const TIMEOUT_MS = 15_000;

function root(cfg: WhatsAppAccountConfig): string {
  const base = (cfg.apiUrl && cfg.apiUrl.trim() ? cfg.apiUrl : 'https://graph.facebook.com').replace(/\/+$/, '');
  const version = cfg.apiVersion && cfg.apiVersion.trim() ? cfg.apiVersion : DEFAULT_META_API_VERSION;
  return `${base}/${version}`;
}

function headers(cfg: WhatsAppAccountConfig): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.accessToken}` };
}

function graphError(what: string, status: number, body: string): Error {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof j.error?.message === 'string') return new Error(`Meta WhatsApp ${what}: ${j.error.message}`);
  } catch {
    /* not JSON */
  }
  return new Error(`Meta WhatsApp ${what}: HTTP ${status}`);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Read the phone number's public details. Throws Meta's message on failure. */
export async function fetchWhatsAppPhoneNumber(
  cfg: WhatsAppAccountConfig,
  http: GraphHttpClient = fetchGraphHttpClient(),
): Promise<WhatsAppPhoneNumberInfo> {
  const url = `${root(cfg)}/${encodeURIComponent(cfg.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`;
  const res = await http.request('GET', url, headers(cfg), null, TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) throw graphError('phone number check', res.status, res.body);
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* empty body → all null */
  }
  return {
    displayPhoneNumber: str(j.display_phone_number),
    verifiedName: str(j.verified_name),
    qualityRating: str(j.quality_rating),
  };
}

/** Subscribe our app to the WABA's webhooks. Idempotent on Meta's side. */
export async function subscribeAppToWaba(
  cfg: WhatsAppAccountConfig,
  http: GraphHttpClient = fetchGraphHttpClient(),
): Promise<void> {
  const url = `${root(cfg)}/${encodeURIComponent(cfg.wabaId)}/subscribed_apps`;
  const res = await http.request('POST', url, headers(cfg), null, TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) throw graphError('webhook subscription', res.status, res.body);
  let ok = false;
  try {
    ok = (JSON.parse(res.body) as { success?: unknown }).success === true;
  } catch {
    /* fall through */
  }
  if (!ok) throw new Error('Meta WhatsApp webhook subscription: Meta did not confirm the subscribe');
}
