#!/usr/bin/env node
// Backfill: move each profile's `attributes.phone` into the CORE `profiles.phone` column
// (normalized to E.164 with the profile's workspace default_phone_country), then REMOVE
// the `phone` attribute. Idempotent + safe:
//   - only touches rows with a non-empty attributes.phone AND an empty core phone,
//   - skips a number that can't normalize (no default country / junk) — left as an attribute,
//   - skips a number already owned by another profile in the same workspace (no steal),
//   - runs per workspace so it uses that workspace's default country.
// Usage: DATABASE_URL=... node scripts/backfill-phone.mjs [--dry-run]
import { Pool } from 'pg';
import { normalizePhone } from '../packages/channels/dist/index.js';

const DRY = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = new Pool({ connectionString: url });

async function main() {
  const { rows: workspaces } = await pool.query(
    `SELECT id, settings->>'default_phone_country' AS country FROM workspaces`,
  );
  let moved = 0;
  let skipped = 0;
  for (const ws of workspaces) {
    const country = /^[A-Za-z]{2}$/.test(ws.country ?? '') ? ws.country.toUpperCase() : null;
    const { rows: profiles } = await pool.query(
      `SELECT id, attributes->>'phone' AS attr_phone
         FROM profiles
        WHERE workspace_id = $1 AND phone IS NULL
          AND attributes ? 'phone' AND coalesce(attributes->>'phone','') <> ''`,
      [ws.id],
    );
    for (const p of profiles) {
      const norm = normalizePhone(p.attr_phone, country);
      if (!norm) {
        skipped++;
        continue; // can't normalize — leave the attribute for a human to fix
      }
      // Not already owned by another profile (don't steal).
      const owner = await pool.query('SELECT id FROM profiles WHERE workspace_id=$1 AND phone=$2 LIMIT 1', [ws.id, norm]);
      if (owner.rows[0] && owner.rows[0].id !== p.id) {
        skipped++;
        continue;
      }
      if (DRY) {
        console.log(`[dry] ${ws.id} ${p.id}: ${p.attr_phone} → ${norm}`);
        moved++;
        continue;
      }
      // Set the core column + drop the attribute in one statement. A unique race → skip.
      try {
        await pool.query(
          `UPDATE profiles SET phone = $2, attributes = attributes - 'phone'
             WHERE id = $1 AND workspace_id = $3 AND phone IS NULL`,
          [p.id, norm, ws.id],
        );
        moved++;
      } catch (e) {
        skipped++;
        console.warn(`skip ${p.id}: ${(e && e.message) || e}`);
      }
    }
  }
  console.log(`${DRY ? '[dry-run] ' : ''}phone backfill done — moved ${moved}, skipped ${skipped}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
