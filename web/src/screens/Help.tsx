// Help (§12): reference material for the data model marketers most often
// conflate — email deliverability vs. consent vs. the suppression send-gate.
// Always visible (capability: null). Static content; no API calls.
import { Badge, Card, PageHeader } from '../ui/kit.js';

function Code({ children }: { children: string }) {
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
          greylisting). Unlike a hard bounce it does <b>not</b> change <Code>email_status</Code> — the
          address may well recover — so it’s tracked as activity, not as a mailbox state:
        </p>
        <ul class="mt-3 space-y-1.5 text-sm text-stone-700">
          <li>
            • Each one is recorded in the <Code>email_events</Code> table as{' '}
            <Code>type=bounce</Code>, <Code>sub_type=Transient</Code> (deduplicated by SES message
            id).
          </li>
          <li>
            • The system counts <i>distinct</i> soft bounces per address. After{' '}
            <b>3</b> it adds a suppression(<Code>soft_bounce</Code>) — so the address stops receiving
            mail even though <Code>email_status</Code> stays <Code>active</Code>.
          </li>
          <li>
            • The Events tab on a profile shows <i>behavioural</i> events (page views, purchases,
            etc.), not these delivery events — soft bounces aren’t surfaced in the UI yet.
          </li>
        </ul>
        <p class="mt-3 text-sm text-stone-500">
          So today, the authoritative way to know is the <Code>email_events</Code> log (or that the
          address is on the suppression list with reason <Code>soft_bounce</Code>). A profile-level
          “delivery health” view is a natural next addition if you want it visible in-app.
        </p>
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
    </section>
  );
}
