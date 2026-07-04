// API reference: how to create profiles + post events over HTTP. Rendered in TWO
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
  const tone =
    verb === 'POST' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800';
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
          the profile timeline, and campaign triggers.
        </p>
        <ul class="mt-3 space-y-1 text-sm text-stone-700">
          <li>
            <b>Base URL:</b> <Code>{origin}</Code>
          </li>
          <li>
            <b>Content type:</b> <Code>application/json</Code>
          </li>
          <li>
            <b>Identity key:</b> <Code>email</Code> — a profile is unique per workspace by email.
          </li>
        </ul>
      </Card>

      {/* Auth */}
      <Card class="p-6">
        <h3 class="font-bold text-ink-900">1. Authenticate</h3>
        <p class="mt-1 text-sm text-stone-600">
          Exchange your credentials for a bearer token, then send it as{' '}
          <Code>Authorization: Bearer &lt;token&gt;</Code> on every call. The token is scoped to your
          workspace (never send a workspace id in the body) and is valid for ~30 days.
        </p>
        <Method verb="POST" path="/auth/dev-login" />
        <Pre>{`curl -X POST ${origin}/auth/dev-login \\
  -H 'content-type: application/json' \\
  -d '{"email":"you@company.com","password":"••••••••"}'

# → { "token": "eyJ…", "workspace_id": "…", … }`}</Pre>
      </Card>

      {/* Create profile */}
      <Card class="p-6">
        <h3 class="font-bold text-ink-900">2. Create (or find) a profile</h3>
        <p class="mt-1 text-sm text-stone-600">
          <Code>email</Code> is required; <Code>external_id</Code> (your own id) and{' '}
          <Code>attributes</Code> (any custom fields) are optional. Returns the new profile with its{' '}
          <Code>id</Code>. If a profile with that email already exists you get{' '}
          <Code>409</Code> with the existing <Code>id</Code> — use that id to post events.
        </p>
        <Method verb="POST" path="/profiles" />
        <Pre>{`curl -X POST ${origin}/profiles \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer <token>' \\
  -d '{
    "email": "jane@example.com",
    "external_id": "crm-8821",
    "attributes": { "first_name": "Jane", "tier": "pro", "phone": "+972529461566" }
  }'

# → 201 { "id": "b4b9…", "email": "jane@example.com", "email_status": "active", … }
# → 409 { "error": "…", "id": "<existing profile id>" }   (email already exists)`}</Pre>
      </Card>

      {/* Post event */}
      <Card class="p-6">
        <h3 class="font-bold text-ink-900">3. Post an event on that profile</h3>
        <p class="mt-1 text-sm text-stone-600">
          Use the profile <Code>id</Code> from step 2. <Code>type</Code> is required (a short verb
          like <Code>purchase</Code> or <Code>page_view</Code>); <Code>payload</Code> is an optional
          JSON object of details you can reference in segment rules and{' '}
          <Code>{'{{event.*}}'}</Code> merge tags.
        </p>
        <Method verb="POST" path="/profiles/:id/events" />
        <Pre>{`curl -X POST ${origin}/profiles/<profile-id>/events \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer <token>' \\
  -d '{
    "type": "purchase",
    "payload": { "amount": 49.9, "currency": "USD", "sku": "annual-plan" }
  }'

# → 200  (event recorded; features + segment membership recompute immediately)`}</Pre>
        <p class="mt-3 text-sm text-stone-600">
          The event immediately updates the profile’s rolling stats and re-evaluates which segments
          it belongs to — which can enrol it into campaigns and make it eligible for broadcasts.
        </p>
      </Card>

      {/* End-to-end */}
      <Card class="p-6">
        <h3 class="font-bold text-ink-900">End-to-end (bash)</h3>
        <Pre>{`BASE=${origin}
TOKEN=$(curl -s -X POST $BASE/auth/dev-login \\
  -H 'content-type: application/json' \\
  -d '{"email":"you@company.com","password":"••••••••"}' | jq -r .token)

# create or find the profile, capture its id (falls back to the 409 id)
PID=$(curl -s -X POST $BASE/profiles \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"email":"jane@example.com","attributes":{"first_name":"Jane"}}' | jq -r .id)

# record an event
curl -s -X POST $BASE/profiles/$PID/events \\
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"type":"page_view","payload":{"url":"/pricing"}}'`}</Pre>
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
        <p class="mb-6 text-sm text-stone-500">Create profiles and post events over HTTP.</p>
        <ApiDocs />
      </main>
    </div>
  );
}
