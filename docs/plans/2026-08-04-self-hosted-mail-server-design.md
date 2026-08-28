# Self-hosted mail server (2026-08-04, rev. 2026-08-08)

## Goal

Run our own outbound mail server on Hetzner, carrying **our own sending only** to begin with,
across two independent streams:

1. **Marketing** — broadcasts and automations for activities we control end to end.
2. **Transactional** — OTPs, password resets, invites, verification, exposed as an API our
   other sites can call.

The main activity stays on **customer.io** for now. This is a controlled pilot: low volume,
our own lists, our own content, so send quality is never in question while we learn the
operational surface.

**Designed from the start to scale to large bursts** (tens of thousands of messages in
minutes) without rework. We are not building that capacity now; we are refusing to preclude it.

Plugs in behind the existing `sendEmail` interface for marketing and the existing
`TransactionalMailer` interface for transactional — the dispatcher, gating pipeline, outbox,
and suppression model are unchanged.

## Why

- **AWS has refused SES production access repeatedly.** SES is not available to us at any
  price, so it is not the cost baseline.
- **Remaining providers are expensive at volume**, and cost scales with send count while
  self-hosted cost is flat.
- **Independence.** No provider can suspend, rate-limit, or reprice us.

**What this does not buy:** reliability. A provider absorbs blocklist and reputation incidents
on our behalf; self-hosted, we absorb them ourselves with no support channel. The real cost of
this project is operational attention, not hardware.

**Non-goals for now:** inbound mail for humans (no mailboxes, no replies-to-inbox), moving the
main activity off customer.io, and moving the application off Fly.

## Prerequisites — verify BEFORE writing code

Any of these failing invalidates the plan. Confirm in this order:

1. **Outbound port 25 unblocked.** Hetzner blocks it by default; granted on request for
   legitimate use. Open the ticket immediately after creating the server, before installing
   anything. If refused, the plan stops.
2. **Reverse DNS (PTR) control.** Set from the Hetzner panel. Non-negotiable — Gmail rejects
   senders whose IP does not reverse-resolve, and the PTR name must forward-resolve back to the
   same IP.
3. **The assigned IP is clean.** Check against Spamhaus, Barracuda and SpamCop before
   committing. Hetzner *cloud* ranges carry mixed sending reputation; *dedicated* IPs are
   generally cleaner. If listed, request a different address.

Fly.io blocks outbound port 25 with no exception, which is why the mail server cannot live
beside `local-api`.

**Server:** Hetzner Cloud, smallest available tier. 1 vCPU is sufficient — CPU is never the
constraint for mail; RAM (≥2 GB) and receiver acceptance rates are. Do not oversize.

## Architecture

```
Fly.io (app + dispatcher)  --587 SMTP+TLS, SASL-->  smtp-out.<ours>  --25-->  the internet
        ^                                                 |
        |<---- HTTPS: bounces, complaints ----------------|
```

`smtp-out.<ours>` is a **hostname, not a machine**. Today it resolves to one box; later it can
resolve to several, or to a router in front of several. The app never learns how many nodes
exist — this is the single most important decision for future scale.

**On each mail node:**

| Component | Role |
|---|---|
| **Postfix** | Outbound queue and delivery: retries, per-destination TLS, connection reuse |
| **OpenDKIM** | Signs each message with the sending domain's key |
| **mail-agent** (Node/TS) | Parses bounces + ARF complaints, posts them to the app over HTTPS |

Postfix over an all-JavaScript MTA (Haraka): the queue and retry behaviour is the part we
cannot afford to get wrong, and Postfix's is decades-hardened. We write configuration, not
logic. Everything we own is TypeScript.

**App side:**

- `createSmtpEmailClient` in `@cdp/email` satisfies the same `sendEmail(input)` half of
  `SesEmailClient` that `createResendEmailClient` already satisfies. Selected per company by
  `emailSenderForWorkspace`.
- A second implementation satisfies `TransactionalMailer.send(TxEmail)` for the OTP stream.
  `packages/email/src/transactional.ts` already exists and already states the governing
  principle in its header: *transactional and marketing must not share a domain or reputation.*

**Message-ID is ours.** Unlike SES, we generate the `Message-ID` before sending and store it
where `ses_message_id` lives today. Bounce correlation becomes exact rather than best-effort.

### Interim relay (while Hetzner's port 25 is blocked)

