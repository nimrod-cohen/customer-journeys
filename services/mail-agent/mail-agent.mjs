#!/usr/bin/env node
// mail-agent — runs on the MTA, forwards inbound bounces and spam reports to the app.
//
// DELIBERATELY THIN. It reads raw messages out of the bounce Maildir, posts them
// verbatim, and deletes them on success. It parses nothing and decides nothing:
// all of that lives in the application repo where it is unit-tested, so fixing a
// parser bug is an app deploy rather than an ssh session on a mail server.
//
// Failure behaviour is chosen so mail is never lost:
//   - 2xx            -> delete the file (handled, or deliberately ignored)
//   - anything else  -> leave it in place and retry on the next tick
//   - repeated fails -> move aside to `failed/` after MAX_ATTEMPTS so one poison
//                       message cannot block the queue forever
//
// Install: /opt/mail-agent/mail-agent.mjs, run by a systemd timer.
import { readdir, readFile, unlink, rename, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAILDIR = process.env.MAILDIR ?? '/home/bounce/Maildir/new';
const FAILED_DIR = process.env.FAILED_DIR ?? '/home/bounce/Maildir/failed';
const ENDPOINT = process.env.INGEST_URL ?? 'https://journeys.on-grow.com/internal/mail-events';
const SECRET = process.env.MAIL_AGENT_SECRET ?? '';
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 5);
const BATCH = Number(process.env.BATCH ?? 50);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 15000);

// Attempt counts are in-memory: a restart resets them, which is the safe
// direction — it retries a message rather than discarding it.
const attempts = new Map();

function log(level, msg, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + '\n',
  );
}

/** Postfix writes the delivered-to address into a header; pass it along in case
 *  the report itself has been mangled by an intermediate relay. */
function originalTo(raw) {
  const m = /^X-Original-To:\s*(.+)$/im.exec(raw) ?? /^Delivered-To:\s*(.+)$/im.exec(raw);
  return m ? m[1].trim() : null;
}

async function post(raw) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ raw, originalTo: originalTo(raw) }),
      signal: ctrl.signal,
    });
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* body is diagnostic only */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function handleOne(dir, name) {
  const path = join(dir, name);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return; // vanished between listing and reading — nothing to do
  }

  let res;
  try {
    res = await post(raw);
  } catch (err) {
    res = { status: 0, body: String(err?.message ?? err) };
  }

  if (res.status >= 200 && res.status < 300) {
    await unlink(path).catch(() => {});
    attempts.delete(name);
    let action = 'unknown';
    try {
      action = JSON.parse(res.body)?.action ?? 'unknown';
    } catch {
      /* not fatal */
    }
    log('info', 'forwarded', { file: name, action });
    return;
  }

  const n = (attempts.get(name) ?? 0) + 1;
  attempts.set(name, n);
  log('warn', 'forward failed', { file: name, status: res.status, attempt: n });

  // One malformed message must not wedge the queue behind it.
  if (n >= MAX_ATTEMPTS) {
    await mkdir(FAILED_DIR, { recursive: true }).catch(() => {});
    await rename(path, join(FAILED_DIR, name)).catch(() => {});
    attempts.delete(name);
    log('error', 'moved aside after repeated failures', { file: name, attempts: n });
  }
}

async function tick() {
  let names;
  try {
    names = await readdir(MAILDIR);
  } catch (err) {
    log('error', 'cannot read maildir', { dir: MAILDIR, err: String(err?.message ?? err) });
    return;
  }
  const batch = names.filter((n) => !n.startsWith('.')).slice(0, BATCH);
  if (batch.length === 0) return;
  log('info', 'processing', { count: batch.length });
  for (const name of batch) await handleOne(MAILDIR, name);
}

async function main() {
  if (!SECRET) {
    log('error', 'MAIL_AGENT_SECRET is not set — refusing to start');
    process.exit(1);
  }
  try {
    await stat(MAILDIR);
  } catch {
    log('error', 'maildir does not exist', { dir: MAILDIR });
    process.exit(1);
  }
  await tick();
}

main().catch((err) => {
  log('error', 'unhandled', { err: String(err?.stack ?? err) });
  process.exit(1);
});
