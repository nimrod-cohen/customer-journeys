# Raw-value convention, and explicit To / Cc / Bcc on `/v1/send`

Follow-up to `2026-08-30-merge-escaping-and-attachments.md`, which shipped as
`9ad9c50` (v0.124.0). Both items below come out of integrating the housing app
(`~/dev/housing`) against `/v1/send` for its per-company investor updates.

Line references are against the tree at `2026-08-31`.

---

## Item 1 — Stop making operators type `{{{ }}}`

### Why

`{{{token}}}` works, but it has the worst possible failure mode: **typing two
braces instead of three is silent.** Nothing errors, nothing warns — the message
sends, and the recipient gets a wall of visible `<div style="…">` markup. That is
not a hypothetical; it is what the first live housing test email did, with a
template whose text block read `{{data.body}}`. The operator sees the mistake only
after real mail has gone out.

Brace-counting is also invisible in review. Nobody scanning a template notices
that one of thirty tokens has a different number of braces.

### The design

**A `data.*` key whose name ends in `_html` renders raw. Everything else escapes.**

So the designer contains an ordinary `{{data.body_html}}` — no special syntax, no
brace counting — and the *name of the field* declares that it carries markup. The
intent is visible in the token itself, so a reviewer can tell which fields are
trusted without knowing a syntax rule.

**Hard constraint: this applies to `data.*` ONLY, never to `customer.*`.**

`data` is supplied by the holder of the `sk_live_` secret key, who is trusted.
`customer.*` comes from `customerMerge(profile)` — profile attributes, writable by
anyone holding the deliberately-public `pk_live_` write key via `/v1/identify`,
which is keyed by email and so is not even limited to the writer's own row. If the
convention extended to `customer.*`, an attacker would simply write a trait named
`bio_html` and walk straight back through the hole `9ad9c50` closed. The suffix
must be checked against the token's namespace, not the bare key name.

Precedence, so the rules compose predictably:

1. `{{{token}}}` → raw (unchanged; keep it working for anything already using it).
2. `{{data.*_html}}` → raw.
3. `SYSTEM_HTML_MERGE_KEYS` (`{{unsubscribe}}` and friends) → raw, as today.
4. Everything else → escaped.

### Also worth doing: a merge-field picker

The convention removes the syntax, but the deeper fix is that operators should not
be typing tokens at all. A dropdown in the email designer that inserts the correct
token — "Body (HTML)", "Subject", "Recipient name" — eliminates the whole class of
error, including for `{{{ }}}` templates that already exist. Populate it from the
keys the workspace's recent transactional calls actually sent, so it reflects
reality rather than a guess.

### Not recommended

A `{{data.body | raw}}` filter. It is still hand-typed syntax with a silent
failure mode, only longer.

### Tests

- `{{data.body_html}}` renders raw; `{{data.body}}` with the same value escapes.
- `{{customer.bio_html}}` **escapes** — the namespace check, and the security
  regression test for this item. Name it so its purpose survives.
- `{{data.x_html}}` where the value is absent → empty, not a literal token.
- Existing `{{{ }}}` templates are unaffected.

### Docs

`web/src/screens/ApiDocs.tsx` currently teaches three braces under "Filling in the
values". Lead with the `_html` convention and keep the brace form as a footnote.

---

## Item 2 — `cc` and `bcc` on `/v1/send`

### Why

Transactional mail routinely needs a copy to someone who is not the audience: an
admin on an order receipt, an accountant on an invoice, a broker on a statement.
Housing needs exactly this — its "CC admin" checkbox puts the sending admin on
each investor update. Today `/v1/send` has only `to`, so the housing integration
works around it by sending the admin one extra standalone message after the run.
That is a different thing from a cc: the admin's copy is not visibly a copy, and
it doubles as another send.

### API shape

```
POST /v1/send
{ "template": "receipt",
  "to":  "jane@example.com",
  "cc":  ["accounts@acme.com"],
  "bcc": ["archive@acme.com"],
  "data": { … } }
# → { "sent": true, "message_id": "…", "recipients": { "to": 1, "cc": 1, "bcc": 1 } }
```

Accept a string or an array for each. `to` stays required and stays **single** —
it identifies the profile the message is rendered for. Email only: `cc`/`bcc` on
an SMS or WhatsApp key is a `400`, the same way attachments are.

### Provider mapping

All three transports support this natively; no MIME assembly needed.

- **SES** (`packages/email/src/ses-client.ts:183`) — `Destination.CcAddresses` /
  `Destination.BccAddresses`.
- **Resend** (`resend-client.ts`) — `cc` / `bcc` fields.
- **Self-hosted SMTP** (`smtp-client.ts`) — nodemailer `cc` / `bcc`. Note the
  existing header-flattening guard (`smtp-client.ts:118`, which already
  contemplates "a second `Bcc:`") — CRLF in an address must not be able to inject
  a header. Validate every address before it reaches any transport.

