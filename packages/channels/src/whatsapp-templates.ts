// WhatsApp message-template MANAGEMENT over the Meta Graph API (§10). Templates are
// created/approved at the WhatsApp Business ACCOUNT (WABA) level, then referenced by a
// broadcast/campaign send. This module is a thin, INJECTABLE proxy to the Graph API:
//   list   → GET    /<version>/<WABA_ID>/message_templates
//   create → POST   /<version>/<WABA_ID>/message_templates   (submits for Meta approval)
//   delete → DELETE /<version>/<WABA_ID>/message_templates?name=<name>
// The HTTP client is injected so unit/integration tests assert the exact Graph request +
// map responses WITHOUT touching graph.facebook.com (mirrors MetaWhatsAppProvider). The
// access token is passed in already-decrypted (the caller decrypts at call time only).

import { DEFAULT_META_API_VERSION } from './index.js';

/** Credentials + endpoint for the Graph templates API (token decrypted by the caller). */
export interface WhatsAppTemplatesConfig {
  readonly wabaId: string;
  readonly accessToken: string;
  readonly apiUrl?: string | null;
  readonly apiVersion?: string | null;
}

/** Meta template approval status (as returned by the Graph API). */
export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'IN_APPEAL' | string;

/** A message template as summarized for the app (from the Graph list response). */
export interface WhatsAppTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: TemplateStatus;
  readonly category: string;
  /** The BODY component text (with {{1}},{{2}}… placeholders), '' when none. */
  readonly body: string;
  /** How many {{n}} variables the body has (drives the send-side param mapping). */
  readonly variableCount: number;
}

/** Input to CREATE a template (BODY-only v1; header/footer/buttons are a follow-up). */
export interface CreateTemplateInput {
  /** Lowercase letters, digits, and underscores only (Meta requirement). */
  readonly name: string;
  readonly language: string;
  /** MARKETING | UTILITY | AUTHENTICATION. */
  readonly category: string;
  /** The body text with {{1}},{{2}}… placeholders. */
  readonly body: string;
  /** One example value per {{n}} variable, in order (Meta requires examples). */
  readonly examples: readonly string[];
}

/** A generic HTTP client (GET/POST/DELETE) for the Graph API — injected for offline tests. */
export interface GraphHttpResponse {
  readonly status: number;
  readonly body: string;
}
export interface GraphHttpClient {
  request(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
  ): Promise<GraphHttpResponse>;
}

/** The production fetch-based Graph client, bounded by an AbortController timeout. */
export function fetchGraphHttpClient(): GraphHttpClient {
  return {
    async request(method, url, headers, body, timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const init: RequestInit = { method, headers, signal: ctrl.signal };
        if (body !== null) init.body = body;
        const res = await fetch(url, init);
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

function baseUrl(cfg: WhatsAppTemplatesConfig): string {
  const base = (cfg.apiUrl && cfg.apiUrl.trim() ? cfg.apiUrl : 'https://graph.facebook.com').replace(/\/+$/, '');
  const version = cfg.apiVersion && cfg.apiVersion.trim() ? cfg.apiVersion : DEFAULT_META_API_VERSION;
  return `${base}/${version}/${cfg.wabaId}/message_templates`;
}

function authHeaders(cfg: WhatsAppTemplatesConfig): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.accessToken}` };
}

/** Extract Meta's error message from a Graph error body (best-effort). */
function metaError(status: number, body: string): Error {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof j.error?.message === 'string') return new Error(`Meta WhatsApp templates: HTTP ${status} — ${j.error.message}`);
  } catch {
    /* not JSON */
  }
  return new Error(`Meta WhatsApp templates: HTTP ${status} — ${body.slice(0, 200)}`);
}

/** Count `{{1}}`,`{{2}}`… placeholders in a template body. */
export function countTemplateVariables(text: string): number {
  const set = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) set.add(m[1]!);
  return set.size;
}

/** Parse a Graph list response into app summaries (BODY component text + variable count). */
export function parseTemplatesList(body: string): WhatsAppTemplateSummary[] {
  let j: { data?: unknown };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    return [];
  }
  const data = Array.isArray(j.data) ? j.data : [];
  const out: WhatsAppTemplateSummary[] = [];
  for (const raw of data) {
    const t = raw as {
      id?: unknown;
      name?: unknown;
      language?: unknown;
      status?: unknown;
      category?: unknown;
      components?: unknown;
    };
    const components = Array.isArray(t.components) ? t.components : [];
    const bodyComp = components.find((c) => (c as { type?: unknown }).type === 'BODY') as { text?: unknown } | undefined;
    const text = typeof bodyComp?.text === 'string' ? bodyComp.text : '';
    out.push({
      id: typeof t.id === 'string' ? t.id : '',
      name: typeof t.name === 'string' ? t.name : '',
      language: typeof t.language === 'string' ? t.language : '',
      status: typeof t.status === 'string' ? t.status : 'UNKNOWN',
      category: typeof t.category === 'string' ? t.category : '',
      body: text,
      variableCount: countTemplateVariables(text),
    });
  }
  return out;
}

/** LIST the WABA's message templates (all statuses). Throws on a non-2xx (Meta error). */
export async function listWhatsAppTemplates(
  cfg: WhatsAppTemplatesConfig,
  http: GraphHttpClient = fetchGraphHttpClient(),
): Promise<WhatsAppTemplateSummary[]> {
  const url = `${baseUrl(cfg)}?limit=200`;
  const res = await http.request('GET', url, authHeaders(cfg), null, DEFAULT_TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) throw metaError(res.status, res.body);
  return parseTemplatesList(res.body);
}

/** Build the Graph CREATE request body for a BODY-only template (submits for approval). */
export function buildCreateTemplateBody(input: CreateTemplateInput): string {
  const component: Record<string, unknown> = { type: 'BODY', text: input.body };
  // Meta requires an example value per {{n}} variable when the body has placeholders.
  const varCount = countTemplateVariables(input.body);
  if (varCount > 0) {
    const examples = input.examples.slice(0, varCount);
    while (examples.length < varCount) examples.push('example');
    component.example = { body_text: [examples] };
  }
  return JSON.stringify({
    name: input.name,
    language: input.language,
    category: input.category,
    components: [component],
  });
}

/** CREATE (submit) a template for Meta approval. Returns the new id + status ('PENDING'). */
export async function createWhatsAppTemplate(
  cfg: WhatsAppTemplatesConfig,
  input: CreateTemplateInput,
  http: GraphHttpClient = fetchGraphHttpClient(),
): Promise<{ id: string; status: TemplateStatus; category: string }> {
  const res = await http.request('POST', baseUrl(cfg), authHeaders(cfg), buildCreateTemplateBody(input), DEFAULT_TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) throw metaError(res.status, res.body);
  const j = JSON.parse(res.body) as { id?: unknown; status?: unknown; category?: unknown };
  return {
    id: typeof j.id === 'string' ? j.id : '',
    status: typeof j.status === 'string' ? j.status : 'PENDING',
    category: typeof j.category === 'string' ? j.category : input.category,
  };
}

/** DELETE a template by name (removes ALL its language versions). */
export async function deleteWhatsAppTemplate(
  cfg: WhatsAppTemplatesConfig,
  name: string,
  http: GraphHttpClient = fetchGraphHttpClient(),
): Promise<void> {
  const url = `${baseUrl(cfg)}?name=${encodeURIComponent(name)}`;
  const res = await http.request('DELETE', url, authHeaders(cfg), null, DEFAULT_TIMEOUT_MS);
  if (res.status < 200 || res.status >= 300) throw metaError(res.status, res.body);
}
