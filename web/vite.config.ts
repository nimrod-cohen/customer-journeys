/// <reference types="vitest" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Vite + Preact SPA (§12 bootstrap, scoped to §11 this phase). The dev/preview
// server is what Playwright drives in the browser e2e. `grapesjs` ships CSS we
// import in the component; nothing here is workspace-aware (auth/nav is Phase 12).
export default defineConfig({
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
