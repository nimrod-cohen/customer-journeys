export { getPool, closePool } from './client.js';
export { scopedQuery, type ScopedQuery } from './scoped.js';
export {
  setSessionClaims,
  clearSessionClaims,
  ensureTestAppRole,
  TEST_APP_ROLE,
  hasDatabaseUrl,
  adminPool,
  type SessionClaims,
} from './testutil.js';
export { applyMigrations, runPendingMigrations, MIGRATIONS_DIR } from './migrate.js';
export type { RunMigrationsOptions } from './migrate.js';
export { encryptSecret, decryptSecret, isEncryptedSecret } from './secret-crypto.js';
