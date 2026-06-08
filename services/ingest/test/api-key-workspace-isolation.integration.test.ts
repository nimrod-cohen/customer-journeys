import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { lookupApiKeyRow, upsertProfileForKey } from '../src/deps.js';
import { resolveWorkspaceId } from '../src/core.js';

// AC5 — ingest workspace isolation via the API key (§7/§13/§18). An API key for
// Workspace A can ONLY create events/profiles in Workspace A. The workspace is
// derived ONLY from workspace_api_keys; the client never supplies it. Real
// Postgres — the key→workspace mapping and the per-workspace profile upsert are
// what isolate tenants. Service-role pool (BYPASSRLS); scoping is in code.
const RUN = hasDatabaseUrl();

// Unique fixture namespace for THIS file.
const wsA = 'd4d4d4d4-0000-0000-0000-00000000000a';
const wsB = 'd4d4d4d4-0000-0000-0000-00000000000b';
const keyA = 'apikey-A-d4d4';
const keyB = 'apikey-B-d4d4';

describe.skipIf(!RUN)('ingest API-key → workspace isolation (AC5)', () => {
  let admin: Pool;
  beforeAll(async () => {
    admin = adminPool();
    await admin.query('DELETE FROM workspace_api_keys WHERE api_key_id IN ($1,$2)', [keyA, keyB]);
    for (const ws of [wsA, wsB]) {
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    await admin.query(
      'INSERT INTO workspace_api_keys (api_key_id, workspace_id) VALUES ($1,$2),($3,$4)',
      [keyA, wsA, keyB, wsB],
    );
  });
  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM workspace_api_keys WHERE api_key_id IN ($1,$2)', [keyA, keyB]);
      for (const ws of [wsA, wsB]) {
        await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
        await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      }
      await admin.end();
    }
  });

  it('resolves each API key to its own workspace', async () => {
    const rowA = await lookupApiKeyRow(admin, keyA);
    const rowB = await lookupApiKeyRow(admin, keyB);
    expect(resolveWorkspaceId(keyA, rowA)).toBe(wsA);
    expect(resolveWorkspaceId(keyB, rowB)).toBe(wsB);
  });

  it('an unknown API key resolves to no workspace (rejected at ingest)', async () => {
    const row = await lookupApiKeyRow(admin, 'no-such-key');
    expect(row).toBeNull();
    expect(() => resolveWorkspaceId('no-such-key', row)).toThrow();
  });

  it('key A only ever creates a profile in workspace A (same email stays separate)', async () => {
    const rowA = await lookupApiKeyRow(admin, keyA);
    const rowB = await lookupApiKeyRow(admin, keyB);
    const idA = await upsertProfileForKey(admin, resolveWorkspaceId(keyA, rowA), 'dup@acme.com', {});
    const idB = await upsertProfileForKey(admin, resolveWorkspaceId(keyB, rowB), 'dup@acme.com', {});
    expect(idA).not.toBe(idB);

    const a = await admin.query('SELECT workspace_id FROM profiles WHERE id = $1', [idA]);
    const b = await admin.query('SELECT workspace_id FROM profiles WHERE id = $1', [idB]);
    expect(a.rows[0].workspace_id).toBe(wsA);
    expect(b.rows[0].workspace_id).toBe(wsB);
  });
});
