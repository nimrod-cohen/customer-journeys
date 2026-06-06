import { defineConfig } from 'vitest/config';

// Root Vitest config. Per-package configs may extend or override this.
// Unit tests are the bulk (fast, pure). Integration tests run against a real
// local Postgres (Supabase CLI / Testcontainers) and the thin E2E tier uses
// LocalStack — see CDP-BUILD-SPEC.md §16A.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
});
