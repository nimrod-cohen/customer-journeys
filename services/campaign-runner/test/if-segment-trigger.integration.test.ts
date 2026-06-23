import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildBranchMatchQuery, rewriteTriggerEventLeaves } from '../src/core.js';
import type { AstNode } from '@cdp/segments';

// §9B campaign-IF: the new SEGMENT-membership leaf compiles to a real EXISTS over
// segment_memberships, and the TRIGGER-EVENT leaf is rewritten in-memory against
// the enrolling event payload before SQL. Verified end-to-end against Postgres.
const RUN = hasDatabaseUrl();
const WS = '0c0d0ef2-0000-4000-8000-0000000000a1';
const WS_B = '0c0d0ef2-0000-4000-8000-0000000000b1';
const SEG = '0c0d0ef2-0000-4000-8000-000000000051';
const PROF_IN = '0c0d0ef2-0000-4000-8000-0000000000d1'; // a member of SEG
const PROF_OUT = '0c0d0ef2-0000-4000-8000-0000000000d2'; // NOT a member

async function matches(admin: Pool, ast: AstNode, profileId: string): Promise<boolean> {
  const q = buildBranchMatchQuery(WS, ast, profileId);
  const { rows } = await admin.query(q.text, q.values);
  return rows.length > 0;
}

describe.skipIf(!RUN)('campaign IF: segment-membership + trigger-event (real Postgres)', () => {
  let admin: Pool;
  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const ws of [WS, WS_B]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await admin.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    for (const [pid, ext] of [[PROF_IN, 'in'], [PROF_OUT, 'out']] as const) {
      await admin.query('INSERT INTO profiles (id, workspace_id, external_id) VALUES ($1,$2,$3)', [pid, WS, ext]);
    }
    // PROF_IN is a member of SEG; PROF_OUT is not.
    await admin.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG, PROF_IN, WS],
    );
  });
  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  async function cleanup(): Promise<void> {
    const a = adminPool();
    for (const ws of [WS, WS_B]) {
      await a.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await a.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await a.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await a.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('"is a member" matches the member and not the non-member', async () => {
    const ast: AstNode = { segment: SEG } as AstNode;
    expect(await matches(admin, ast, PROF_IN)).toBe(true);
    expect(await matches(admin, ast, PROF_OUT)).toBe(false);
  });

  it('"is NOT a member" is the dual', async () => {
    const ast: AstNode = { segment: SEG, negate: true } as AstNode;
    expect(await matches(admin, ast, PROF_IN)).toBe(false);
    expect(await matches(admin, ast, PROF_OUT)).toBe(true);
  });

  it('segment leaf is workspace-scoped — a foreign workspace never matches', async () => {
    // Query WS_B's view: PROF_IN belongs to WS, so a WS_B-scoped match finds nothing.
    const q = buildBranchMatchQuery(WS_B, { segment: SEG } as AstNode, PROF_IN);
    const { rows } = await admin.query(q.text, q.values);
    expect(rows.length).toBe(0);
  });

  it('trigger-event leaf: rewritten to TRUE/FALSE by the payload, then SQL-matched', async () => {
    const ast: AstNode = {
      op: 'and',
      conditions: [{ segment: SEG }, { triggerEvent: true, filter: { field: 'payload.amount', operator: '>=', value: 100 } }],
    } as AstNode;
    // Member + matching payload → match.
    expect(await matches(admin, rewriteTriggerEventLeaves(ast, { amount: 250 }), PROF_IN)).toBe(true);
    // Member + NON-matching payload → no match (trigger leaf folds to FALSE).
    expect(await matches(admin, rewriteTriggerEventLeaves(ast, { amount: 5 }), PROF_IN)).toBe(false);
    // Member + NO trigger event → no match.
    expect(await matches(admin, rewriteTriggerEventLeaves(ast, null), PROF_IN)).toBe(false);
  });
});
