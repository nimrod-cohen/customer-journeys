# Merge-tag HTML escaping + transactional attachments

Two independent work items, written up together because the same integration
(the housing app at `~/dev/housing` moving its per-company email onto
`/v1/send`) surfaced both. **Item 1 is a security fix and stands on its own
merits — do it regardless.** Item 2 is only needed if we decide housing should
keep attaching report PDFs rather than linking to them.

Findings below reference the tree as of `2026-08-30`; re-check line numbers.

---

## Item 1 — Merge tags render unescaped into email HTML

### The problem

Both HTML render paths substitute merge values into compiled template HTML with
no escaping:

- `services/dispatcher/src/core.ts:257` — `renderTemplateBody`, used for
  broadcasts and automations.
- `services/local-api/src/transactional-send.ts:160-161` — `renderTransactional`,
  which calls the shared `renderExpression`
  (`packages/shared/src/expression.ts:98`).

For the transactional path the values come from `data.*`, supplied by whoever
holds the `sk_live_…` secret key — a trusted backend. There the impact is mostly
correctness: a value like `Smith & Sons` or `<3` mangles the layout.

The broadcast path is the real problem. Its merge map is
`{ ...payload.merge, ...customerMerge(profile) }`
(`services/dispatcher/src/dispatch.ts:384`) — i.e. **profile attributes**. Those
are writable by anyone holding a `pk_live_` write key, which we document as
public and safe to embed in a web page (`web/src/screens/ApiDocs.tsx`, "Tracking
API"). `POST /v1/identify` is keyed by email and upserts traits, so the writer is
not limited to their own profile.

Attack chain:

1. Lift the `pk_live_` key out of any customer's page — it is meant to be there.
2. `POST /v1/identify` for a *third party's* email address with
   `traits: { first_name: '<a href="https://phish.example">Update your details</a>' }`.
3. The next broadcast or automation email that greets by first name renders that
   anchor verbatim, sent from the workspace's verified, DKIM-signed domain.
4. Our click-tracking rewrite (`rewriteLinks`, `services/dispatcher/src/core.ts`)
   then wraps the injected URL in a `journeys.on-grow.com/t/<token>` link, so the
   recipient's status bar shows *our* domain.

This is not XSS — mail clients strip `<script>`. It is content injection into
mail sent to a third party, carrying the reputation of both the customer's domain
and ours. For a sending platform that is the more damaging of the two.

### The fix

Escape at the two HTML sinks. **Do not add escaping inside `renderExpression`** —
it has five call sites and three of them must not HTML-escape:

| Call site | Consumer | Escaping |
|---|---|---|
| `packages/shared/src/expression.ts:119` (`resolveValueSpec`) | writes profile attributes to Postgres | **No** — would store `&amp;` in the database |
| `packages/runner-webhook/src/execute.ts:70` | webhook URL / body | **No** — needs URL/JSON encoding, a different context |
| `services/automation-runner/src/run.ts:330` | parsed as a date anchor | **No** |
| `services/local-api/src/transactional-send.ts:160` | email **subject** | **No** — a subject is plain text; entity-escaping shows a literal `&amp;` in the inbox |
| `services/local-api/src/transactional-send.ts:161` | email **HTML body** | **Yes** |
| `services/dispatcher/src/core.ts:257` (`renderTemplateBody`) | email **HTML body** | **Yes** |

Suggested shape — add to `packages/shared/src/expression.ts` alongside the
existing function, so the non-HTML callers are untouched *by construction*
rather than by a correctly-passed flag:

```ts
/** Escape a merge value for HTML text context. `&` first, or you double-escape. */
export function escapeHtmlValue(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render into an HTML sink. `{{token}}` is escaped; `{{{token}}}` is written raw,
 * for the deliberate "this field carries a designed HTML block" case.
 */
export function renderExpressionHtml(
  template: string,
  merge: Readonly<Record<string, string>>,
  onUnknown: 'empty' | 'keep' = 'empty',
): string
```

Implementation notes that will bite otherwise:

- **Match the triple-brace form first.** A single regex with the triple
  alternative leading (`/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g`)
  is simpler than two passes and avoids a raw-substituted value being re-scanned
  by the second pass. Never run the double-brace pass over the output of the
  raw pass — that is a self-inflicted injection.
- **Preserve each caller's existing unknown-token behaviour.** They differ today
  and the difference is deliberate: `renderTemplateBody` returns `match` (leaves
  the literal `{{token}}` in place), `renderExpression` returns `''`. Unifying
  them as a drive-by change will alter live email output. Hence the `onUnknown`
  parameter above.
- **`expandCustomerToken` must still run** on the key before lookup, in both the
  escaped and raw branches, or `{{customer.tier}}` stops resolving.

### Attribute and URL context

Entity-escaping is correct for text context and for quoted attribute values, but
it does nothing about a token whose *value is a URL*:
`<a href="{{data.link}}">` with `javascript:` / `data:` / `vbscript:` still
executes in the clients that honour it.

`rewriteLinks` already walks every `http(s)` link in the body for click tracking,
which makes it the natural place to enforce a scheme allowlist — `http`, `https`,
`mailto`, `tel`, and neutralise anything else (drop the `href` rather than
rewriting it). Do this in the same pass; a second HTML walk is wasted work.

### Rollout — this is a breaking change

Any existing template that relies on a merge value carrying markup will start
showing escaped tags to recipients. Sequence it:

1. Ship `{{{token}}}` raw support **first**, escaping still off. Deploy.
2. Audit live templates for tokens that are meant to render markup — the
   substitution is textual, so a heuristic scan of stored template HTML plus the
   `data.*` keys real integrators send will find them. Migrate those to triple
   braces, per workspace.
3. Flip escaping on for the double-brace form. Announce it — integrators sending
   HTML through `data.*` need to know before their mail changes shape.
4. Optional, and worth it: surface the distinction in the email designer, so a
   field can be marked as carrying HTML rather than requiring the integrator to
   remember brace counts.

### Tests

Unit, in `packages/shared`:

- `{{data.x}}` with `<b>hi</b>` → escaped entities.
- `{{{data.x}}}` with the same → verbatim.
- `Smith & Sons` → `Smith &amp; Sons`, and **not** `Smith &amp;amp; Sons`
  (the `&`-first ordering).
- A raw value that itself contains `{{data.y}}` is **not** re-substituted.
- Unknown token: `''` under `onUnknown: 'empty'`, literal `{{…}}` under `'keep'`.
- `{{customer.tier}}` and `{{customer.attributes.tier}}` still resolve to the
  same value.

Behavioural, at the sinks:

- Transactional: subject keeps `&` literal while the body escapes it — the same
  `data` value rendering differently in the two halves is the whole point.
- Dispatcher: a profile trait containing `<a href=…>` reaches the recipient as
  visible text, not as a link. Write this one as the regression test for the
  attack chain above and name it accordingly.
- `rewriteLinks`: a `javascript:` href is neutralised, not tracked.

### Acceptance

Per `CLAUDE.md`: typecheck + Vitest + e2e all green before `main`, and bump the
root `package.json` version (minor — this is a feature plus a behaviour change).

---

## Item 2 — Attachments on `/v1/send` (conditional)

**Only needed if housing keeps attaching report PDFs.** The alternative is to
link to the reports from the body, which needs no work here at all. Confirm the
decision before starting.

### What housing needs

`src/server/routes/updates.js:263-291` builds an attachment array per update:
uploaded update files plus the linked monthly report PDFs, read off disk, one
message per investor with the same attachments repeated. Typical send is 8–20
recipients; PDFs are the bulk of the payload.

### Why it is not a small change

`packages/email/src/ses-client.ts:183` sends via SESv2 `SendEmailCommand` with
`Content.Simple`, which has **no attachment support**. Attachments require
`Content.Raw` — a full MIME message we assemble ourselves. The three transports
diverge here:

- **SES** (`ses-client.ts`) — build raw MIME. `nodemailer`'s `MailComposer` is
  already in the tree via the SMTP transport and will produce the buffer; do not
  hand-roll MIME boundaries.
- **Resend** (`resend-client.ts`) — native `attachments` support, straightforward.
- **Self-hosted SMTP** (`smtp-client.ts`) — nodemailer, native support. Note it
  sets its own `Message-ID` before sending; keep that.

`SendEmailInput` (`ses-client.ts:58`) gains an optional
`attachments?: readonly { filename: string; content: Buffer; contentType: string }[]`,
and each transport implements it. Leaving it unimplemented in one transport
should be a type error, not a silent drop.

### API surface

```
POST /v1/send
{ "template": "investor-update",
  "to": "investor@example.com",
  "data": { … },
  "attachments": [
    { "filename": "August report.pdf",
      "content_type": "application/pdf",
      "content_base64": "JVBERi0…" } ]
}
```

Constraints to enforce server-side, with clear 4xx messages:

- **Total message size.** SES hard-caps at 10 MB *after* base64 (~33% inflation),
  so cap the decoded total around 7 MB and reject above it. Say the actual number
  in the error — an integrator hitting an opaque limit loses an afternoon, which
  is the standard the existing validation messages already set.
- **Filename sanitisation.** Strip path separators and control characters; a
  filename crosses into the recipient's filesystem.
- **Content type allowlist** rather than trusting the caller's string. PDFs and
  images cover the known use; refuse executables outright.
- The request body ceiling on the gateway needs to accommodate this — check the
  REST API payload limit (10 MB at API Gateway) and that the Lambda's own limits
  agree. If they do not, attachments need an upload-then-reference flow instead,
  which is a materially bigger change — decide that before building.

### Semantics that must not drift

- Suppression, unsubscribe and the `sent:false` skip path are unchanged. A
  skipped send with attachments is still `200` with a reason.
- Attachment bytes are worth counting in the per-workspace cost view
  (`services/metering`) — egress on a 5 MB PDF × 20 investors is not noise.
- Idempotency is unchanged: `outbox.dedupe_key` still governs, and a retry must
  not double-send because the attachment payload differed.

### Tests

- Round-trip a small PDF through each of the three transports (mock the SDKs;
  `aws-sdk-client-mock` is already the convention) and assert the MIME structure
  for SES specifically — that is the path with real assembly risk.
- Oversize payload → 4xx naming the limit, before any provider call.
- Filename with `../` and with a newline → sanitised.
- A skipped recipient with attachments → `200 {sent:false}`, no provider call.

---

## Notes for whoever picks this up

- The housing integration is blocked on the Item 2 decision, not on Item 1 — but
  it will be written against the Item 1 raw syntax, passing the composed email
  body as `{{{data.body_html}}}` with a `{{data.subject}}` subject. Ship the raw
  form before that integration lands or it will be written against behaviour we
  are about to change.
- Unrelated, spotted while reading the tree: `cdp-local-ses_accessKeys.csv` sits
  in the repo root. Checked — it is covered by `.gitignore:16` (`*_accessKeys.csv`)
  and has never been committed, so nothing to do. Noted only so the next person
  who sees it does not have to check again.
