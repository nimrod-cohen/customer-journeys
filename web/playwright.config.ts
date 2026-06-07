import { defineConfig, devices } from '@playwright/test';

// Playwright config for the §12 role-aware SPA e2e. BOTH servers must be up:
//   1. the local API (@cdp/service-local-api) on :8787 — real Postgres backend,
//      SES/SQS/DNS mocked at the boundary; the SPA's apiClient points here via
//      VITE_API_BASE,
//   2. the Vite dev server on :5173 — the SPA the browser drives.
// The API server applies migrations on a fresh DB and the e2e seeds its own
// workspaces/users via the API (dev-login) + a seed helper, so the browser specs
// exercise the SAME enforcement path (authorizer + enforceRoute + scopedQuery).
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/cdp';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Local API backend on a FIXED port; the SPA points its apiClient here.
      command: 'pnpm --filter @cdp/service-local-api dev:api',
      url: 'http://localhost:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '..',
      env: {
        DATABASE_URL,
        LOCAL_API_PORT: '8787',
        // Local SES reports DKIM verified so the onboarding wizard can activate.
        LOCAL_SES_DKIM_STATUS: 'SUCCESS',
      },
    },
    {
      // Vite dev server: boots fast and needs no build step.
      command: 'pnpm dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL,
        // The SPA calls the local API at this origin.
        VITE_API_BASE: 'http://localhost:8787',
      },
    },
  ],
});
