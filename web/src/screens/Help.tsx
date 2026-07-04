// Help (§12): reference material for the data model marketers most often
// conflate — email deliverability vs. consent vs. the suppression send-gate.
// Always visible (capability: null). Static content; no API calls.
import type { ComponentChildren } from 'preact';
import { Badge, Card, PageHeader } from '../ui/kit.js';
import { ApiDocs } from './ApiDocs.js';

function Code({ children }: { children: ComponentChildren }) {
  return <code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.85em] text-ink-900">{children}</code>;
}

export function Help() {
  return (
    <section data-testid="help">
      <PageHeader
        title="Help"
        subtitle="How email status, consent, and suppression fit together."
      />

      <Card class="mb-6 p-6">
        <h2 class="text-lg font-bold text-ink-950">Email status, consent &amp; suppression</h2>
        <p class="mt-1 text-sm text-stone-600">
          Three <em>different</em> concepts — they’re easy to conflate, so here’s exactly what each
          one means and who sets it.
        </p>

        {/* 1. email_status */}
        <div class="mt-6 border-l-2 border-brand-300 pl-4">
          <h3 class="font-bold text-ink-900">
            1. <Code>email_status</Code> — deliverability <span class="text-stone-400">(what the mail provider tells us)</span>
          </h3>
          <p class="mt-1 text-sm text-stone-600">A single state of the mailbox:</p>
          <ul class="mt-2 space-y-1.5 text-sm text-stone-700">
            <li>
              <Badge tone="success">active</Badge> — address is good, mail delivers.
            </li>
            <li>
              <Badge tone="danger">bounced</Badge> — a <b>hard bounce</b>: the address is
              invalid/doesn’t exist. SES reports a <i>Permanent</i> bounce → the feedback service
              sets this. The address is effectively dead.
            </li>
            <li>
              <Badge tone="danger">complained</Badge> — the recipient hit <b>“mark as spam.”</b> An
              SES complaint → feedback sets this. The mailbox works, but sending more damages your
              sender reputation.
            </li>
          </ul>
          <p class="mt-2 text-sm text-stone-600">
            These are mutually exclusive delivery states, so a single column is right — but
            “unsubscribed” never belonged here.
          </p>
        </div>

        {/* 2. unsubscribed */}
        <div class="mt-6 border-l-2 border-brand-300 pl-4">
          <h3 class="font-bold text-ink-900">
            2. <Code>attributes.unsubscribed</Code> — consent <span class="text-stone-400">(the person’s choice)</span>
          </h3>
          <p class="mt-1 text-sm text-stone-600">
            A boolean, <b>orthogonal</b> to deliverability. Someone can be{' '}
            <Code>unsubscribed = true</Code> <i>and</i> bounced, or unsubscribed and complained — all
            at once. That’s exactly why it can’t be a value of <Code>email_status</Code> (which can
            only hold one).
          </p>
        </div>

        {/* 3. suppressions */}
        <div class="mt-6 border-l-2 border-brand-300 pl-4">
          <h3 class="font-bold text-ink-900">
            3. <Code>suppressions</Code> table — the enforced “do-not-send” list{' '}
            <span class="text-stone-400">(the outcome)</span>
          </h3>
          <p class="mt-1 text-sm text-stone-600">
            This is why “suppressed” isn’t a status option: it isn’t a property of the mailbox, it’s a
            separate per-workspace table that the <b>Dispatcher checks before every send</b>. A
            profile lands on it for a <b>reason</b>:{' '}
            <Code>unsubscribe</Code>, <Code>hard_bounce</Code>, <Code>complaint</Code>, repeated{' '}
            <Code>soft_bounce</Code>, or <Code>manual</Code>.
          </p>
          <p class="mt-2 text-sm text-stone-600">
            So <b>bounced/complained are signals; suppressed is the effect.</b> A hard bounce sets{' '}
            <Code>email_status=bounced</Code> and adds a suppression(<Code>hard_bounce</Code>); a
            complaint sets <Code>complained</Code> and suppression(<Code>complaint</Code>); an
            unsubscribe sets <Code>attributes.unsubscribed=true</Code> and suppression(
            <Code>unsubscribe</Code>) — but leaves <Code>email_status=active</Code> (the mailbox is
            fine, they just opted out). The Dispatcher refuses to send if a suppression exists, for{' '}
            <i>any</i> reason — that’s the single gate.
          </p>
        </div>
      </Card>

      {/* Summary table */}
      <Card class="mb-6 overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th class="px-4 py-2.5 font-semibold" />
              <th class="px-4 py-2.5 font-semibold">What it is</th>
              <th class="px-4 py-2.5 font-semibold">Who sets it</th>
              <th class="px-4 py-2.5 font-semibold">Example values</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-stone-100 align-top">
            <tr>
              <td class="px-4 py-3"><Code>email_status</Code></td>
              <td class="px-4 py-3 text-stone-700">mailbox deliverability</td>
              <td class="px-4 py-3 text-stone-700">feedback (SES) / manual</td>
              <td class="px-4 py-3 text-stone-700">active, bounced, complained</td>
            </tr>
            <tr>
              <td class="px-4 py-3"><Code>attributes.unsubscribed</Code></td>
              <td class="px-4 py-3 text-stone-700">consent (opt-out)</td>
              <td class="px-4 py-3 text-stone-700">unsubscribe flow / manual</td>
              <td class="px-4 py-3 text-stone-700">true / false</td>
            </tr>
            <tr>
              <td class="px-4 py-3">suppression row</td>
              <td class="px-4 py-3 text-stone-700">enforced do-not-send</td>
              <td class="px-4 py-3 text-stone-700">unsubscribe, feedback, manual</td>
              <td class="px-4 py-3 text-stone-700">
                reason: unsubscribe / hard_bounce / complaint / soft_bounce / manual
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* Soft bounce */}
      <Card class="p-6">
        <h2 class="text-lg font-bold text-ink-950">How do I know a mailbox soft-bounced?</h2>
        <p class="mt-2 text-sm text-stone-600">
          A <b>soft bounce</b> is a <i>temporary</i> delivery failure (mailbox full, server busy,
          greylisting). A single one does <b>not</b> change <Code>email_status</Code> — the address
          may recover — so it’s tracked as activity. But repeated soft bounces escalate:
        </p>
        <ul class="mt-3 space-y-1.5 text-sm text-stone-700">
          <li>
            • Each one is recorded in <Code>email_events</Code> as <Code>type=bounce</Code>,{' '}
            <Code>sub_type=Transient</Code> (deduplicated by SES message id).
          </li>
          <li>
            • The system counts the <b>distinct days</b> an address soft-bounces on with{' '}
            <b>no successful delivery in between</b> (a delivery resets the count; the days need not
            be consecutive). After <b>3 distinct days</b> the address becomes{' '}
            <Code>permanent_soft_bounce</Code>: its <Code>email_status</Code> flips from{' '}
            <Code>active</Code> to <Code>permanent_soft_bounce</Code> <b>and</b> a suppression with
            reason <Code>permanent_soft_bounce</Code> is added, so it stops receiving mail.
          </li>
          <li>
            • A profile’s <b>Delivery</b> tab shows its deliverability state, suppression, recent
            delivery events and the soft-bounce day count.
          </li>
        </ul>
      </Card>

      {/* CSV import: existing profiles */}
      <Card data-testid="help-import" class="mt-6 p-6">
        <h2 class="text-lg font-bold text-ink-950">What happens if I import an existing profile?</h2>
        <p class="mt-2 text-sm text-stone-600">
          Bulk CSV import (<b>Profiles → Import CSV</b>) is an <b>upsert</b> keyed on{' '}
          <Code>email</Code>: a row whose email already exists is <b>not</b> rejected and does{' '}
          <b>not</b> create a duplicate — it’s counted as <b>updated</b> (not “created”) in the
          result summary. This is deliberately different from the single <b>New profile</b> form,
          which treats a duplicate email as a conflict; bulk import assumes you’re{' '}
          <i>refreshing / enriching</i>, so it merges. For an existing email:
        </p>
        <ul class="mt-3 space-y-1.5 text-sm text-stone-700">
          <li>
            • <b>Attributes are shallow-merged</b> (<Code>existing || csv</Code>): a column in the
            CSV overwrites the same-named attribute; attributes <b>not</b> in the CSV are left
            untouched. Importing <Code>email,tier</Code> changes only <Code>tier</Code>.
          </li>
          <li>
            • <Code>unsubscribed</Code> is <b>preserved</b> unless your CSV has an explicit{' '}
            <Code>unsubscribed</Code> column — a re-import won’t silently re-subscribe someone who
            opted out.
          </li>
          <li>
            • <Code>external_id</Code> is set only if the CSV supplies a non-empty one; it won’t wipe
            an existing value.
          </li>
          <li>
            • <Code>email_status</Code>, suppressions, events, segment memberships and rolling
            features are <b>not</b> touched — only <Code>attributes</Code> / <Code>external_id</Code>{' '}
            / <Code>updated_at</Code>.
          </li>
        </ul>
        <p class="mt-3 text-sm text-stone-500">
          Two caveats: the merge is <b>shallow</b> — a JSON-object attribute value is replaced
          wholesale, not deep-merged; and “existing” is per-workspace and{' '}
          <b>case-normalised</b> by the workspace’s lowercase-emails policy, so{' '}
          <Code>Jane@Acme.com</Code> and <Code>jane@acme.com</Code> are the same profile when that
          policy is on. The mental model: bulk import = <b>“create or enrich”</b>, never
          overwrite-the-whole-record and never duplicate.
        </p>
      </Card>

      {/* Setting up Amazon SES */}
      <Card data-testid="help-ses" class="mt-6 p-6">
        <h2 class="text-lg font-bold text-ink-950">Setting up your Amazon SES account</h2>
        <p class="mt-2 text-sm text-stone-600">
          Each <b>company</b> sends through its <b>own</b> Amazon SES account. You create the AWS
          credentials once, save them under <b>Company settings → Amazon SES</b>, then verify each
          sending domain under <b>Workspace settings → Sending domains</b>. Here’s the whole path.
        </p>

        <h3 class="mt-5 font-bold text-ink-900">1. Create / sign in to AWS</h3>
        <p class="mt-1 text-sm text-stone-600">
          Go to <Code>https://console.aws.amazon.com</Code> and sign in (or create an account). The
          “console” is Amazon’s web UI — not a terminal.
        </p>

        <h3 class="mt-4 font-bold text-ink-900">2. Pick a region — and keep it consistent</h3>
        <p class="mt-1 text-sm text-stone-600">
          SES is <b>regional</b>: an identity verified in one region doesn’t exist in another. Use
          the <b>region dropdown at the top-right</b> of the console (e.g. <Code>il-central-1</Code>{' '}
          Tel Aviv, <Code>eu-west-1</Code> Ireland). The region you choose must match the{' '}
          <b>AWS region</b> you enter in Company settings.
        </p>

        <h3 class="mt-4 font-bold text-ink-900">3. Create an access key (IAM)</h3>
        <ul class="mt-1 space-y-1.5 text-sm text-stone-700">
          <li>• Open <b>IAM</b> (search “IAM” in the top bar) → <b>Users → Create user</b> (e.g. <Code>cdp-ses</Code>), no console access needed.</li>
          <li>• <b>Attach policies directly</b> → tick <Code>AmazonSESFullAccess</Code> → create.</li>
          <li>• Open the user → <b>Security credentials → Create access key</b> → “Application running outside AWS”.</li>
          <li>• Copy the <b>Access key ID</b> and <b>Secret access key</b> (the secret is shown once).</li>
        </ul>

        <h3 class="mt-4 font-bold text-ink-900">4. Save the credentials in this app</h3>
        <p class="mt-1 text-sm text-stone-600">
          <b>Company settings → Amazon SES</b>: enter the region, access key ID, and secret, then{' '}
          <b>Save</b>. The secret is encrypted at rest and never shown again (leave it blank when you
          edit the region/key later to keep it).
        </p>

        <h3 class="mt-4 font-bold text-ink-900">5. Verify a sending domain</h3>
        <p class="mt-1 text-sm text-stone-600">
          <b>Workspace settings → Sending domains → Add domain</b>. Open it to see the{' '}
          <b>DKIM CNAME records</b>, add them at your DNS provider, then <b>Check with SES</b>. SES
          verifies the domain once it detects the records (minutes to a few hours). Only a{' '}
          <b>verified</b> domain can have senders and send mail.
        </p>

        <p class="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-inset ring-amber-200">
          <b>SES sandbox:</b> new SES accounts start in the <b>sandbox</b>. Verifying a domain works
          there immediately, but you can only <i>send</i> to verified addresses until you request{' '}
          <b>production access</b> (SES console → <b>Account dashboard → Request production access</b>).
          Until your company has saved SES credentials, verification here is <b>simulated</b> (a
          local test mode) so you can explore the flow.
        </p>
      </Card>

      {/* ── Merge tags reference ───────────────────────────────────────── */}
      <Card class="mb-6 p-6" data-testid="help-merge-tags">
        <h2 class="text-lg font-bold text-ink-950">Personalization tokens <Code>{'{{…}}'}</Code></h2>
        <p class="mt-1 text-sm text-stone-600">
          Anywhere inside a campaign communication (email subject, email body, SMS / WhatsApp body,
          even a webhook body) you can drop a <Code>{'{{token}}'}</Code> placeholder. At send time
          it's substituted with the recipient's value. Unknown / missing tokens render as the
          empty string — they never leak the literal braces.
        </p>

        {/* 1. customer.* */}
        <div class="mt-6 border-l-2 border-brand-300 pl-4">
          <h3 class="font-bold text-ink-900">
            1. <Code>customer.*</Code> — the recipient's profile <span class="text-stone-400">(static identity + saved attributes)</span>
          </h3>
          <p class="mt-1 text-sm text-stone-600">
            Built-ins come from the <b>profile row</b>; everything else reads a <b>custom
            attribute</b> (<Code>customer.tier</Code> is shorthand for <Code>customer.attributes.tier</Code>
            — both resolve to the same value).
          </p>
          <ul class="mt-2 space-y-1.5 text-sm text-stone-700">
            <li>• <Code>{'{{customer.email}}'}</Code> — the recipient's email address</li>
            <li>• <Code>{'{{customer.external_id}}'}</Code> — your system's id for this profile</li>
            <li>• <Code>{'{{customer.first_name}}'}</Code>, <Code>{'{{customer.last_name}}'}</Code></li>
            <li>• <Code>{'{{customer.&lt;any_attribute&gt;}}'}</Code> — any key set via the Update profile node, the importer, or your ingest events</li>
          </ul>
        </div>

        {/* 2. event.* */}
        <div class="mt-6 border-l-2 border-violet-300 pl-4">
          <h3 class="font-bold text-ink-900">
            2. <Code>event.*</Code> — the <em>triggering</em> event's payload <span class="text-stone-400">(only for event-triggered campaigns)</span>
          </h3>
          <p class="mt-1 text-sm text-stone-600">
            When a campaign is triggered by an event (e.g. <Code>lead</Code>, <Code>webinar_completed</Code>),
            the <b>whole event payload</b> is frozen on this enrollment. Reach into it with deep
            dotted paths — the same one the event ingested with.
          </p>
          <ul class="mt-2 space-y-1.5 text-sm text-stone-700">
            <li>• <Code>{'{{event.type}}'}</Code> — the event name</li>
            <li>• <Code>{'{{event.amount}}'}</Code> — a top-level field on the payload</li>
            <li>• <Code>{'{{event.webinar_data.link}}'}</Code> — deep paths walk into nested objects</li>
            <li>• <Code>{'{{event.items.0.sku}}'}</Code> — numeric segments index into arrays</li>
          </ul>
          <p class="mt-2 text-xs text-stone-500">
            For manual / segment-entry triggers there's no event payload, so any{' '}
            <Code>{'{{event.*}}'}</Code> resolves to empty.
          </p>
        </div>

        {/* 3. journey.* */}
        <div class="mt-6 border-l-2 border-emerald-300 pl-4">
          <h3 class="font-bold text-ink-900">
            3. <Code>journey.*</Code> — per-enrollment variables <span class="text-stone-400">(this profile's run, this campaign)</span>
          </h3>
          <p class="mt-1 text-sm text-stone-600">
            Use an <b>Update journey</b> node to set a variable that lives <em>only</em> on this
            profile's journey through <em>this</em> campaign — it never touches the global profile.
            Read it back later in the same campaign with <Code>{'{{journey.&lt;key&gt;}}'}</Code>.
            Keys are <b>freeform</b> — type whatever you want; unset keys read as empty.
          </p>
          <p class="mt-2 text-sm text-stone-700">
            Example: an Update journey node sets <Code>cohort = "launch"</Code> at the start of the
            flow; a later email body says <em>"Welcome to the <Code>{'{{journey.cohort}}'}</Code> cohort"</em>.
          </p>
        </div>

        {/* 4. unsubscribe links */}
        <div class="mt-6 border-l-2 border-stone-300 pl-4">
          <h3 class="font-bold text-ink-900">
            4. Unsubscribe tokens <span class="text-stone-400">(built-ins, email only)</span>
          </h3>
          <ul class="mt-2 space-y-1.5 text-sm text-stone-700">
            <li>• <Code>{'{{unsubscribe_url}}'}</Code> — the raw preference-center URL for this recipient</li>
            <li>• <Code>{'{{unsubscribe}}'}</Code> — a ready-made anchor (use when you don't want to style your own link)</li>
          </ul>
          <p class="mt-2 text-xs text-stone-500">
            Both carry a tamper-proof token that identifies the recipient — never hand-build the
            link.
          </p>
        </div>

        <p class="mt-5 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600 ring-1 ring-inset ring-stone-200">
          Whitespace around tokens is tolerated (<Code>{'{{ customer.email }}'}</Code> works the same).
          The same tokens are also valid in an <b>Update profile</b> / <b>Update journey</b>{' '}
          <em>expression</em> value — e.g. setting <Code>attributes.last_event_type =
          {' {{event.type}}'}</Code>.
        </p>

        <p class="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600 ring-1 ring-inset ring-stone-200">
          <b>Order matters in Update profile / Update journey nodes.</b> The rows apply{' '}
          <b>top-to-bottom</b>, and a later row can reference a value set by an earlier row in the{' '}
          <em>same</em> node: set <Code>stage</Code> in the first row, then a second row can use{' '}
          <Code>{'{{customer.stage}}'}</Code> (or <Code>{'{{journey.<key>}}'}</Code> for a journey
          variable) and it already sees it. Use the <Code>▲</Code>/<Code>▼</Code> buttons to reorder.
        </p>
      </Card>

      {/* Developer API — also served publicly (no login) at /docs. */}
      <div class="mt-10">
        <h2 class="text-xl font-bold text-ink-950">Developer API</h2>
        <p class="mb-4 mt-1 text-sm text-stone-600">
          Push customers and their behaviour into the CDP over HTTP. This reference is also public at{' '}
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            data-testid="docs-link"
            class="font-semibold text-brand-700 hover:underline"
          >
            /docs
          </a>{' '}
          — no login required, so you can share it with your developers.
        </p>
        <ApiDocs />
      </div>
    </section>
  );
}