`SendEmailInput` (`ses-client.ts:58`) gains optional `cc` / `bcc`; leaving one
unimplemented in a transport should be a type error, not a silent drop.

### The parts that are not obvious

This is where the work actually is. Every one of these is a correctness or privacy
bug if it is missed.

**1. The unsubscribe token belongs to the primary recipient.**
`buildUnsubscribeUrl` packs `workspace_id + email` of the `to` profile into one
signed `?t=` token, and it goes on **both** the body `{{unsubscribe}}` link and the
RFC 8058 one-click `List-Unsubscribe` header (`services/dispatcher/src/dispatch.ts:390-410`).
One message means one token. So a cc'd person who hits their mail client's
Unsubscribe button **silently unsubscribes the primary recipient** — one click,
no confirmation, wrong person, and the primary never learns why the mail stopped.

Recommended rule: **when a message has any `cc`/`bcc`, omit the RFC 8058 one-click
headers.** One-click is the dangerous half precisely because it is unconfirmed.
Keep the in-body link, which lands on the preference centre — a page that can name
the address it is about to act on, so a cc'd reader sees it is not theirs and
stops. Confirm the preference centre actually displays that address; if it does
not, that is part of this work.

**2. A bounce from a cc address must not suppress the primary.**
VERP tokens are per message (`packages/email/src/verp.ts`), and `messages_log`
holds one recipient per row, which `mail-events.ts:122-130` resolves to decide who
to suppress. A cc'd address that hard-bounces would therefore suppress the `to`
recipient — silently poisoning a good address.

Provider bounce notifications name the failed recipient. Use it: suppress the
address the DSN identifies, and fall back to the row's recipient only when the
notification does not say. Record cc/bcc addresses on the message row (or a child
table) so the DSN address can be validated as one this message actually went to,
rather than trusted blindly.

**3. Suppression and unsubscribe apply differently to copies.**
A cc/bcc address is not a subscriber. Check each one against **hard-bounce and
complaint suppression only** — drop that single address and send to the rest, so
a stale archive address never blocks a receipt. **Unsubscribe status must not
apply to cc/bcc at all**: they never subscribed, and their opt-out of a newsletter
says nothing about an invoice copy. A suppressed or dropped copy belongs in the
response, not in an error.

**4. Do not create profiles for cc/bcc addresses.**
`/v1/send` upserts a profile for an unknown `to`. Doing that for copies would fill
the CDP with accountants and archive mailboxes, sweep them into segments, and
start counting them as customers. Copies are addresses, not people.

**5. Personalization is the primary's.**
The message is rendered once, for the `to` profile, so `{{customer.*}}` is
theirs — a cc'd reader sees the primary's name. That is how cc works everywhere,
but it must be said in the docs, because "why does the accountant's copy greet him
as Jane" is otherwise a support ticket.

**6. Tracking attributes to the primary.**
Click tokens are deterministic per (workspace, source, url), so a cc's click
counts against the primary's message, and an open pixel fires as the primary. Not
worth fixing — worth documenting.

**7. Bcc must stay blind.**
Never echo bcc addresses into anything the to/cc can see, and be careful in logs:
the response is fine to count them (`"bcc": 1`), never to list them back.

**8. Limits and metering.**
Cap total recipients per send (SES allows 50 per destination; something like 20
total is friendlier and still generous) and refuse the request over it, naming the
limit. For cost, SES bills **per recipient** — meter recipients, not messages —
while attachment bytes are transferred once and should be metered once.

### Tests

- cc and bcc reach each transport in the right field (mock the SDKs, per the
  `aws-sdk-client-mock` convention).
- A message with cc carries **no** one-click `List-Unsubscribe` header, and one
  without cc still does.
- A hard bounce naming a cc address suppresses **that** address; the primary stays
  unsuppressed. This is the regression test for the sharpest bug here.
- A suppressed cc is dropped, the send still succeeds, and the response says so.
- An unsubscribed cc is **not** dropped.
- No profile row is created for a cc/bcc address.
- An address containing CRLF is rejected before any transport call.
- cc/bcc on an SMS/WhatsApp key → 400.

### Docs

`web/src/screens/ApiDocs.tsx`, in the transactional card: the new fields, that
`to` is the person the message is personalized for, that copies are not profiles
and are not subscribers, and that bcc stays hidden.

---

## Notes

- Item 2 unblocks housing's "CC admin" checkbox, which currently degrades to a
  separate follow-up message. Housing will switch to real `cc` once this ships;
  no housing change is needed before then.
- Item 1 has no housing dependency either way — it will pass `data.body_html`
  and use whichever form the template ends up with.
- Per `CLAUDE.md`: typecheck + Vitest + e2e green before `main`, and bump the root
  `package.json` version (minor for each item).
