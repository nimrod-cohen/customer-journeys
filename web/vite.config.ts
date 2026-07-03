/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// THE single source of truth for the app version is the ROOT package.json (the
// one we bump per change). It is the only place a version is defined; web's own
// package.json version is unused for display.
const rootPkgUrl = new URL('../package.json', import.meta.url);
const rootPkgPath = fileURLToPath(rootPkgUrl);

// App version surfaced in the UI: the PROJECT version + the git short SHA of the
// build. Git is best-effort — falls back to the version alone outside a repo.
const pkgVersion = JSON.parse(readFileSync(rootPkgUrl, 'utf8')).version as string;
let commit = '';
try {
  commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a git checkout — show the version only */
}

// `define` substitutes the version at server-start / build time, so a bump made
// while the dev server is running would otherwise go stale (Vite only auto-
// restarts on vite.config.ts changes, not on package.json). Watch the root
// package.json and restart the dev server when it changes, so the footer always
// reflects the single source of truth without a manual restart. (Production
// builds re-read it fresh each build — nothing to do there.)
const watchRootVersion = (): Plugin => ({
  name: 'watch-root-version',
  configureServer(server) {
    server.watcher.add(rootPkgPath);
    server.watcher.on('change', (file) => {
      if (file === rootPkgPath) void server.restart();
    });
  },
});

// Vite + Preact SPA (§12 bootstrap, scoped to §11 this phase). The dev/preview
// server is what Playwright drives in the browser e2e. `grapesjs` ships CSS we
// import in the component; nothing here is workspace-aware (auth/nav is Phase 12).
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __APP_COMMIT__: JSON.stringify(commit),
  },
  plugins: [preact(), watchRootVersion()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // assetsDir='static' (not the default 'assets') so the SPA's hashed bundles land
  // at /static/* and never collide with the API's `/assets/:id` uploaded-image route
  // when one container serves BOTH the SPA and the API in production.
  build: { outDir: 'dist', assetsDir: 'static' },
  // Vitest owns test/ (unit + DB-integration). Playwright owns e2e/ (browser),
  // run via `pnpm test:e2e` — keep its specs out of the vitest run.
  test: {
    // Unit tests live alongside source (src/**) AND in test/ (DB-integration).
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
});
