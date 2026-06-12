/// <reference types="vitest" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// App version surfaced in the UI: the package version + the git short SHA of the
// build (a real, changing build id). Git is best-effort — falls back to the
// version alone outside a repo.
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;
let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a git checkout — show the version only */
}

// Vite + Preact SPA (§12 bootstrap, scoped to §11 this phase). The dev/preview
// server is what Playwright drives in the browser e2e. `grapesjs` ships CSS we
// import in the component; nothing here is workspace-aware (auth/nav is Phase 12).
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  plugins: [preact()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { outDir: 'dist' },
  // Vitest owns test/ (unit + DB-integration). Playwright owns e2e/ (browser),
  // run via `pnpm test:e2e` — keep its specs out of the vitest run.
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
});