Hetzner will not consider unblocking outbound 25 until an account is roughly a month old. Until
then the Hetzner box runs the **entire** pipeline and hands finished messages to an existing VPS
for final delivery:

```
Fly app --> Hetzner (accepts, signs DKIM, queues, logs) --587--> relay1 --25--> internet
                ^                                                              |
                +---------------- 25 inbound: bounces --------------------------+
```

**Hetzner's block covers ALL outbound port 25, including to your own relay.** Verified empirically:
`gmail-smtp-in:25` and `smtp.gmail.com:465` both time out, while `smtp.gmail.com:587` connects. So
the relay hop must use **port 587**, not 25 — a `relayhost` on port 25 silently times out.

**Inbound 25 is unaffected**, so bounces reach the Hetzner box today and the whole bounce pipeline
can be built and tested during the wait.

Relay side, kept deliberately lean (that box has another job):

- Postfix `submission` service on 587, `smtpd_client_restrictions = permit_mynetworks, reject`.
- The Hetzner IP added to `mynetworks` — no SASL backend, no certificate management. Acceptable for
  a single `/32` over a one-month bridge; spoofing a full TCP SMTP session is impractical.
- A narrow ufw rule allowing 587 **from the Hetzner IP only** (that host runs default-DROP ufw, so
  587 is otherwise unreachable — this was the failure that made the relay appear broken).
- No DKIM on the relay: Hetzner signs before relaying and the signature travels with the message.
- No bounce handling on the relay: bounces follow the MX to Hetzner regardless of who delivered.

**Cutover when 25 opens:** delete `relayhost`, remove the relay IP from `bounce` SPF once warmed,
drop the ufw rule and the `mynetworks` entry. Nothing else changes.

**Reputation note:** during the interim, the delivering IP is the relay's, so warmup accrues there,
not to Hetzner. Hetzner's own warmup starts when its port 25 opens.


## Sending pool — the scale-readiness design

Everything here exists so that going from one IP to twenty is **rows in a table, not a
rewrite**. With a single IP today the pool has one entry and the logic is a no-op.

**`sending_ips` table:**

| Column | Purpose |
|---|---|
| `ip`, `ptr_hostname` | The address and its reverse-DNS name |
| `provider`, `region` | Hetzner, and whoever comes later — see below |
| `stream` | `transactional` \| `marketing` — never mixed |
| `warmup_stage`, `daily_cap` | Per-IP ramp state |
| `enabled` | Kill switch per address |

**Five rules that keep scale cheap:**

1. **The app submits to one hostname.** Node count is invisible to the dispatcher.
2. **Warmup state is per-IP and persistent**, so a new address ramps independently without
   disturbing established ones.
3. **VERP tokens and Message-IDs encode no node identity.** Any node can send anything;
   bounces route back to the app over HTTPS regardless of which node sent.
4. **Throttling partitions by recipient domain, not by round-robin.** This is the subtle trap:
   five nodes each independently rate-limiting Gmail will send five times the intended rate.
   Assigning each receiving domain to one node keeps each node's local limit equal to the
   global limit, with no shared counter state. Round-robin would require distributed rate
   limiting — avoid it.
5. **Future IPs must span providers.** Twenty addresses in one Hetzner /24 reads as snowshoe
   spam to Spamhaus and would likely be refused by Hetzner regardless. A burst-capable pool
   grows across two or three hosts, gradually, justified by real volume history. Hence the
   `provider` column from day one.

**Realistic burst capacity**, for planning:

| Pool | Sustained rate | 40k takes |
|---|---|---|
| 1 warmed IP | 10–50/sec | 15–45 min |
| 4 warmed IPs | 50–200/sec | 4–12 min |
| 10–30 warmed IPs, multi-provider | 200–600/sec | ~2 min |

Sub-2-minute delivery of 40k is genuinely an ESP-scale capability. It is reachable, but by
sustained growth over quarters, not by provisioning. Until then, bursts drain over tens of
minutes and the app is unaffected — Postfix accepts everything in seconds and queues it.

## Transactional / OTP

**A separate stream in every sense:** its own subdomain, its own DKIM key, its own IP once
volume justifies a second, and its own warmup. Transactional mail is high-engagement and
protects reputation; marketing risks it. They must never share an address.

**API surface:** an authenticated endpoint our other sites call, behind the existing
`TransactionalMailer` interface. Needs per-caller API keys, rate limiting, and the same
`Message-ID` generation as the marketing path.

