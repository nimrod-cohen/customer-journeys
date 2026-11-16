// The MCP tool set. DRAFTS ONLY by design: an assistant may read and draft, never
// publish, enroll, send, schedule or delete — those stay human.
//
// Every tool goes through the SAME route handlers the SPA uses (rt.call), so all
// validation, workspace scoping (inv.1/2) and capability checks are reused rather
// than re-implemented. A few tools add guards on top where a handler would
// otherwise let a draft-only caller change something live (noted inline).
//
// Profile data is deliberately NOT exposed: tools return definitions and counts,
// never people's emails or phones.
import type { Pool } from 'pg';
import type { WorkspaceContext } from '@cdp/shared';
import { scopedQuery } from '@cdp/db';
import { enforceRoute } from '@cdp/service-api';
import { HANDLERS, type HandlerResponse } from '../handlers.js';
import { capabilityForRoute } from '../routes.js';
import type { LocalApiDeps } from '../deps.js';
import { ToolError, type JsonSchema, type McpTool } from './protocol.js';
import { AUTHORING_GUIDE } from './guide.js';

/** What a tool runs with. */
export interface ToolRuntime {
  readonly ctx: WorkspaceContext;
  readonly pool: Pool;
  /** Call an API route as the token's principal; throws ToolError on a non-2xx. */
  call(route: string, opts?: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> }): Promise<Record<string, unknown>>;
}

/** Build a runtime that invokes route handlers in-process. */
export function makeToolRuntime(ctx: WorkspaceContext, pool: Pool, deps: LocalApiDeps): ToolRuntime {
  return {
    ctx,
    pool,
    async call(route, opts = {}) {
      const handler = HANDLERS[route];
      const capability = capabilityForRoute(route);
      if (!handler || !capability) throw new Error(`no such route: ${route}`);
      try {
        enforceRoute(ctx, capability);
      } catch {
        throw new ToolError(`not allowed: ${route} requires ${capability}`);
      }
      const res: HandlerResponse = await handler(ctx, pool, { params: opts.params ?? {}, query: opts.query ?? {}, body: opts.body ?? {} }, deps);
      const body = (res.body && typeof res.body === 'object' ? res.body : {}) as Record<string, unknown>;
      if (res.status >= 300) {
        const detail = typeof body.error === 'string' ? body.error : `request failed (${res.status})`;
        const extra = body.node ? ` (node ${String(body.node)})` : '';
        throw new ToolError(`${detail}${extra}`);
      }
      return body;
    },
  };
}

// ── schema helpers ──────────────────────────────────────────────────────────
const str = (description: string): JsonSchema => ({ type: 'string', description });
const obj = (description: string): JsonSchema => ({ type: 'object', description });
const args = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const pageArgs = {
  page: { type: 'integer', description: 'Page number, from 1.' } as JsonSchema,
  limit: { type: 'integer', description: 'Page size (default 50, max 200).' } as JsonSchema,
};
function pageQuery(a: Record<string, unknown>): Record<string, string> {
  const limit = Math.min(Math.max(Number(a.limit ?? 50) || 50, 1), 200);
  const page = Math.max(Number(a.page ?? 1) || 1, 1);
  return { limit: String(limit), page: String(page) };
}
const s = (v: unknown): string => String(v);

/** Keep only these keys of each row (drop heavy or sensitive columns). */
function pick<T extends Record<string, unknown>>(rows: unknown, keys: readonly string[]): T[] {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (r && typeof r === 'object' && k in r) o[k] = (r as Record<string, unknown>)[k];
    return o as T;
  });
}

