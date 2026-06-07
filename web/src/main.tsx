// SPA entry (§12). Mounts the role-aware App (Login → AppShell with capability
// nav + workspace switcher + routed screens). The §11 EmailEditor is reused as
// the /editor screen.
import { render } from 'preact';
import { App } from './App.js';
import { initRouter } from './router.js';

initRouter();
const root = document.getElementById('app');
if (root) render(<App />, root);