**OTPs are the last thing to migrate, not the first.** A marketing mail in spam is annoying; an
OTP in spam locks a user out of the product. They move only after the IP has a month of clean
history.

**No automatic provider fallback** (deliberate decision — list quality makes the failure mode
unlikely). The compensating controls are therefore mandatory:

- Alerting on transactional delivery latency and failure rate, in minutes not hours.
- A manual switch back to the previous provider, tested before OTPs migrate.

## DNS

**Infrastructure domain: `journeys.on-grow.com`.** Nothing is ever sent *from* it — every message
carries a customer's own From: domain. It exists to host the mail hosts, the bounce endpoint, and
the DKIM key targets.

| Name | Type | Value | Purpose |
|---|---|---|---|
| `mail.journeys` | A | Hetzner IP | MTA host; HELO name and PTR target |
| `relay1.journeys` | A | relay IP | Interim relay host; HELO name and PTR target |
| `bounce.journeys` | MX 10 | `mail.journeys.on-grow.com` | Bounces route here |
| `bounce.journeys` | TXT | `v=spf1 ip4:<relay> ip4:<hetzner> -all` | SPF inherited by customer CNAMEs |
| `journeys` | TXT | `v=spf1 -all` | Nothing sends from the bare domain |
| `_dmarc.on-grow.com` | TXT | `v=DMARC1; p=none; rua=...` | Org-level monitoring; tighten to quarantine then reject once reports are clean |

Every mail record must be **DNS-only**, never proxied — a proxy would hand out the CDN's address
instead of the sending IP and break both SMTP and reverse-DNS matching.

## Per-company sending domains — CNAME delegation

**Each company sends as itself.** `From: hello@customer.com`, signed with `d=customer.com`, with a
Return-Path inside their own domain. Receivers see a message indistinguishable from one their own
server sent.

The company publishes **three CNAMEs** and never touches DNS again:

```
bounce.customer.com          CNAME  bounce.journeys.on-grow.com
s1._domainkey.customer.com   CNAME  s1.<company-id>.dkim.journeys.on-grow.com
s2._domainkey.customer.com   CNAME  s2.<company-id>.dkim.journeys.on-grow.com
```

**Why CNAMEs rather than a DKIM TXT record** (this reverses the earlier revision of this document):

1. **Both SPF and DKIM align.** A CNAME applies to every record type at that name, so
   `bounce.customer.com` inherits our SPF *and* our MX from one record. The envelope sender sits in
   the customer's own organisational domain, so SPF aligns under DMARC's relaxed rule — and bounces
   still route back to us automatically.
2. **Key rotation stops being a customer problem.** With a TXT record, rotating a DKIM key means
   asking every customer to edit DNS, which in practice means never rotating. With CNAMEs we change
   the target value and every customer rotates without being involved.
3. **IP changes never touch customer DNS**, because their SPF resolves through to ours.

**Per-company key targets, never a shared one.** A single shared DKIM key would mean one compromise
affects every tenant and no customer could be rotated alone. Each company gets its own
`<company-id>` targets, which keeps the operational benefit without the shared-secret exposure.

The second selector (`s2`) exists purely for gap-free rotation: publish the new key on the unused
selector, switch signing over, retire the old one.

**Cost of this model:** two DNS records must be created on our zone per company at onboarding, so
the provider needs API automation (Cloudflare) rather than manual entry. Verification follows the
CNAME and compares the resolved key rather than reading a TXT value directly.

**DMARC is required of the customer.** Since 2024 Gmail and Yahoo require bulk senders to publish
SPF, DKIM and DMARC. The domain check reads `_dmarc.<customer-domain>` and refuses to verify
without it.

## Bounces

**VERP.** Each message goes out with `Return-Path: bounce+<token>@bounce.<ours>`, where
`<token>` packs workspace id and message id.

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
the token to recover workspace and message, classifies, and posts to an authenticated endpoint
on the app. That endpoint writes `email_events` and, for hard bounces, `suppressions` — the same
work the SES→SNS→Feedback path does today, so the logic is reused. **Workspace comes from the
token, never the request body** (inv. 2). Duplicate reports are absorbed by the existing
`(workspace_id, message_id, type)` uniqueness with `ON CONFLICT DO NOTHING`.

**Bonus.** Parsing Postfix's log for successful deliveries produces real `delivery` events, so
the "Delivered" column on the broadcast funnel — permanently zero today without SES feedback —
starts working.

