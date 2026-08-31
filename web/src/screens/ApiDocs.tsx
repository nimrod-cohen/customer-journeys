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
          the profile timeline, and automation triggers. There are two ways in:
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

      {/* ---- Transactional send ---- */}
      <Card data-testid="docs-transactional" class="p-6">
        <h3 class="font-bold text-ink-900">2. Transactional messages (secret key)</h3>
        <p class="mt-1 text-sm text-stone-600">
          One message to one person, triggered by your application: a one-time code, a password
          reset, an order receipt. Works for <b>email, SMS and WhatsApp</b>.
        </p>

        <p class="mt-4 text-sm font-semibold text-ink-900">Set one up (once)</p>
        <ol class="mt-1 list-decimal space-y-1 pl-5 text-sm text-stone-600">
          <li>
            Go to <b>Transactional</b> in the sidebar and create an email or an SMS/WhatsApp message.
          </li>
          <li>
            Give it a <b>key</b> — <Code>otp</Code>, <Code>password-reset</Code>. This is the only
            name your code needs to know.
          </li>
          <li>
            For email, set the <b>From</b> and <b>Subject</b> in the designer; both are required
            before it can send. For SMS/WhatsApp, just write the message.
          </li>
          <li>
            Mint a <b>secret key</b> under <b>Workspace settings → API keys</b> and keep it on your
            server.
          </li>
        </ol>
        <p class="mt-2 text-sm text-stone-600">
          Because your code refers to the key and not to a specific design, you can rewrite the
          message, or move the key to a different one, without deploying anything.
        </p>

        <div class="mt-4">
          <Method verb="POST" path="/v1/send" />
          <p class="mt-1 text-sm text-stone-600">
            This one needs a <b>secret key</b> (<Code>sk_live_…</Code>), not the public write key: it
            sends real mail from your verified domain to whatever address it's given, so it must
            never sit in a web page or a mobile app.
          </p>
          <Pre>{`curl -X POST ${origin}/v1/send \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer sk_live_your_secret_key' \\
  -d '{ "template": "otp",
        "to": "jane@example.com",
        "data": { "code": "123456", "expires_in": "10 minutes" } }'
# → { "sent": true, "message_id": "…" }`}</Pre>
        </div>

        <p class="mt-4 text-sm font-semibold text-ink-900">SMS and WhatsApp</p>
        <p class="mt-1 text-sm text-stone-600">
          Identical call — the key decides the channel, so <Code>to</Code> is simply a phone number
          instead. A national number resolves against the workspace's default country.
        </p>
        <Pre>{`curl -X POST ${origin}/v1/send \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer sk_live_your_secret_key' \\
  -d '{ "template": "otp-sms",
        "to": "+972541111111",
        "data": { "code": "123456" } }'
# → { "sent": true, "message_id": "…", "medium": "sms" }`}</Pre>

        <p class="mt-4 text-sm font-semibold text-ink-900">Filling in the values</p>
        <p class="mt-1 text-sm text-stone-600">
          Everything you pass in <Code>data</Code> is available in the subject and the body as{' '}
          <Code>{'{{data.code}}'}</Code>; nested values flatten to <Code>{'{{data.order.id}}'}</Code>{' '}
          and lists index as <Code>{'{{data.items.0.sku}}'}</Code>. The recipient's own profile
          fields stay available as <Code>{'{{customer.first_name}}'}</Code>, and someone we've never
          seen before is created as a profile. An unknown token renders as nothing rather than
          leaving <Code>{'{{…}}'}</Code> visible in the message.
        </p>

        <p class="mt-4 text-sm font-semibold text-ink-900">
          Two braces or three: <Code>{'{{ }}'}</Code> is text, <Code>{'{{{ }}}'}</Code> is HTML
        </p>
        <p class="mt-1 text-sm text-stone-600">
          In an email <b>body</b>, a value substituted with <b>two</b> braces is inserted as{' '}
          <b>text</b>: the characters that mean something in HTML are escaped, so the recipient sees
          exactly what you passed. With <b>three</b> braces the value is written as <b>markup</b>,
          for the case where you composed the HTML yourself.
        </p>
        <Pre>{`data: { "who": "Smith & Sons", "block": "<b>Ready</b>" }

{{data.who}}      →  Smith &amp; Sons      shows as:  Smith & Sons
{{data.block}}    →  &lt;b&gt;Ready&lt;/b&gt;  shows as:  <b>Ready</b>   (as text)
{{{data.block}}}  →  <b>Ready</b>          shows as:  Ready        (in bold)`}</Pre>
        <p class="mt-2 text-sm text-stone-600">
          The default is deliberate. Merge values are not always yours: a broadcast greeting someone
          by <Code>{'{{customer.first_name}}'}</Code> renders a <b>profile attribute</b>, and those
          can be written with the public tracking key from any web page. Rendered as markup, a saved
          value could put someone else's link into mail sent from your verified domain. So reach for
          three braces only for content you generate — <Code>{'{{{data.body_html}}}'}</Code> for a
          body you composed — and never for something a visitor could have set.
        </p>
        <p class="mt-2 text-xs text-stone-500">
          This applies to <b>HTML email bodies</b> — transactional, broadcasts and automations
          alike. Subjects, SMS and WhatsApp bodies are plain text: nothing is escaped there, and
          three braces mean nothing. Links are checked too: an <Code>href</Code> that resolves to
          anything but <Code>http</Code>, <Code>https</Code>, <Code>mailto</Code> or <Code>tel</Code>{' '}
          is dropped. An unknown token renders as nothing rather than leaving{' '}
          <Code>{'{{…}}'}</Code> visible.
        </p>

        <p class="mt-4 text-sm font-semibold text-ink-900">Who it goes to: to, cc and bcc</p>
        <p class="mt-1 text-sm text-stone-600">
          Each field takes a single address or a list. They mean different things, and the
          difference is worth a moment:
        </p>
        <ul class="mt-2 space-y-1.5 text-sm text-stone-700">
          <li>
            • <Code>to</Code> — the people the message is <b>for</b>. Several addresses means{' '}
            <b>several messages</b>, one each, every one rendered for that person.
          </li>
          <li>
            • <Code>cc</Code> — a visible copy. <b>One</b> message, rendered for the{' '}
            <Code>to</Code> recipient, that the cc'd person also receives and can see they share.
          </li>
          <li>
            • <Code>bcc</Code> — the same, but no other recipient can see the address.
          </li>
        </ul>
        <Pre>{`curl -X POST ${origin}/v1/send \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer sk_live_your_secret_key' \\
  -d '{ "template": "receipt",
        "to":  ["jane@example.com", "bob@example.com"],
        "cc":  ["accounts@acme.com"],
        "bcc": ["archive@acme.com"],
        "data": { "order": "1234" } }'

# Jane and Bob each get their own message, greeting them by their own name.
# The accountant and the archive are copied on BOTH.
# → { "sent": 2, "requested": 2,
#     "results": [ { "to": "jane@example.com", "sent": true,  "message_id": "…" },
#                  { "to": "bob@example.com",  "sent": true,  "message_id": "…" } ],
#     "recipients": { "to": 2, "cc": 1, "bcc": 1 } }`}</Pre>

        <p class="mt-3 text-sm font-semibold text-ink-900">Several recipients, one at a time</p>
        <p class="mt-1 text-sm text-stone-600">
          A list of <Code>to</Code> addresses is a <b>fan-out</b>, not one message with several
          names on it: each recipient gets their own message, their own{' '}
          <Code>{'{{customer.*}}'}</Code> values and their own <Code>message_id</Code>, and each is
          checked for consent on their own. One person being unsubscribed never stops anyone else's
          message. <b>A copy, by contrast, rides on every message</b> — two <Code>to</Code>{' '}
          addresses and one <Code>cc</Code> means the cc'd person receives two emails.
        </p>
        <p class="mt-2 text-sm text-stone-600">
          <b>The response follows the request.</b> Pass a string and you get{' '}
          <Code>{'{ "sent": true, "message_id": … }'}</Code>, exactly as before. Pass a list — even
          a list of one — and you get <Code>results</Code>, one entry per address, each with its own{' '}
          <Code>sent</Code> and either a <Code>message_id</Code> or a <Code>reason</Code>. Because a
          call can now partly succeed, retry from <Code>results</Code>, never the whole request:
          there is no de-duplication, so a blanket retry re-sends to everyone it already reached.
        </p>

        <p class="mt-3 text-sm font-semibold text-ink-900">Copies are addresses, not people</p>
        <p class="mt-1 text-sm text-stone-600">
          A cc or bcc never becomes a profile, never enters a segment, and is never counted as a
          customer. They are also not subscribers: an unsubscribe does <b>not</b> stop a copy,
          because someone who left your newsletter never agreed or declined to be cc'd on an
          invoice. What does stop one is a hard bounce or a spam complaint — that address is
          dropped, the message still goes to everyone else, and the response says which under{' '}
          <Code>dropped</Code>. A dropped bcc is only ever counted there, never named.
        </p>
        <p class="mt-2 text-xs text-stone-500">
          Up to <b>20</b> addresses in <Code>to</Code>, and up to <b>20</b> on any one message
          counting its <Code>to</Code>, cc and bcc. Duplicates are collapsed. Sending is billed per
          recipient. Email only — <Code>cc</Code> or <Code>bcc</Code> on an SMS or WhatsApp key is a{' '}
          <Code>400</Code>, while a list of <Code>to</Code> numbers fans out there too.
        </p>

        <p class="mt-4 text-sm font-semibold text-ink-900">Attaching files</p>
        <p class="mt-1 text-sm text-stone-600">
          Send files with the message by passing them base64-encoded. <Code>filename</Code> and{' '}
          <Code>content</Code> are required; <Code>content_type</Code> is optional and inferred from
          the extension when you leave it out. Email only — an SMS or WhatsApp key with attachments
          is a <Code>400</Code> rather than a send that quietly drops them.
        </p>
        <Pre>{`curl -X POST ${origin}/v1/send \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer sk_live_your_secret_key' \\
  -d '{ "template": "receipt",
        "to": "jane@example.com",
        "data": { "order": "1234" },
        "attachments": [
          { "filename": "invoice.pdf",
            "content_type": "application/pdf",
            "content": "JVBERi0xLjQK…" } ] }'
# → { "sent": true, "message_id": "…", "attachments": 1 }`}</Pre>
        <p class="mt-2 text-sm text-stone-600">
          Up to <b>20 files</b> and <b>25 MB</b> in total, measured on the decoded bytes. Bear in
          mind that base64 inflates the request by about a third, and that many mailboxes reject a
          message over 25 MB outright — for anything large, link to the file instead of attaching
          it. Executable file types are refused: sending one gets your domain blocklisted. Anything
          over a limit is a <Code>400</Code> naming the file, before the message is sent.
        </p>

        <p class="mt-4 text-sm font-semibold text-ink-900">Who does not receive it</p>
        <p class="mt-1 text-sm text-stone-600">
          Addresses that hard-bounced, and people who reported you as spam, are{' '}
          <b>always skipped</b> — mailing them damages your ability to reach everyone else, and
          cannot help the recipient. People who unsubscribed are skipped too, unless the request
          sets <Code>"ignore_unsubscribe": true</Code>. Use that only for messages the recipient
          triggered and needs, like a login code, where not sending locks them out of their own
          account. For SMS and WhatsApp the same flag overrides a channel opt-out; an email
          unsubscribe never blocks a text.
        </p>

        <p class="mt-4 text-sm font-semibold text-ink-900">What to retry</p>
        <p class="mt-1 text-sm text-stone-600">
          This call is <b>synchronous</b> — it hands the message to the provider while you wait. A{' '}
          <Code>502</Code> means that handover failed (our mail server restarting, a provider
          outage): <b>nothing was sent</b>, and retrying after a short pause is the right response.
          Retry that one alone, with a growing delay.
        </p>
        <p class="mt-2 text-sm text-stone-600">
          Nothing else is worth retrying. A <Code>200</Code> with <Code>"sent": false</Code> is a
          decision we made about the recipient, and a <Code>4xx</Code> is something to fix in the
          request — both will do the same thing next time. There is <b>no de-duplication</b> on this
          endpoint, so retrying a call that actually succeeded sends a second message; only retry
          when you got no success back.
        </p>
        <p class="mt-2 text-xs text-stone-500">
          Broadcasts and automations behave differently: those are queued, and a send that fails
          transiently is retried for you with a growing delay until it succeeds or is recorded as
          failed. This endpoint is the one case where the retry is yours.
        </p>

        <p class="mt-3 text-xs text-stone-500">
          A skipped send is still <Code>200</Code>, with{' '}
          <Code>{'{ "sent": false, "reason": … }'}</Code> — a decision, not a failure, so there is
          nothing to retry. <Code>404</Code> means no message carries that key in this workspace;{' '}
          <Code>409</Code> means it exists but isn't ready to send yet (no content, or no From);{' '}
          <Code>401</Code> means the key is wrong, revoked, or is the public write key rather than a{' '}
          <Code>sk_live_</Code> secret.
        </p>
      </Card>

      {/* ---- Server-side admin API ---- */}
      <Card class="p-6">
        <h3 class="font-bold text-ink-900">3. Server-side admin API (bearer token)</h3>
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
          <b>automations</b> and make it eligible for <b>broadcasts</b>. <Code>email</Code> is the
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
        <div class="mx-auto flex max-w-3xl items-center justify-between gap-2.5 px-6 py-4">
          <div class="flex items-center gap-2.5">
            <span class="grid h-8 w-8 place-items-center rounded-lg bg-brand-500 text-ink-950">
              <svg viewBox="0 0 24 24" fill="none" class="h-5 w-5" stroke="currentColor" stroke-width="2">
                <path d="M3 12c4-7 14-7 18 0-4 7-14 7-18 0Z" stroke-linejoin="round" />
                <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <div class="font-display text-[15px] font-bold text-ink-950">Customer Journeys — API</div>
          </div>
          <a data-testid="docs-back-home" href="/" class="text-sm font-semibold text-brand-700 hover:underline">
            ← Back to homepage
          </a>
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
