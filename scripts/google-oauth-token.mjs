#!/usr/bin/env node
// One-off: turn a downloaded Google OAuth client JSON into a refresh token.
//
//   node scripts/google-oauth-token.mjs ~/Downloads/client_secret_*.json
//
// Google issues refresh tokens only through a browser consent round-trip, so this
// starts a throwaway local server, opens the consent screen, catches the redirect,
// exchanges the code, and prints the three values to set as Fly secrets.
//
// Run it once. The refresh token does not expire unless revoked, the project is
// left in "testing" for too long, or the password on the Google account changes.
//
// The FULL postmaster scope is requested deliberately: the read-only scopes
// (postmaster.domain, postmaster.traffic.readonly) cannot create or verify
// domains, which is the whole point of automating onboarding.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const SCOPE = 'https://www.googleapis.com/auth/postmaster';
const PORT = Number(process.env.OAUTH_PORT ?? 8765);
const REDIRECT = `http://localhost:${PORT}/callback`;

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/google-oauth-token.mjs <client_secret.json>');
  process.exit(1);
}

let clientId, clientSecret;
try {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  // Google nests the credentials under "installed" (Desktop app) or "web".
  const cfg = parsed.installed ?? parsed.web ?? parsed;
  clientId = cfg.client_id;
  clientSecret = cfg.client_secret;
  if (!clientId || !clientSecret) throw new Error('client_id / client_secret not found');
} catch (err) {
  console.error(`Could not read credentials from ${file}: ${err.message}`);
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    // offline + consent is what actually yields a REFRESH token; without them
    // Google returns only a short-lived access token and the script is pointless.
    access_type: 'offline',
    prompt: 'consent',
  });

function page(title, body, colour) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<div style="font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">
<h2 style="color:${colour}">${title}</h2><p>${body}</p></div>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Authorisation refused', `Google returned: <code>${error}</code>`, '#b91c1c'));
    console.error(`\nAuthorisation refused: ${error}`);
    server.close();
    process.exit(1);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end();
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const body = await tokenRes.json();

    if (!tokenRes.ok || !body.refresh_token) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page('No refresh token returned', 'See the terminal for details.', '#b91c1c'));
      console.error('\nGoogle did not return a refresh token:');
      console.error(JSON.stringify(body, null, 2));
      console.error(
        '\nIf you have authorised this client before, revoke it at\n' +
          'https://myaccount.google.com/permissions and run this again.',
      );
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Done', 'You can close this tab and return to the terminal.', '#15803d'));

    console.log('\n✅ Refresh token obtained. Set these three secrets:\n');
    console.log('fly secrets set \\');
    console.log(`  GOOGLE_POSTMASTER_CLIENT_ID='${clientId}' \\`);
    console.log(`  GOOGLE_POSTMASTER_CLIENT_SECRET='${clientSecret}' \\`);
    console.log(`  GOOGLE_POSTMASTER_REFRESH_TOKEN='${body.refresh_token}'`);
    console.log('\n(The refresh token is long-lived — store it in your password manager too.)\n');

    server.close();
    process.exit(0);
  } catch (err) {
    console.error(`\nToken exchange failed: ${err.message}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nListening on ${REDIRECT}`);
  console.log('\nIf a browser does not open, paste this into one:\n');
  console.log(authUrl + '\n');
  // Best-effort; the URL is printed above regardless.
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(opener, [authUrl], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
});

// Don't leave a server listening forever if the tab is abandoned.
setTimeout(() => {
  console.error('\nTimed out after 5 minutes with no callback.');
  server.close();
  process.exit(1);
}, 300_000).unref?.();