## Reactivation on email change

**A bounce is a property of the address; a refusal is a property of the person.** Every rule
here follows from that one line.

`suppressions` is keyed `(workspace_id, email)` with `reason` in
`hard_bounce | permanent_soft_bounce | complaint | unsubscribe | manual`. Because the key is the
address, editing a profile's email already makes it sendable again — the new address simply
is not in the list. That is the desired behaviour for a bounce, and it needs no code.

Two things do need building:

**1. Reset the deliverability state.** `profiles.email_status` (`active | bounced | complained`)
is keyed by *profile*, not address, so it stays `bounced` after an email change and wrongly
marks the person in the UI and in any segment using `customer.email_status`. On an email change
in `updateProfile`, reset it to `active`.

**2. Do not resurrect people who refused.** The same key-by-address behaviour silently
un-suppresses unsubscribes and complaints, which is a compliance problem. On email change, read
the old address's suppression reason and branch:

| Old reason | On email change | Why |
|---|---|---|
| `hard_bounce` | reactivate | The address was bad, not the person |
| `permanent_soft_bounce` | reactivate | Address-derived |
| `complaint` | stay suppressed | They reported it as spam |
| `unsubscribe` | stay suppressed | Consent survives an address change |
| `manual` | stay suppressed | Chosen deliberately |
| none | reactivate | Nothing to carry |

Bounce-derived or absent → set `email_status = 'active'`. Refusal-derived → copy the suppression
onto the new address and leave the status unchanged.

**Root-cause fix, worth doing alongside.** The full unsubscribe writes only the email-keyed
`suppressions` row, not a profile-keyed `channel_optouts` row. If it wrote both, consent would
survive an address change *structurally* rather than by copying rows, and `channel_optouts` is
already enforced in the dispatcher pipeline. This is a pre-existing gap, independent of the mail
server.


## Deliverability monitoring

**This goes live before the first real recipient, not after.** Otherwise the first signal that
something is wrong is a customer complaint.

| Signal | Source | Mechanism | Cadence |
|---|---|---|---|
| Blocklist status | Spamhaus, Barracuda, SpamCop | DNSBL lookup | daily |
| Gmail spam rate, domain + IP reputation | **Google Postmaster Tools API** | API | daily |
| Microsoft complaint + spam-trap data | **SNDS** automated access | authenticated CSV fetch | daily |
| Microsoft complaints (per message) | **JMRP** feedback loop | ARF email → mail-agent | live |
| Yahoo complaints (per message) | **Yahoo CFL** | ARF email → mail-agent | live |
| Deferrals / rejections by receiving domain | Postfix logs | log parse | live |
| Inbox vs spam placement | Seed accounts on each major provider | send every campaign to seeds | per send |

**Gmail never reports who complained** — only aggregate rates, and only above roughly 100
recipients/day. Postmaster Tools is our sole Gmail visibility, so Gmail complainers cannot be
suppressed individually. We watch the rate and react.

**A complaint is a hard stop:** immediate, permanent suppression of that address, no retry.
Complaints damage reputation far more than bounces.

Feedback-loop registration requires a live sending IP and a DKIM domain we control, so it
happens after the box is up and before real volume. Spamhaus's free DNS queries are for
low-volume use; sustained automated querying needs their Data Query Service key.

**Alarm thresholds:**

| Metric | Alarm at |
|---|---|
| Hard bounce rate | >2% |
| Complaint rate | >0.1% |
| Queue depth | sustained growth |
| Blocklist | any listing |
| Transactional delivery latency | above baseline |

Queue growth is the earliest warning that a receiver is deferring us.

## Warmup and throttling

A new IP has no reputation. Sending volume before earning trust gets us filtered in a way that
is hard to undo.

| Day | Volume |
|---|---|
| 1–3 | 50 → 200 |
| 4–7 | 500 → 2,000 |
| 8–14 | 5,000 → 20,000 |
| 15–30 | 50,000 → full |

Send to the **best recipients first** — recent, engaged, previously opened. Never skip a step.
If bounces or complaints rise, hold at the current level until they settle. Expect 4–6 weeks to
full volume. The low-volume pilot *is* the warmup.

**Concentrate volume on one IP during warmup.** Warmup is driven by volume per address, so
splitting early traffic across two IPs makes both ramp at half speed. Add the second address
for *stream separation* once transactional volume justifies it, not for throughput.

