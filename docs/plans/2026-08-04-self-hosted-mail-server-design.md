# Self-hosted mail server (2026-08-04)

## Goal

Run our own outbound mail server on Hetzner, so **explicitly authorized companies** can send
without a third-party email provider. Every other company continues to connect Resend (or SES,
if they have it). Adds a third email provider behind the existing `sendEmail` interface —
the dispatcher, gating pipeline, outbox, and suppression model are unchanged.

Pilot on small activities first, evaluate maintainability, then decide about the largest
activity. The design is sized for that: one box, one IP, no redundancy until the model proves out.

## Why (honest version)

- **AWS has refused SES production access repeatedly.** SES is not available to us at any price,
  so it is not the cost baseline.
- **Remaining providers are expensive at volume.** Resend-class pricing scales with send count;
  at ~1M/month it runs to hundreds of euros monthly. Hetzner hardware is ~€5/month.
- **Independence.** No provider can suspend, rate-limit, or reprice us.

**What this does not buy:** reliability. A provider absorbs blocklist and reputation incidents
on our behalf; self-hosted, we absorb them ourselves with no support channel. The real cost of
this project is operational attention, not hardware.

**Non-goals:** inbound mail for humans (no mailboxes, no replies-to-inbox), per-company dedicated
IPs, and moving the application off Fly.

## Prerequisites — verify BEFORE writing code

Any of these failing invalidates the plan. Confirm in this order:

1. **Outbound port 25 unblocked.** Hetzner blocks it by default; it is granted on request for
   legitimate use. Without it, nothing can be delivered.
2. **Reverse DNS (PTR) control.** Set from the Hetzner panel. Non-negotiable — Gmail rejects
   senders whose IP does not reverse-resolve, and the PTR name must forward-resolve back to the
   same IP.
3. **The assigned IP is clean.** Check against Spamhaus, Barracuda, SORBS before committing.
   Hetzner *cloud* ranges carry mixed sending reputation and Microsoft is aggressive about
   blocking bulk cloud space; Hetzner *dedicated* IPs are generally cleaner. If listed, request
   a different address.

Fly.io blocks outbound port 25 with no exception, which is why the mail server cannot live
beside `local-api`.

## Architecture

```
Fly.io (app + dispatcher)  --587 SMTP+TLS, SASL-->  Hetzner box  --25-->  the internet
        ^                                                |
        |<---- HTTPS: bounces, complaints ---------------|
```

Two machines, one job each. The app keeps its Fly deploy pipeline — including the property we
rely on, that a failed migration fails boot and Fly keeps the prior version.

**On the Hetzner box:**

| Component | Role |
|---|---|
| **Postfix** | Outbound queue and delivery: retries, per-destination TLS, connection reuse |
| **OpenDKIM** | Signs each message with the sending company's key |
| **mail-agent** (Node/TS) | Parses bounces + ARF complaints from local mailboxes, posts them to the app |

Postfix over an all-JavaScript MTA (Haraka): the queue and retry behaviour is the part we cannot
afford to get wrong, and Postfix's is decades-hardened. We write configuration, not logic.
Everything we actually own is TypeScript.

**App side:** a new `createSmtpEmailClient` in `@cdp/email`, satisfying the same `sendEmail(input)`
half of `SesEmailClient` that `createResendEmailClient` already satisfies. It opens an
authenticated TLS connection to the Hetzner box (nodemailer) and hands over the message.
Selected per company by `emailSenderForWorkspace`.

**Message-ID is ours.** Unlike SES, we generate the `Message-ID` before sending and store it in
the column currently holding `ses_message_id`. Bounce correlation becomes exact rather than
best-effort.

## DNS

**Our domain, once:**

| Record | Value | Purpose |
|---|---|---|
| `mail.<ours>` A | Hetzner IP | Server identity; must match Postfix HELO |
| PTR | `mail.<ours>` | Required by Gmail; must forward-resolve back |
| `bounce.<ours>` MX | `mail.<ours>` | Receives bounces |
| `_spf.<ours>` TXT | `v=spf1 ip4:<IP> -all` | Indirection, so IP changes don't touch customer DNS |
| `_dmarc.<ours>` TXT | `v=DMARC1; p=none; rua=...` | Our own alignment |

