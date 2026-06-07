// SPA entry (§12 bootstrap). This phase (§11) mounts only the EmailEditor —
// auth, workspace switcher, and full navigation arrive in Phase 12.
import { render } from 'preact';
import { EmailEditor } from './EmailEditor.js';

const root = document.getElementById('app');
if (root) render(<EmailEditor />, root);
