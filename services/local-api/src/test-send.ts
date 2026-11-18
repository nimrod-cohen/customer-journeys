// Test send for an automation's send step: render the message with a REAL customer's
// data and deliver it to the person testing it.
//
// The pure parts live here (which node, which merge values, the "[TEST] " prefix);
// the handler in handlers.ts does the reads and the delivery. The rules that matter:
//
//   - The message goes to the TESTER. Nothing is written about the customer — no
//     enrollment, no outbox row, no messages_log row (that is what every metric and
//     the customer's own timeline read), no profile change.
//   - The customer's `{{unsubscribe}}` link is NOT rendered: it is a signed link that
//     really opts its owner out, and a tester clicking it in a QA email would
//     unsubscribe the customer. The test carries the TESTER's own link instead — real
//     and clickable, so the link itself can be checked, but it only ever acts on the
//     tester's address. (An inert `#` href was tried first; Gmail drops it, so the
//     link looked broken.)
import { customerMerge, eventMerge } from '@cdp/shared';
import type { Medium } from '@cdp/channels';

export const TEST_PREFIX = '[TEST] ';

/** Prefix a subject or text body, once. */
export function withTestPrefix(s: string): string {
  return s.startsWith(TEST_PREFIX) ? s : `${TEST_PREFIX}${s}`;
}

/** What a send step carries that a test send needs. */
export interface TestSendStep {
  readonly medium: Medium;
  readonly templateId: string | null;
  readonly textBody: string;
  readonly waTemplate: { readonly name: string; readonly language: string; readonly params: readonly string[] } | null;
}

/**
 * Find the send step `nodeId` in a definition. `'missing'` → 404 (no such step),
 * `'not_send'` → 400 (a step, but nothing to send).
 */
export function findSendStep(definition: unknown, nodeId: string): TestSendStep | 'missing' | 'not_send' {
  const nodes = (definition as { nodes?: Record<string, unknown> } | null)?.nodes;
  const raw = nodes && Object.prototype.hasOwnProperty.call(nodes, nodeId) ? nodes[nodeId] : undefined;
  if (!raw || typeof raw !== 'object') return 'missing';
  const n = raw as Record<string, unknown>;
  if (n.type !== 'action' || n.kind !== 'send') return 'not_send';
  const medium: Medium = n.medium === 'sms' || n.medium === 'whatsapp' ? n.medium : 'email';
  const wa = n.wa_template as { name?: unknown; language?: unknown; params?: unknown } | undefined;
  const waTemplate =
    medium === 'whatsapp' && wa && typeof wa.name === 'string' && wa.name.trim() && typeof wa.language === 'string'
      ? {
          name: wa.name,
          language: wa.language,
          params: Array.isArray(wa.params) ? wa.params.filter((p): p is string => typeof p === 'string') : [],
        }
      : null;
  return {
    medium,
    templateId: typeof n.template_id === 'string' && n.template_id ? n.template_id : null,
    textBody: typeof n.text_body === 'string' ? n.text_body : '',
    waTemplate,
  };
}

/**
 * The merge map for a test send: `customer.*` from the chosen profile, `event.*` from
 * the chosen trigger event, and NO `journey.*` (a test has no enrollment, so those
 * tokens render empty — the same as a fresh enrollment's).
 *
 * `unsubscribeUrl` is the TESTER's own preference-center link (or null for a text
 * message, which has none); it fills `{{unsubscribe_url}}` and `{{unsubscribe}}`.
 *
 * Profile values win over event keys, exactly as the dispatcher orders them.
 */
export function testSendMerge(
  profile: { email?: string | null; phone?: string | null; attributes?: Record<string, unknown> | null } & Record<string, unknown>,
  eventPayload: unknown,
  unsubscribeUrl: string | null = null,
): Record<string, string> {
  return {
    ...(eventPayload === undefined || eventPayload === null ? {} : eventMerge(eventPayload)),
    ...customerMerge(profile),
    ...(unsubscribeUrl
      ? { unsubscribe_url: unsubscribeUrl, unsubscribe: `<a href="${escapeAttr(unsubscribeUrl)}">Unsubscribe</a>` }
      : { unsubscribe_url: '', unsubscribe: '' }),
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
