// REAL Postgres: the EXPANDED operator set (string ILIKE ops, BETWEEN, timestamp
// duration/date ops, not exists) compiles to VALID SQL that matches the right
// rows. The compile-where unit suite asserts the SQL TEXT; this proves the SQL
// actually runs + has the intended semantics. buildSegmentMatch scopes to one
// profile; workspace_id is structurally $1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildSegmentMatch } from '../src/statements.js';
import type { AstNode } from '../src/compile.js';

const RUN = hasDatabaseUrl();
const WS = '0c0d0ef5-0000-4000-8000-0000000000a1';
const P_GOLD = '0c0d0ef5-0000-4000-8000-0000000000d1'; // Gold, $50, event 2d ago
const P_SILVER = '0c0d0ef5-0000-4000-8000-0000000000d2'; // Silver, $5, event 100d ago
const P_BRONZE = '0c0d0ef5-0000-4000-8000-0000000000d3'; // Bronze, $500, no event

describe.skipIf(!RUN)('expanded segment operators against real Postgres', () => {
  let admin: Pool;

  async function matches(ast: AstNode, profileId: string): Promise<boolean> {
    const q = buildSegmentMatch(WS, ast, profileId);
    const { rows } = await admin.query(q.text, q.values);
    return rows.length > 0;
  }
  /** profile ids (of our three) that match the AST. */
  async function matchSet(ast: AstNode): Promise<Set<string>> {
    const out = new Set<string>();
    for (const id of [P_GOLD, P_SILVER, P_BRONZE]) if (await matches(ast, id)) out.add(id);
    return out;
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    for (const [id, ext, tier] of [[P_GOLD, 'g', 'Gold'], [P_SILVER, 's', 'Silver'], [P_BRONZE, 'b', 'Bronze']] as const) {
      await admin.query('INSERT INTO profiles (id, workspace_id, external_id, attributes) VALUES ($1,$2,$3,$4::jsonb)', [id, WS, ext, JSON.stringify({ tier })]);
    }
    // features: monetary_total + last_event_at (Bronze has NO event row → null).
    await admin.query("INSERT INTO profile_features (profile_id, workspace_id, monetary_total, last_event_at) VALUES ($1,$2,50, now() - interval '2 days')", [P_GOLD, WS]);
    await admin.query("INSERT INTO profile_features (profile_id, workspace_id, monetary_total, last_event_at) VALUES ($1,$2,5, now() - interval '100 days')", [P_SILVER, WS]);
    await admin.query('INSERT INTO profile_features (profile_id, workspace_id, monetary_total) VALUES ($1,$2,500)', [P_BRONZE, WS]);
    // FUTURE-dated attribute (renewAt) for the "after duration from now" op:
    // Gold +2 days, Silver +10 days, Bronze none. Stored DB-relative as an ISO string.
    await admin.query("UPDATE profiles SET attributes = attributes || jsonb_build_object('renewAt', (now() + interval '2 days')) WHERE id=$1", [P_GOLD]);
    await admin.query("UPDATE profiles SET attributes = attributes || jsonb_build_object('renewAt', (now() + interval '10 days')) WHERE id=$1", [P_SILVER]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });
  async function cleanup() {
    await admin.query('DELETE FROM profile_features WHERE workspace_id=$1', [WS]);
    await admin.query('DELETE FROM profiles WHERE workspace_id=$1', [WS]);
    await admin.query('DELETE FROM workspaces WHERE id=$1', [WS]);
  }

  it('contains / starts with / ends with (case-insensitive ILIKE) on an attribute', async () => {
    expect(await matchSet({ field: 'attributes.tier', operator: 'contains', value: 'old' })).toEqual(new Set([P_GOLD])); // g-OLD
    expect(await matchSet({ field: 'attributes.tier', operator: 'starts with', value: 'sil' })).toEqual(new Set([P_SILVER]));
    expect(await matchSet({ field: 'attributes.tier', operator: 'ends with', value: 'ZE' })).toEqual(new Set([P_BRONZE])); // bronZE
    expect(await matchSet({ field: 'attributes.tier', operator: 'not contains', value: 'o' })).toEqual(new Set([P_SILVER])); // only Silver lacks 'o'
  });

  it('between [min,max] on a numeric feature', async () => {
    expect(await matchSet({ field: 'monetary_total', operator: 'between', value: [10, 100] })).toEqual(new Set([P_GOLD]));
    expect(await matchSet({ field: 'monetary_total', operator: 'between', value: [1, 1000] })).toEqual(new Set([P_GOLD, P_SILVER, P_BRONZE]));
  });

  it('timestamp: in the last {amount,unit} + is in the past on a timestamptz feature', async () => {
    expect(await matchSet({ field: 'last_event_at', operator: 'in the last duration', value: { amount: 7, unit: 'days' } })).toEqual(new Set([P_GOLD]));
    expect(await matchSet({ field: 'last_event_at', operator: 'in the last duration', value: { amount: 365, unit: 'days' } })).toEqual(new Set([P_GOLD, P_SILVER]));
    // Both with an event are in the past; Bronze (null last_event_at) does not match.
    expect(await matchSet({ field: 'last_event_at', operator: 'is in the past', value: undefined as unknown as never })).toEqual(new Set([P_GOLD, P_SILVER]));
  });

  it('before duration ago is the dual of in-the-last', async () => {
    // event older than 30 days ago → only Silver (100d). Gold (2d) is recent.
    expect(await matchSet({ field: 'last_event_at', operator: 'before duration ago', value: { amount: 30, unit: 'days' } })).toEqual(new Set([P_SILVER]));
  });

  it('after duration from now: a timestamp MORE THAN N ahead (the future mirror of before-duration-ago)', async () => {
    // renewAt: Gold +2d, Silver +10d, Bronze none.
    // "more than 4 days ahead" → only Silver (10d); Gold (2d) is within 4d; Bronze (null) never.
    expect(await matchSet({ field: 'attributes.renewAt', operator: 'after duration from now', value: { amount: 4, unit: 'days' } })).toEqual(new Set([P_SILVER]));
    // "more than 1 day ahead" → both Gold (2d) and Silver (10d).
    expect(await matchSet({ field: 'attributes.renewAt', operator: 'after duration from now', value: { amount: 1, unit: 'days' } })).toEqual(new Set([P_GOLD, P_SILVER]));
    // It is the strict complement of "within the next 4 days" (Gold only) among the future-dated profiles.
    expect(await matchSet({ field: 'attributes.renewAt', operator: 'within next duration', value: { amount: 4, unit: 'days' } })).toEqual(new Set([P_GOLD]));
  });

  it('not exists matches profiles missing the attribute key', async () => {
    // None of the three has a `vipUntil` attribute → all match "not exists".
    expect(await matchSet({ field: 'attributes.vipUntil', operator: 'not exists' })).toEqual(new Set([P_GOLD, P_SILVER, P_BRONZE]));
  });
});
