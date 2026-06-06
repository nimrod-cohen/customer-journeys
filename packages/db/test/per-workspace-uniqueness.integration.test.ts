import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '../src/index.js';

// AC2 — Per-workspace uniqueness (§3, §6, §18):
// `profiles UNIQUE(workspace_id, external_id)` — two workspaces may each have a
// customer with the SAME external_id; a single workspace may not.
const RUN = hasDatabaseUrl();

describe.skipIf(!RUN)('per-workspace uniqueness (AC2)', () => {
  let admin: Pool;
  const wsA = '33333333-3333-3333-3333-333333333333';
  const wsB = '44444444-4444-4444-4444-444444444444';

  beforeAll(async () => {
    admin = adminPool();
    await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
    await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
      await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
      await admin.end();
    }
  });

  it('two workspaces can share the same external_id', async () => {
    await admin.query(
      "INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'shared-id')",
      [wsA],
    );
    await expect(
      admin.query("INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'shared-id')", [
        wsB,
      ]),
    ).resolves.toBeTruthy();
  });

  it('the same external_id twice in ONE workspace violates the unique constraint', async () => {
    await expect(
      admin.query("INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'shared-id')", [
        wsA,
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
