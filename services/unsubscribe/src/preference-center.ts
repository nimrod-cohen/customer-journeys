// Preference-center pure core (CLAUDE.md topic-subscriptions). The public
// "manage your subscription" page. Like the two-step /unsubscribe, the
// workspace_id + email come ONLY from the scoped link — NEVER a body field
// (tenant-isolation inv.2). A person can:
//   - unsubscribe from / re-subscribe to specific TOPICS (per-topic),
//   - opt out of / back into a whole MEDIUM GROUP (email | sms_whatsapp),
//   - "unsubscribe from everything" (full hard suppression + the global flag).
// A PARTIAL opt-out (a topic, or just one medium group) must NOT set the global
// hard suppression / profiles.attributes.unsubscribed — the person stays
// reachable on the still-subscribed channels (the user's key requirement).
//
// Everything here is pure + parameterized SQL (workspace_id bound at $1, throws
// on a falsy id) — the service role bypasses RLS, so in-code scoping is the guard.
import type { SqlStatement } from './core.js';

/** The two subscription medium groups (WhatsApp + SMS are grouped). */
export const MEDIUM_GROUPS = ['email', 'sms_whatsapp'] as const;
export type MediumGroup = (typeof MEDIUM_GROUPS)[number];

/** Whether `g` is a recognised medium group. */
export function isMediumGroup(g: unknown): g is MediumGroup {
  return g === 'email' || g === 'sms_whatsapp';
}

/** A topic checkbox in the preference center, with the recipient's current state. */
export interface TopicChoice {
  readonly id: string;
  readonly name: string;
  /** The recipient's current subscription (default-on: no opt-out row = true). */
  readonly subscribed: boolean;
}

/** The requested preference change parsed from a POST body. */
export interface PreferenceUpdate {
  /** Per-topic desired state: topicId → subscribed. */
  readonly topics: ReadonlyMap<string, boolean>;
  /** Per-medium-group desired state: group → subscribed (false = opted out). */
  readonly groups: ReadonlyMap<MediumGroup, boolean>;
  /** True when the recipient chose "unsubscribe from everything". */
  readonly unsubscribeAll: boolean;
}

/**
 * Parse a preference-center POST body (an HTML form url-encoded string). The form
 * posts:
 *   - `topic.<topicId>=on` for each CHECKED (subscribed) topic — an unchecked
 *     box simply isn't posted, so a topic ID present in the workspace but absent
 *     from the body is a desired opt-out. We therefore need the workspace's topic
 *     ids to diff against (passed in `topicIds`).
 *   - `group.email=on` / `group.sms_whatsapp=on` for each CHECKED group.
 *   - `unsubscribe_all=1` (the "unsubscribe from everything" submit).
 * Returns the DESIRED end-state for every known topic + both groups.
 */
export function parsePreferenceUpdate(body: string | null | undefined, topicIds: readonly string[]): PreferenceUpdate {
  const params = new URLSearchParams(body ?? '');
  const unsubscribeAll = params.get('unsubscribe_all') === '1' || params.has('unsubscribe_all');

  const checkedTopics = new Set<string>();
  for (const [k, v] of params.entries()) {
    if (k.startsWith('topic.') && (v === 'on' || v === '1' || v === 'true')) {
      checkedTopics.add(k.slice('topic.'.length));
    }
  }
  const topics = new Map<string, boolean>();
  for (const id of topicIds) topics.set(id, checkedTopics.has(id));

  const groups = new Map<MediumGroup, boolean>();
  for (const g of MEDIUM_GROUPS) {
    const v = params.get(`group.${g}`);
    groups.set(g, v === 'on' || v === '1' || v === 'true');
  }

  return { topics, groups, unsubscribeAll };
}

// ── read builders (load current state for the GET page) ──────────────────────

/**
 * The workspace's ACTIVE topics. workspace_id bound at $1; throws on a falsy id.
 * (Archived topics are hidden — a recipient can't manage a retired topic.)
 */
export function buildActiveTopicsQuery(workspaceId: string): SqlStatement {
  if (!workspaceId) throw new Error('buildActiveTopicsQuery: workspaceId is required (tenant-isolation guard)');
  return {
    text: `SELECT id, name FROM topics
           WHERE workspace_id = $1 AND archived = false
           ORDER BY created_at DESC`,
    values: [workspaceId],
  };
}

/**
 * The recipient's explicit topic opt-outs (topic_subscriptions where
 * subscribed=false), resolved by EMAIL → profile. Default-on: a topic with no
 * row here is subscribed. workspace_id at $1.
 */