**Per customer domain — replaces the SES Easy-DKIM flow, and is simpler.**

We generate an RSA-2048 keypair per sending domain, store the private key encrypted with the
existing `@cdp/db` secret-crypto, and the customer publishes **one TXT record**:
`<selector>._domainkey.<their-domain>`.

Verification is a live DNS TXT lookup comparing the published public key to ours — no third
party, no polling a provider's status. This maps onto the existing interface:
`createDomainIdentity` generates and returns the record, `getIdentityVerificationAttributes`
performs the lookup. The sending-domain setup screen already renders DNS records and has a check
button, so the UI barely changes.

**The customer does not publish SPF, deliberately.** SPF is evaluated against the envelope
sender, which lives in *our* bounce domain. DMARC passes via **DKIM alignment** (`d=` is their
domain) — standard ESP practice, and one record for the customer instead of four.

**We do require their DMARC.** Since 2024 Gmail and Yahoo require bulk senders to publish SPF,
DKIM and DMARC. The domain check reads `_dmarc.<their-domain>` and refuses to verify without it.

## Bounces

**VERP.** Each message goes out with `Return-Path: bounce+<token>@bounce.<ours>`, where `<token>`
packs workspace id and message id.

**The token is HMAC-signed**, reusing the approach in `packSubscriptionToken`. An unsigned,
guessable bounce address would let an attacker mail a forged bounce and suppress any recipient
they choose; a signed token means they can only "bounce" a message they actually received.

**Classification — the rule that protects the list:**

| Status | Meaning | Action |
|---|---|---|
| **5.x.x** | Permanent (no such mailbox, no such domain) | Hard bounce → **suppress immediately** |
| **4.x.x** | Transient (mailbox full, greylisted, deferred) | **Never suppress.** Postfix is retrying |
| 4.x.x, queue lifetime exhausted | Postfix gave up | Final failure → soft-bounce counter |

**Suppression is driven by permanent failures only.** Suppressing on transient failures is the
classic way to destroy a list.

**Ingestion.** mail-agent watches the bounce mailbox, parses the delivery-status report, unpacks
the token to recover workspace and message, classifies, and posts to a new authenticated endpoint
on the app. That endpoint writes `email_events` and, for hard bounces, `suppressions` — the same
work the SES→SNS→Feedback path does today, so the logic is reused. **Workspace comes from the
token, never the request body** (inv. 2). Duplicate reports are normal and are absorbed by the
existing `(workspace_id, message_id, type)` uniqueness with `ON CONFLICT DO NOTHING`.

**Bonus.** Parsing Postfix's log for successful deliveries produces real `delivery` events, so
the "Delivered" column on the broadcast funnel — permanently zero today without SES feedback —
starts working.

## Spam reports

The most important signal we get. A complaint is worth far more attention than a bounce.

| Provider | Feedback loop | Action |
|---|---|---|
| Yahoo / AOL | ARF reports | Register (free) |
| Microsoft (Outlook/Hotmail) | ARF via JMRP + SNDS | Register both |
| **Google** | **none** | Postmaster Tools only — aggregate rate, no per-message reports |
| Apple, Comcast, La Poste | ARF | Register |

**Gmail never tells us who complained**, only the aggregate spam rate, and only above roughly
100 recipients/day. Gmail complainers cannot be suppressed individually — we watch the rate and
react.

Registered loops mail ARF reports to a mailbox on the Hetzner box; mail-agent parses them exactly
as it parses bounces, recovers the original recipient, and posts to the app.

**A complaint is a hard stop:** immediate, permanent suppression of that address. No retry.

Registration requires a live sending IP and a DKIM domain we control, so it happens after the box
is up and before real volume. Also verify our DKIM domain in **Google Postmaster Tools** — our
only visibility into Gmail.

## Warmup and throttling

A new IP has no reputation. Sending volume before earning trust gets us filtered in a way that is
hard to undo.

| Day | Volume |
|---|---|
| 1–3 | 50 → 200 |
| 4–7 | 500 → 2,000 |
| 8–14 | 5,000 → 20,000 |
| 15–30 | 50,000 → full |

Send to the **best recipients first** — recent, engaged, previously opened. Never skip a step. If
bounces or complaints rise, hold at the current level until they settle. Expect 4–6 weeks to full
volume. The pilot-on-small-activities plan *is* the warmup.

