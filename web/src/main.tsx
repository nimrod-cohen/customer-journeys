import './index.css';
// SPA entry (§12). Mounts the role-aware App (Login → AppShell with capability
// nav + workspace switcher + routed screens). The §11 EmailEditor is reused as
// the /editor screen.
import { render } from 'preact';
import { App } from './App.js';
import { initRouter } from './router.js';
import { restoreSession } from './store/session.js';

initRouter();
// Rehydrate a persisted session (set synchronously from localStorage at store
// init) and revalidate it against /me in the background — so a page refresh
// keeps the user signed in instead of bouncing to Login.
void restoreSession();
const root = document.getElementById('app');
if (root) render(<App />, root);