// ── guards ──────────────────────────────────────────────────────────────────
/** An email template id is safe to edit only while nothing LIVE sends it. */
async function assertTemplateIsDraftOnly(rt: ToolRuntime, templateId: string): Promise<void> {
  const t = scopedQuery(rt.ctx.workspaceId, 'SELECT kind, transactional_key FROM email_templates WHERE id::text = $1', [templateId]);
  const row = (await rt.pool.query<{ kind: string; transactional_key: string | null }>(t.text, t.values)).rows[0];
  if (!row) throw new ToolError('template not found');
  if (row.kind !== 'copy') throw new ToolError('only a broadcast/automation email copy can be edited here, not a library template');
  if (row.transactional_key) throw new ToolError('this template is sent by the transactional API — edit it in the app');
  const a = scopedQuery(
    rt.ctx.workspaceId,
    `SELECT 1 FROM automations WHERE status IN ('active', 'paused') AND definition::text LIKE '%' || $1 || '%'`,
    [templateId],
  );
  if ((await rt.pool.query(a.text, a.values)).rowCount) {
    throw new ToolError('this email is used by a published automation — edits there go live immediately, so make them in the app');
  }
  const b = scopedQuery(rt.ctx.workspaceId, `SELECT 1 FROM broadcasts WHERE template_id::text = $1 AND status <> 'draft'`, [templateId]);
  if ((await rt.pool.query(b.text, b.values)).rowCount) {
    throw new ToolError('this email belongs to a scheduled or sent broadcast — only drafts can be edited here');
  }
}

async function loadDraftBroadcast(rt: ToolRuntime, id: string): Promise<Record<string, unknown>> {
  const r = await rt.call('GET /broadcasts/:id', { params: { id } });
  const b = r.broadcast as Record<string, unknown>;
  if (b.status !== 'draft') {
    throw new ToolError(`this broadcast is ${String(b.status)} — only drafts can be edited here; scheduling and sending stay in the app`);
  }
  return b;
}

/** Clone a library email template into a fresh working copy; returns the copy id. */
async function cloneTemplate(rt: ToolRuntime, templateId: string): Promise<string> {
  const r = await rt.call('POST /templates/:id/clone', { params: { id: templateId }, body: {} });
  return s((r.template as { id: string }).id);
}

// ── tools ───────────────────────────────────────────────────────────────────
type Tool = McpTool<ToolRuntime>;

const read = (t: Omit<Tool, 'readOnly'>): Tool => ({ ...t, readOnly: true });
const write = (t: Omit<Tool, 'readOnly'>): Tool => ({ ...t, readOnly: false });