**Per-destination throttling.** Limit concurrent connections and hourly volume per receiving
domain, raising as reputation builds. Sustained 4xx deferrals mean back off — pushing harder
makes delivery slower, not faster.

**Consistency matters.** 10k/day every day looks better than 70k every Sunday.

## Authorization

Only explicitly authorized companies may send through the mail server. During the pilot that
set is exactly one — ours — but the gate is built now so opening it later is a flag, not a
project.

- **Storage:** `companies.self_hosted_mail_enabled` boolean, default false. No new table.
- **Granting is platform-admin only**, through the existing `system-admin` cross-tenant path,
  so every grant and revoke lands in `admin_audit_log` for free.
- **Enforced twice:** creating an `smtp` connector is rejected unless authorized; and the
  dispatcher re-checks at send time, so revocation stops in-flight and scheduled sends too.
- **Revocation is the kill switch.** Setting the flag false fails the gate at the next send and
  leaves the message in the outbox rather than losing it.
- **Postfix enforces it too.** The app authenticates with SASL and Postfix relays only for
  authenticated senders, so an application bug cannot turn the box into an open relay.
- **The verified-domain gate still applies.** Authorization grants infrastructure access, not a
  DKIM waiver. Unlike Resend, this provider is **not** `emailTrusted`.

## Operations

**Backups.** The DKIM private keys are the only irreplaceable state; lose them and every domain
must republish DNS. They live encrypted in Postgres, so existing database backups cover them.
Postfix's queue is transient and the box is close to disposable.

**Single point of failure.** One node, no redundancy. Postfix holds mail for days if the app is
down, but if the box dies we are not sending. A second node roughly doubles cost; defer until
the pilot proves the model, and note that the pool design above already accommodates it.

## Testing

- **Unit** — SMTP client, VERP token pack/unpack, bounce and ARF parsing, status
  classification, pool selection, throttle partitioning. All pure, no network.
- **Integration** — a throwaway in-process SMTP server; assert exactly what Postfix would
  receive.
- **Pre-launch** — mail-tester.com (target 10/10); Gmail "show original" to confirm SPF, DKIM
  and DMARC all pass.
- **Never point tests at the live box.** Extend the existing `LOCAL_SES_FORCE_MOCK` pattern.

## Phases and gates

| Phase | Do | Gate before proceeding |
|---|---|---|
| **0** | Port 25 unblocked, PTR set, IP checked against blocklists | All three pass, or stop |
| **1** | Postfix + OpenDKIM + our DNS; relay only for authenticated senders | Box sends to a seed account |
| **2** | `createSmtpEmailClient`, `sending_ips` pool, connector, authorization flag, dispatcher wiring | Send path works end to end |
| **3** | DKIM per domain: per-company keypair generation, encrypted storage, Cloudflare API to publish `s1`/`s2` targets, CNAME-following verification, DMARC check | A domain verifies via its three CNAMEs |
| **4** | Bounces: VERP tokens, mail-agent parser, ingestion endpoint, suppression wiring | Hard bounce suppresses; soft bounce does not |
| **4b** | Reactivation on email change; consent carried forward; unsubscribe also writes `channel_optouts` | Editing a bounced address reactivates; editing an unsubscribed one does not |
| **5** | Monitoring: blocklists, Postmaster Tools, SNDS, JMRP, Yahoo CFL, log parsing, alarms | Every signal reporting |
| **6** | Seed-only sending across Gmail/Yahoo/Outlook | mail-tester 10/10; SPF+DKIM+DMARC pass; inbox not spam |
| **7** | Warmup ramp with our own low-stakes marketing | 4–6 weeks; complaints <0.1%, hard bounces <2%, no listings |
| **8** | Transactional stream: subdomain, API, keys, rate limiting | Stable for a month |
| **9** | OTPs migrate | Alerting proven; manual switch-back tested |
| **10** | Reassess volume, second IP, second node | — |

Phases 1–4 make mail flow correctly. Phase 5 makes it observable. Phases 6–7 make it
deliverable. **Do not send meaningful volume before phase 7 completes.**

## Open questions

- Which activity is the phase-7 warmup traffic?
- Does the bounce/complaint ingestion endpoint live on `local-api` or a dedicated internal route?
- Transactional subdomain naming, and whether it shares the pilot IP or waits for a second.