export function buildTopicStateQuery(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) throw new Error('buildTopicStateQuery: workspaceId is required (tenant-isolation guard)');
  return {
    text: `SELECT ts.topic_id, ts.subscribed
           FROM topic_subscriptions ts
           JOIN profiles p ON p.id = ts.profile_id
           WHERE ts.workspace_id = $1 AND p.workspace_id = $1 AND p.email = $2`,
    values: [workspaceId, email],
  };
}

/** The recipient's current medium-group opt-outs (a row = opted out). workspace_id at $1. */
export function buildGroupStateQuery(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) throw new Error('buildGroupStateQuery: workspaceId is required (tenant-isolation guard)');
  return {
    text: `SELECT co.medium_group
           FROM channel_optouts co
           JOIN profiles p ON p.id = co.profile_id
           WHERE co.workspace_id = $1 AND p.workspace_id = $1 AND p.email = $2`,
    values: [workspaceId, email],
  };
}

// ── write builders (the POST tx) ─────────────────────────────────────────────

/**
 * Upsert ONE topic's subscription for the recipient (resolved by email). The
 * profile is looked up inline so the write never trusts a client profile id.
 * DEFAULT-subscribed model: we store an explicit row for BOTH opt-outs
 * (subscribed=false) and re-opt-ins (subscribed=true). Idempotent via ON
 * CONFLICT. workspace_id at $1; throws on a falsy id. Returns NULL if there is
 * no profile for this email (nothing to write).
 */
export function buildTopicSubscriptionUpsert(
  workspaceId: string,
  email: string,
  topicId: string,
  subscribed: boolean,
): SqlStatement {
  if (!workspaceId) throw new Error('buildTopicSubscriptionUpsert: workspaceId is required (tenant-isolation guard)');
  return {
    text: `INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed, updated_at)
           SELECT $1, p.id, $3, $4, now()
           FROM profiles p WHERE p.workspace_id = $1 AND p.email = $2
           ON CONFLICT (workspace_id, profile_id, topic_id)
           DO UPDATE SET subscribed = EXCLUDED.subscribed, updated_at = now()`,
    values: [workspaceId, email, topicId, subscribed],
  };
}

/**
 * Set ONE medium group's opt-out state. `optedOut=true` inserts the opt-out row
 * (idempotent); `optedOut=false` deletes it (re-subscribed). Resolved by email
 * inline. workspace_id at $1; throws on a falsy id.
 */
export function buildChannelOptOutWrite(
  workspaceId: string,
  email: string,
  group: MediumGroup,
  optedOut: boolean,
): SqlStatement {
  if (!workspaceId) throw new Error('buildChannelOptOutWrite: workspaceId is required (tenant-isolation guard)');
  if (optedOut) {
    return {
      text: `INSERT INTO channel_optouts (workspace_id, profile_id, medium_group, updated_at)
             SELECT $1, p.id, $3, now()
             FROM profiles p WHERE p.workspace_id = $1 AND p.email = $2
             ON CONFLICT (workspace_id, profile_id, medium_group)
             DO UPDATE SET updated_at = now()`,
      values: [workspaceId, email, group],
    };
  }
  return {
    text: `DELETE FROM channel_optouts
           WHERE workspace_id = $1 AND medium_group = $3
             AND profile_id IN (SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2)`,
    values: [workspaceId, email, group],
  };
}

/**
 * "Unsubscribe from EVERYTHING" — opt the recipient out of every active topic.
 * One statement: upsert subscribed=false for every active topic this workspace
 * has. (The two channel groups + the hard suppression + the global flag are
 * written by separate statements in the handler tx.) workspace_id at $1.
 */
export function buildOptOutAllTopics(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) throw new Error('buildOptOutAllTopics: workspaceId is required (tenant-isolation guard)');
  return {
    text: `INSERT INTO topic_subscriptions (workspace_id, profile_id, topic_id, subscribed, updated_at)
           SELECT $1, p.id, t.id, false, now()
           FROM topics t
           CROSS JOIN profiles p
           WHERE t.workspace_id = $1 AND p.workspace_id = $1 AND p.email = $2
           ON CONFLICT (workspace_id, profile_id, topic_id)
           DO UPDATE SET subscribed = false, updated_at = now()`,
    values: [workspaceId, email],
  };
}

/**
 * Compute the recipient's CURRENT topic choices for the GET page: every active
 * topic + whether they're currently subscribed (default-on minus explicit
 * opt-outs). Pure; combines the two read results.
 */
export function toTopicChoices(
  activeTopics: ReadonlyArray<{ id: string; name: string }>,
  explicitState: ReadonlyArray<{ topic_id: string; subscribed: boolean }>,
): TopicChoice[] {
  const optedOut = new Set(explicitState.filter((r) => r.subscribed === false).map((r) => r.topic_id));
  return activeTopics.map((t) => ({ id: t.id, name: t.name, subscribed: !optedOut.has(t.id) }));
}