export const MCP_TOOLS: readonly Tool[] = [
  read({
    name: 'get_authoring_guide',
    title: 'Authoring guide',
    description:
      'How automations, exit rules, segment rules, merge tags and broadcasts are written, and what this connection may do. Read this before drafting anything.',
    inputSchema: args({}),
    run: async () => ({ guide: AUTHORING_GUIDE }),
  }),
  read({
    name: 'get_workspace_overview',
    title: 'Workspace overview',
    description: 'Which channels (email/sms/whatsapp) can send, plus counts of automations, broadcasts and segments.',
    inputSchema: args({}),
    run: async (_a, rt) => {
      const [channels, autos, bcs, segs] = await Promise.all([
        rt.call('GET /company/channels'),
        rt.call('GET /automations', { query: { limit: '1' } }),
        rt.call('GET /broadcasts', { query: { limit: '1' } }),
        rt.call('GET /segments', { query: { limit: '1' } }),
      ]);
      return {
        workspace_id: rt.ctx.workspaceId,
        channels: channels.channels ?? channels,
        automations: autos.total,
        broadcasts: bcs.total,
        segments: segs.total,
      };
    },
  }),

  // ── automations ──
  read({
    name: 'list_automations',
    title: 'List automations',
    description: 'Automations with their status (draft/active/paused/archived) and enrollment counts.',
    inputSchema: args({ ...pageArgs }),
    run: async (a, rt) => rt.call('GET /automations', { query: pageQuery(a) }),
  }),
  read({
    name: 'get_automation',
    title: 'Get automation',
    description:
      'One automation: `definition` is the DRAFT being edited, `liveDefinition` what is running, plus status, trigger segment and the workspace timezone.',
    inputSchema: args({ automation_id: str('Automation id.') }, ['automation_id']),
    run: async (a, rt) => rt.call('GET /automations/:id', { params: { id: s(a.automation_id) } }),
  }),
  read({
    name: 'list_automation_versions',
    title: 'Automation versions',
    description: 'Published versions of an automation, newest first.',
    inputSchema: args({ automation_id: str('Automation id.') }, ['automation_id']),
    run: async (a, rt) => rt.call('GET /automations/:id/versions', { params: { id: s(a.automation_id) } }),
  }),
  read({
    name: 'get_automation_journey_stats',
    title: 'Journey stats',
    description: 'How many people are in each state and at each step of an automation, and why people exited early. Counts only — no personal data.',
    inputSchema: args({ automation_id: str('Automation id.') }, ['automation_id']),
    run: async (a, rt) => {
      const r = await rt.call('GET /automations/:id/enrollments', { params: { id: s(a.automation_id) } });
      const rows = (r.enrollments as { status: string; current_node: string; exit_reason?: string | null; restarts?: number }[]) ?? [];
      const by = (f: (x: (typeof rows)[number]) => string | null | undefined) => {
        const out: Record<string, number> = {};
        for (const x of rows) {
          const k = f(x);
          if (k) out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      };
      return {
        sampled: rows.length,
        note: 'Based on the 200 most recent enrollments.',
        by_status: by((x) => x.status),
        active_by_step: by((x) => (x.status === 'active' ? x.current_node : null)),
        exit_reasons: by((x) => x.exit_reason ?? null),
        restarted: rows.filter((x) => (x.restarts ?? 0) > 0).length,
      };
    },
  }),
  write({
    name: 'create_automation',
    title: 'Create automation (draft)',
    description:
      'Create a new automation as a DRAFT (never active). For a segment trigger pass trigger_segment_id (+ trigger_on). A person publishes it in the app.',
    inputSchema: args(
      {
        name: str('Name.'),
        description: str('Optional description.'),
        definition: obj('The automation definition — see get_authoring_guide.'),
        trigger_segment_id: str('Segment id for a segment_entry trigger.'),
        trigger_on: { type: 'string', enum: ['enter', 'exit'], description: 'Fire on entering (default) or leaving the segment.' },
      },
      ['name', 'definition'],
    ),
    run: async (a, rt) => {
      const r = await rt.call('POST /automations', {
        body: {
          name: a.name,
          definition: a.definition,
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.trigger_segment_id !== undefined ? { trigger_segment_id: a.trigger_segment_id } : {}),
          ...(a.trigger_on !== undefined ? { trigger_on: a.trigger_on } : {}),
        },
      });
      return { ...r, next_step: 'Draft created. A person must open it in the app and Save & publish to make it live.' };
    },
  }),
  write({
    name: 'save_automation_draft',
    title: 'Save automation draft',
    description:
      'Replace the DRAFT definition of an automation (the live one keeps running untouched until a person publishes). Pass the WHOLE definition, exit rules included. The trigger segment is kept unless you pass a new one.',
    inputSchema: args(
      {
        automation_id: str('Automation id.'),
        definition: obj('The full draft definition.'),
        trigger_segment_id: str('Segment id for a segment_entry trigger (omit to keep the current one).'),
        trigger_on: { type: 'string', enum: ['enter', 'exit'], description: 'Omit to keep the current direction.' },
      },
      ['automation_id', 'definition'],
    ),
    run: async (a, rt) => {
      const id = s(a.automation_id);
      // The draft writer CLEARS the draft trigger when it is absent — carry the
      // current one over so a definition-only edit cannot silently drop it.
      const cur = (await rt.call('GET /automations/:id', { params: { id } })).automation as Record<string, unknown>;
      const seg = a.trigger_segment_id !== undefined ? a.trigger_segment_id : cur.trigger_segment_id;
      await rt.call('PUT /automations/:id/draft', {
        params: { id },
        body: {
          definition: a.definition,
          trigger_on: a.trigger_on ?? cur.trigger_on ?? 'enter',
          ...(seg ? { trigger_segment_id: seg } : {}),
        },
      });
      return { saved: true, automation_id: id, next_step: 'Draft saved. A person publishes it from the automation page.' };
    },
  }),
  write({
    name: 'rename_automation',
    title: 'Rename automation',
    description: 'Change an automation’s name and/or description (nothing else).',
    inputSchema: args({ automation_id: str('Automation id.'), name: str('New name.'), description: str('New description.') }, ['automation_id']),
    run: async (a, rt) => {
      // Only name/description are forwarded: the same route also accepts a live
      // definition and a status, which a draft-only caller must never reach.
      const body: Record<string, unknown> = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.description !== undefined) body.description = a.description;
      if (Object.keys(body).length === 0) throw new ToolError('nothing to change');
      return rt.call('PUT /automations/:id', { params: { id: s(a.automation_id) }, body });
    },
  }),
  write({
    name: 'attach_email_to_automation_step',
    title: 'Attach email to a send step',
    description:
      'Give an email send node its own copy of a library template (in the DRAFT). Save the draft with the node first. Then set its subject/From with set_email_envelope.',
    inputSchema: args(
      { automation_id: str('Automation id.'), node_id: str('The send node id.'), template_id: str('Library email template id (list_email_templates).') },
      ['automation_id', 'node_id', 'template_id'],
    ),
    run: async (a, rt) => {
      const id = s(a.automation_id);
      // The attach handler writes into the draft only when a draft row exists —
      // otherwise into the LIVE definition. Pin a draft first so it never goes live.
      const cur = (await rt.call('GET /automations/:id', { params: { id } })).automation as Record<string, unknown>;
      await rt.call('PUT /automations/:id/draft', {
        params: { id },
        body: {
          definition: cur.definition,
          trigger_on: cur.trigger_on ?? 'enter',
          ...(cur.trigger_segment_id ? { trigger_segment_id: cur.trigger_segment_id } : {}),
        },
      });
      return rt.call('POST /automations/:id/send-nodes/:nodeId/attach-template', {
        params: { id, nodeId: s(a.node_id) },
        body: { template_id: a.template_id },
      });
    },
  }),

  // ── segments ──
  read({
    name: 'list_segments',
    title: 'List segments',
    description: 'Segments with their kind and member counts.',
    inputSchema: args({ ...pageArgs }),
    run: async (a, rt) => rt.call('GET /segments', { query: pageQuery(a) }),
  }),
  read({
    name: 'get_segment',
    title: 'Get segment',
    description: 'One segment including its rule definition.',
    inputSchema: args({ segment_id: str('Segment id.') }, ['segment_id']),
    run: async (a, rt) => rt.call('GET /segments/:id', { params: { id: s(a.segment_id) } }),
  }),
  read({
    name: 'count_rule_audience',
    title: 'Count a rule’s audience',
    description: 'How many profiles match a rule right now (no personal data returned). Use it to sanity-check a segment or audience before saving.',
    inputSchema: args({ definition: obj('A rule — see get_authoring_guide.') }, ['definition']),
    run: async (a, rt) => {
      const r = await rt.call('POST /segments/preview', { body: { definition: a.definition } });
      return { matching_profiles: r.size };
    },
  }),
  write({
    name: 'create_segment',
    title: 'Create segment',
    description:
      'Create a new dynamic segment from a rule. New segments affect nothing until used. (Existing segments are not edited here — they may drive live automations.)',
    inputSchema: args({ name: str('Name.'), description: str('Optional description.'), definition: obj('The rule.') }, ['name', 'definition']),
    run: async (a, rt) =>
      rt.call('POST /segments', {
        body: { name: a.name, definition: a.definition, kind: 'dynamic_realtime', ...(a.description !== undefined ? { description: a.description } : {}) },
      }),
  }),

  // ── broadcasts ──
  read({
    name: 'list_broadcasts',
    title: 'List broadcasts',
    description: 'Broadcasts with status (draft/scheduled/sending/sent) and delivery funnel stats.',
    inputSchema: args({ ...pageArgs }),
    run: async (a, rt) => rt.call('GET /broadcasts', { query: pageQuery(a) }),
  }),
  read({
    name: 'get_broadcast',
    title: 'Get broadcast',
    description: 'One broadcast with its audience, medium, template and schedule.',
    inputSchema: args({ broadcast_id: str('Broadcast id.') }, ['broadcast_id']),
    run: async (a, rt) => rt.call('GET /broadcasts/:id', { params: { id: s(a.broadcast_id) } }),
  }),
  write({
    name: 'create_broadcast',
    title: 'Create broadcast (draft)',
    description:
      'Create a broadcast DRAFT (never scheduled or sent). Audience: a rule (`audience`) or a segment id (`segment_id`). Email: pass a library template_id — it is cloned into the broadcast’s own copy. SMS/WhatsApp: pass text_body.',
    inputSchema: args(
      {
        name: str('Name.'),
        medium: { type: 'string', enum: ['email', 'sms', 'whatsapp'], description: 'Default email.' },
        audience: obj('Audience rule (see get_authoring_guide).'),
        segment_id: str('Or: send to this segment.'),
        template_id: str('Email: library template id to clone.'),
        text_body: str('SMS/WhatsApp: the message (merge tags allowed).'),
        topic_id: str('Optional topic id (list_topics).'),
      },
      ['name'],
    ),
    run: async (a, rt) => {
      if (a.audience !== undefined && a.segment_id !== undefined) throw new ToolError('pass either audience or segment_id, not both');
      const copyId = a.template_id !== undefined ? await cloneTemplate(rt, s(a.template_id)) : undefined;
      // No scheduled_at, ever: the row is created as a draft.
      const r = await rt.call('POST /broadcasts', {
        body: {
          name: a.name,
          medium: a.medium ?? 'email',
          ...(a.audience !== undefined ? { audience: a.audience } : {}),
          ...(a.segment_id !== undefined ? { audience_kind: 'segment', audience_ref: a.segment_id } : {}),
          ...(copyId ? { template_id: copyId } : {}),
          ...(a.text_body !== undefined ? { text_body: a.text_body } : {}),
          ...(a.topic_id !== undefined ? { topic_id: a.topic_id } : {}),
        },
      });
      return {
        ...r,
        ...(copyId ? { email_copy_id: copyId } : {}),
        next_step: copyId
          ? 'Draft created. Set the From/subject with set_email_envelope (email_copy_id); a person schedules or sends it in the app.'
          : 'Draft created. A person schedules or sends it in the app.',
      };
    },
  }),
  write({
    name: 'update_broadcast_draft',
    title: 'Update broadcast draft',
    description: 'Edit a DRAFT broadcast (name, audience, medium, text, topic, or swap its email by cloning another library template). Scheduled/sent broadcasts are refused.',
    inputSchema: args(
      {
        broadcast_id: str('Broadcast id.'),
        name: str('Name.'),
        medium: { type: 'string', enum: ['email', 'sms', 'whatsapp'] },
        audience: obj('Audience rule.'),
        segment_id: str('Or: a segment id.'),
        template_id: str('Email: a LIBRARY template id to clone in as the new email.'),
        text_body: str('SMS/WhatsApp message.'),
        topic_id: str('Topic id.'),
      },
      ['broadcast_id'],
    ),
    run: async (a, rt) => {
      const id = s(a.broadcast_id);
      const cur = await loadDraftBroadcast(rt, id);
      if (a.audience !== undefined && a.segment_id !== undefined) throw new ToolError('pass either audience or segment_id, not both');
      const copyId = a.template_id !== undefined ? await cloneTemplate(rt, s(a.template_id)) : undefined;
      // The update route overwrites template_id and scheduled_at unconditionally —
      // carry the current template over and never send a schedule (stays a draft).
      await rt.call('PUT /broadcasts/:id', {
        params: { id },
        body: {
          template_id: copyId ?? cur.template_id ?? null,
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.medium !== undefined ? { medium: a.medium } : {}),
          ...(a.audience !== undefined ? { audience: a.audience } : {}),
          ...(a.segment_id !== undefined ? { audience: null, audience_kind: 'segment', audience_ref: a.segment_id } : {}),
          ...(a.text_body !== undefined ? { text_body: a.text_body } : {}),
          ...(a.topic_id !== undefined ? { topic_id: a.topic_id } : {}),
        },
      });
      return { updated: true, broadcast_id: id, ...(copyId ? { email_copy_id: copyId } : {}) };
    },
  }),

  // ── content ──
  read({
    name: 'list_email_templates',
    title: 'List email templates',
    description: 'The library of email designs (ids, names, subjects).',
    inputSchema: args({}),
    run: async (_a, rt) => {
      const r = await rt.call('GET /templates');
      return { templates: pick(r.templates, ['id', 'name', 'kind', 'subject', 'sender_id', 'transactional_key', 'updated_at']) };
    },
  }),
  write({
    name: 'set_email_envelope',
    title: 'Set email subject / From / To',
    description:
      'Set the subject, From (a sender id from list_senders) and/or To of an email COPY that belongs to a draft broadcast or an unpublished automation step.',
    inputSchema: args(
      { template_id: str('The email copy id.'), subject: str('Subject (merge tags allowed).'), sender_id: str('Sender id.'), to_address: str('To (default {{customer.email}}).') },
      ['template_id'],
    ),
    run: async (a, rt) => {
      const id = s(a.template_id);
      await assertTemplateIsDraftOnly(rt, id);
      const body: Record<string, unknown> = {};
      for (const k of ['subject', 'sender_id', 'to_address'] as const) if (a[k] !== undefined) body[k] = a[k];
      if (Object.keys(body).length === 0) throw new ToolError('nothing to change');
      await rt.call('PUT /templates/:id', { params: { id }, body });
      return { updated: true, template_id: id };
    },
  }),
  read({
    name: 'list_text_templates',
    title: 'List text templates',
    description: 'Reusable SMS/WhatsApp message bodies.',
    inputSchema: args({}),
    run: async (_a, rt) => rt.call('GET /text-templates'),
  }),
  write({
    name: 'create_text_template',
    title: 'Create text template',
    description: 'Add a reusable SMS/WhatsApp body to the library.',
    inputSchema: args({ name: str('Name.'), body: str('Message (merge tags allowed).') }, ['name', 'body']),
    run: async (a, rt) => rt.call('POST /text-templates', { body: { name: a.name, body: a.body } }),
  }),
  write({
    name: 'update_text_template',
    title: 'Update text template',
    description: 'Edit a library text template (not one sent by the transactional API).',
    inputSchema: args({ text_template_id: str('Id.'), name: str('Name.'), body: str('Message.') }, ['text_template_id']),
    run: async (a, rt) => {
      const id = s(a.text_template_id);
      const cur = (await rt.call('GET /text-templates/:id', { params: { id } })).template as Record<string, unknown>;
      if (cur.transactional_key) throw new ToolError('this text is sent by the transactional API — edit it in the app');
      return rt.call('PUT /text-templates/:id', {
        params: { id },
        body: { name: a.name ?? cur.name, body: a.body ?? cur.body },
      });
    },
  }),
  read({
    name: 'list_topics',
    title: 'List topics',
    description: 'Subscription topics a send can be tagged with.',
    inputSchema: args({}),
    run: async (_a, rt) => rt.call('GET /topics'),
  }),
  read({
    name: 'list_senders',
    title: 'List senders',
    description: 'Named From addresses (on verified domains) usable as an email sender_id.',
    inputSchema: args({}),
    run: async (_a, rt) => rt.call('GET /domain-senders'),
  }),
  read({
    name: 'list_event_types',
    title: 'List event types',
    description: 'Event names this workspace has received (for triggers, rules and exit rules).',
    inputSchema: args({ q: str('Optional filter text.') }),
    run: async (a, rt) => rt.call('GET /events/types', { query: a.q !== undefined ? { q: s(a.q) } : {} }),
  }),
  read({
    name: 'list_event_payload_keys',
    title: 'List event attributes',
    description: 'Payload keys seen on an event type (for event filters and {{event.*}} merge tags).',
    inputSchema: args({ event_type: str('Event type.') }, ['event_type']),
    run: async (a, rt) => rt.call('GET /events/payload-keys', { query: { type: s(a.event_type) } }),
  }),
];

/** The instructions sent on initialize. */
export const MCP_INSTRUCTIONS =
  'Customer Journeys workspace (a marketing CDP). Call get_authoring_guide first. You can read and DRAFT automations, ' +
  'broadcasts, segments and templates; publishing, sending, scheduling, enrolling and deleting stay with a person in the app — ' +
  'when you finish a draft, tell the user what is left for them to do there.';