**Per-destination throttling.** Postfix must not open many simultaneous connections to one
provider; that reads as an attack. Limit concurrent connections and hourly volume per receiving
domain, raising as reputation builds. Sustained 4xx deferrals from Gmail or Microsoft mean back
off.

**Consistency matters.** 10k/day every day looks better than 70k every Sunday.

**One IP, one purpose.** Never mix system mail (password resets, invites) with tenant marketing
on the same IP. Transactional mail is high-engagement and protects reputation; marketing risks
it. A second IP is ~€0.50/month.

**Warmup is per-IP, not per-customer** — authorizing a new company does not restart it.

## Authorization

Only companies we explicitly authorize may send through the mail server.

- **Storage:** `companies.self_hosted_mail_enabled` boolean, default false. No new table.
- **Granting is platform-admin only**, through the existing `system-admin` cross-tenant path, so
  every grant and revoke lands in `admin_audit_log` for free.
- **Enforced twice:** (1) creating an `smtp` connector is rejected unless the company is
  authorized — no self-service onto our IPs; (2) the dispatcher re-checks at send time, so
  revocation also stops in-flight and scheduled sends.
- **Revocation is the kill switch.** Setting the flag false fails the gate at the next send and
  leaves the message in the outbox rather than losing it. This will be needed when a tenant starts
  generating complaints.
- **Postfix enforces it too.** The app authenticates with SASL and Postfix relays only for
  authenticated senders, so an application bug cannot turn the box into an open relay.
- **The verified-domain gate still applies.** Authorization grants infrastructure access, not a
  DKIM waiver. Unlike Resend, this provider is **not** `emailTrusted` — we are the ones vouching
  for the domain, so we verify it.

## Operations

| Metric | Alarm at | Source |
|---|---|---|
| Hard bounce rate | >2% | `email_events` |
| Complaint rate | >0.1% | feedback loops + Postmaster Tools |
| Queue depth | sustained growth | Postfix |
| Blocklist status | any listing | scheduled daily check |

Queue growth is the earliest warning that someone is deferring us. Blocklist checks run daily
against Spamhaus, Barracuda and SORBS — listings happen, and catching one same-day is the
difference between an afternoon and a fortnight.

**Backups.** The DKIM private keys are the only irreplaceable state; lose them and every customer
must republish DNS. They live encrypted in Postgres, so existing database backups cover them.
Postfix's queue is transient.

**Single point of failure.** One box, no redundancy. Postfix will hold mail for days if the app
is down, but if the box dies we are not sending. A second server roughly doubles cost to ~€9/month;
defer until the pilot proves the model.

## Testing

- **Unit** — SMTP client, VERP token pack/unpack, bounce and ARF parsing, status classification.
  All pure, no network.
- **Integration** — a throwaway in-process SMTP server; assert exactly what Postfix would receive.
- **Pre-launch** — mail-tester.com (target 10/10); Gmail "show original" to confirm SPF, DKIM and
  DMARC all pass.
- **Never point tests at the live box.** Extend the existing `LOCAL_SES_FORCE_MOCK` pattern.

## Implementation phases

1. **Prerequisites** — port 25, PTR, IP reputation check. Go/no-go.
2. **Box** — Postfix + OpenDKIM, our own DNS, relay-for-authenticated-only.
3. **Send path** — `createSmtpEmailClient`, the `smtp` connector, `self_hosted_mail_enabled` +
   platform-admin grant, dispatcher wiring.
4. **DKIM per domain** — keypair generation, encrypted storage, TXT verification, DMARC check.
5. **Bounces** — VERP tokens, mail-agent parser, ingestion endpoint, suppression wiring.
6. **Complaints** — feedback-loop registration, ARF parsing, Postmaster Tools.
7. **Warmup** — throttling config, monitoring, blocklist checks. Begin the ramp.

Phases 1–3 make mail flow. Phases 4–6 make it legitimate and safe. Phase 7 makes it deliverable.
Do not send meaningful volume before 7.

## Open questions

- Which company is the pilot, and on what activity?
- Separate IP for system mail at launch, or after the pilot?
- Does the ingestion endpoint live on `local-api`, or a dedicated internal route?
