// API reference: how to push profiles + events into the CDP. Rendered in TWO
// places from this SINGLE source — the authenticated Help screen (<ApiDocs/>) and
// the PUBLIC /docs page (<PublicDocs/>, no login), so integrators can read it
// without an account. Static content; no API calls.
import type { ComponentChildren } from 'preact';
import { Card } from '../ui/kit.js';

function Code({ children }: { children: ComponentChildren }) {
  return (
    <code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.85em] text-ink-900">{children}</code>
  );
}

function Pre({ children }: { children: ComponentChildren }) {
  return (
    <pre class="mt-2 overflow-x-auto rounded-lg bg-ink-950 px-4 py-3 text-[12.5px] leading-relaxed text-stone-100">
      <code class="font-mono">{children}</code>
    </pre>
  );
}

function Method({ verb, path }: { verb: string; path: string }) {
  const tone = verb === 'POST' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800';
  return (
    <div class="flex items-center gap-2 font-mono text-sm">
      <span class={`rounded px-1.5 py-0.5 text-xs font-bold ${tone}`}>{verb}</span>
      <span class="text-ink-900">{path}</span>
    </div>
  );
}

/** The API reference body. Reused by the Help screen and the public /docs page. */
export function ApiDocs() {
  const origin =
    typeof window !== 'undefined' && window.location ? window.location.origin : 'https://journeys.on-grow.com';
  return (
    <div data-testid="api-docs" class="space-y-6">
      <Card class="p-6">
        <h2 class="text-lg font-bold text-ink-950">Ingest API — profiles &amp; events</h2>
        <p class="mt-1 text-sm text-stone-600">
          Send your customers and their behaviour into the CDP over plain HTTP (JSON). A profile is a
          person, keyed by <Code>email</Code>; events are the things they do. Events feed segments,
          the profile timeline, and campaign triggers. There are two ways in:
        </p>
        <ul class="mt-3 space-y-1 text-sm text-stone-700">
          <li>
            <b>1. Tracking API (a write key)</b> — recommended. Safe to call from browser JS or any
            backend. <b>No login</b>, no password — just a public, write-only key.
          </li>
          <li>
            <b>2. Server-side admin API (a bearer token)</b> — full access for trusted backends.
          </li>
          <li class="pt-1">
            <b>Base URL:</b> <Code>{origin}</Code> · <b>Content type:</b> <Code>application/json</Code>
          </li>
        </ul>
      </Card>

      {/* ---- Tracking API (write key) ---- */}
      <Card class="border-brand-200 bg-brand-50/40 p-6">
        <h3 class="font-bold text-ink-900">1. Tracking API (write key) — for websites &amp; apps</h3>
        <p class="mt-1 text-sm text-stone-600">
          Create a <b>write key</b> in the app (<b>Workspace settings → API keys</b>, or ask your
          admin). It's like a Segment/Mixpanel write key: <b>public and write-only</b> — it can
          ONLY create/update profiles and record events for your workspace, never read or delete. So
          it's safe to embed in front-end code. Pass it as{' '}
          <Code>Authorization: Bearer &lt;key&gt;</Code> (or an <Code>X-API-Key</Code> header). No
          login step.
        </p>

        <div class="mt-4">
          <Method verb="POST" path="/v1/identify" />
          <p class="mt-1 text-sm text-stone-600">
            Create or update a person by <Code>email</Code>; <Code>traits</Code> merge into their
            profile attributes.
          </p>
          <Pre>{`curl -X POST ${origin}/v1/identify \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer pk_live_your_write_key' \\
  -d '{ "email": "jane@example.com",
        "traits": { "first_name": "Jane", "tier": "pro" } }'`}</Pre>
        </div>

        <div class="mt-4">
          <Method verb="POST" path="/v1/track" />
          <p class="mt-1 text-sm text-stone-600">
            Record an event. <Code>event</Code> is the name (e.g. <Code>purchase</Code>);{' '}
            <Code>properties</Code> is any JSON. The profile is upserted by <Code>email</Code> first,
            so you can track before you've identified. Optional <Code>traits</Code> update the profile
            at the same time.
          </p>
          <Pre>{`curl -X POST ${origin}/v1/track \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer pk_live_your_write_key' \\
  -d '{ "email": "jane@example.com",
        "event": "purchase",
        "properties": { "amount": 49.9, "currency": "USD" } }'`}</Pre>
        </div>

        <p class="mt-4 text-sm font-semibold text-ink-900">From a website (browser JS):</p>
        <Pre>{`<script>
  const WRITE_KEY = "pk_live_your_write_key"; // safe to expose — write-only
  function cdpTrack(email, event, properties) {
    return fetch("${origin}/v1/track", {
      method: "POST",
      headers: { "content-type": "application/json",
                 "authorization": "Bearer " + WRITE_KEY },
      body: JSON.stringify({ email, event, properties }),
      keepalive: true // survives page navigation
    });
  }
  // e.g. on signup / page view / purchase:
  cdpTrack("jane@example.com", "page_view", { url: location.pathname });
</script>`}</Pre>
        <p class="mt-3 text-xs text-stone-500">
          Responses are <Code>202 Accepted</Code> on success. The endpoints allow cross-origin (CORS)
          requests. If a key is ever exposed somewhere you don't want, just revoke it and mint a new
          one — no other config changes.
        </p>
      </Card>

      {/* ---- Server-side admin API ---- */}
      <Card class="p-6">
        <h3 class="font-bold text-ink-900">2. Server-side admin API (bearer token)</h3>
        <p class="mt-1 text-sm text-stone-600">
          For trusted backends that need full access (not just ingest). Exchange credentials for a
          token, then send <Code>Authorization: Bearer &lt;token&gt;</Code>. <b>Never use this from a
          browser</b> — the token grants full workspace access. Use the write key above for
          client-side.
        </p>
        <Method verb="POST" path="/auth/dev-login" />
        <Pre>{`curl -X POST ${origin}/auth/dev-login \\
  -H 'content-type: application/json' \\
  -d '{"email":"you@company.com","password":"••••••••"}'
# → { "token": "eyJ…", … }`}</Pre>
        <p class="mt-3 text-sm text-stone-600">
          Then <Code>POST /profiles</Code> <Code>{'{ email, external_id?, attributes? }'}</Code> to
          create a profile (409 with the existing id if the email exists), and{' '}
          <Code>POST /profiles/:id/events</Code> <Code>{'{ type, payload? }'}</Code> to record an
          event on it.
        </p>
        <Pre>{`# create/find a profile, then post an event to it
curl -X POST ${origin}/profiles \\
  -H "authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"email":"jane@example.com","attributes":{"first_name":"Jane"}}'

curl -X POST ${origin}/profiles/<profile-id>/events \\
  -H "authorization: Bearer <token>" -H 'content-type: application/json' \\
  -d '{"type":"purchase","payload":{"amount":49.9}}'`}</Pre>
      </Card>

      <Card class="p-6">
        <h3 class="font-bold text-ink-900">How the data flows</h3>
        <p class="mt-1 text-sm text-stone-600">
          Whichever method you use, an incoming event immediately updates the profile's rolling stats
          and re-evaluates which <b>segments</b> it belongs to — which can enrol it into{' '}
          <b>campaigns</b> and make it eligible for <b>broadcasts</b>. <Code>email</Code> is the
          identity key: two calls with the same email touch the same person.
        </p>
      </Card>
    </div>
  );
}

/** Public wrapper for GET /docs — renders <ApiDocs/> with a minimal header and no
 *  login/AppShell (readable by integrators without an account). */
export function PublicDocs() {
  return (
    <div class="min-h-dvh bg-stone-50 text-ink-900">
      <header class="border-b border-stone-200 bg-white">
        <div class="mx-auto flex max-w-3xl items-center gap-2.5 px-6 py-4">
          <span class="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-ink-950">
            <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5" stroke="currentColor" stroke-width="2">
              <path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0Z" stroke-linejoin="round" />
              <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div class="font-display text-[15px] font-bold text-ink-950">Customer Journeys — API</div>
        </div>
      </header>
      <main class="mx-auto max-w-3xl px-6 py-8">
        <h1 class="mb-1 font-display text-2xl font-bold text-ink-950">API documentation</h1>
        <p class="mb-6 text-sm text-stone-500">Push profiles and events into the CDP over HTTP.</p>
        <ApiDocs />
      </main>
    </div>
  );
}
