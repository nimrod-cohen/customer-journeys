import { defineConfig, devices } from '@playwright/test';

// Playwright config for the §11 editor browser e2e. We build then serve the app
// via `vite preview` (a real static server) and drive it in real Chromium —
// proving the editor renders and EMITS MJML in a browser, not just in unit tests.
// DATABASE_URL is threaded through so a save-path spec can persist if extended.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Vite dev server: boots fast and needs no build step, so the e2e is
    // reliable both locally and in CI (where reuseExistingServer is off).
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/cdp',
    },
  },
});
