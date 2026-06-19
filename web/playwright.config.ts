import { defineConfig, devices } from '@playwright/test';

// Playwright config for the §12 role-aware SPA e2e.
//
// ISOLATION (critical): the e2e suite RE-SEEDS its database on every run — its
// setup DELETES and reinserts the Acme/Beta demo workspaces. So it MUST target a
// DEDICATED database on DEDICATED ports, never the dev stack. The dev app runs on
// :8787/:5173 against `cdp`; the e2e stack runs on :8788/:5174 against `cdp_e2e`.
// They coexist — running tests can no longer wipe live dev data.
//
// Both e2e servers must be up:
//   1. the local API (@cdp/service-local-api) on :8788 — real Postgres (cdp_e2e),
//      SES/SQS/DNS mocked; the SPA's apiClient points here via VITE_API_BASE,
//   2. the Vite dev server on :5174 — the SPA the browser drives.
// The API server applies migrations on a fresh DB and the seed (globalSetup, via
// adminPool reading DATABASE_URL) ensures the schema + demo data exist.
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/cdp_e2e';

// Force the isolated DB for THIS Playwright process (globalSetup/adminPool read
// process.env.DATABASE_URL). This guarantees the seed targets cdp_e2e even if the
// shell exported DATABASE_URL=cdp for the dev servers.
process.env.DATABASE_URL = E2E_DATABASE_URL;

const API_PORT = '8788';
const WEB_PORT = '5174';
const API_BASE = `http://localhost:${API_PORT}`;
const WEB_BASE = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // One retry: this local tier drives a single shared dev API (one worker), so a
  // few timing-sensitive specs (SES-config save round-trip, settings toggles) can
  // flake when the machine is under heavy load — they pass on retry and in
  // isolation. Playwright still flags any retried test as "flaky" (nothing hidden).
  retries: 1,
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: {
    baseURL: WEB_BASE,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Local API backend on the e2e port; the SPA points its apiClient here.
      command: 'pnpm --filter @cdp/service-local-api dev:api',
      url: `${API_BASE}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      cwd: '..',
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        LOCAL_API_PORT: API_PORT,
        // Local (mock) SES reports DKIM SUCCESS so the onboarding wizard can
        // activate AND sending-domain verification succeeds deterministically.
        LOCAL_SES_DKIM_STATUS: 'SUCCESS',
        // Allow the mock SES for the e2e (no AWS account). Without this, a
        // workspace with no SES credentials BLOCKS domain setup (no simulation).
        LOCAL_SES_FORCE_MOCK: '1',
      },
    },
    {
      // Vite dev server on the e2e port (strict, so it never falls back to :5173).
      command: `pnpm dev --port ${WEB_PORT} --strictPort`,
      url: WEB_BASE,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        // The SPA calls the e2e API at this origin.
        VITE_API_BASE: API_BASE,
      },
    },
  ],
});
