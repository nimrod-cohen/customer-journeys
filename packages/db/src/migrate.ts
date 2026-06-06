// Apply the SQL migrations in order against a pooled connection (§6).
//
// Used by the integration tests when bootstrapping a fresh Postgres (e.g. a
// Testcontainers instance) without the Supabase CLI. The Supabase CLI applies
// the same files via `supabase db reset`; this is the CLI-less path.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the migrations directory (works from src and dist). */
export const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

/**
 * Read and execute every `*.sql` migration in lexical order. Idempotent only if
 * the migrations themselves are; intended for a fresh database.
 */
export async function applyMigrations(
  conn: Pool | PoolClient,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const entries = (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  for (const file of entries) {
    const sql = await readFile(join(dir, file), 'utf8');
    await conn.query(sql);
  }
  return entries;
}
