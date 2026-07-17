# Configuration Readiness & Alerts — design (2026-07-17)

## Problem

Configuration for sending is scattered (per-company connectors, per-workspace sending
domains + senders, per-company R2) and there is no single place that answers "am I set
up to send?". A sending domain can be verified while no email provider is connected (or
vice-versa), yet nothing tells the user the channel is effectively unusable. We want:

1. A **hard, correct definition** of "properly configured" per channel that, when unmet,
   **disables the channel** (broadcast medium greyed out, automation send steps skipped)
   — same mechanism as today's connector gating, just stricter/more complete.
2. A **global alert** (banner) when something is misconfigured.
3. A **dedicated "Setup" area** listing every readiness check (✅/⚠️/❌) with fix links.

Decisions (confirmed with the user): banner + dedicated Setup page; email requires
provider **and** verified domain **and** a sender; hard-disable + alert; scope = email,
sms (separate), whatsapp (separate), image storage (R2).

## Readiness model (single source of truth)

Computed **per workspace** (the sending context): email/domains/senders are per-workspace,
connectors/R2 are per-company (resolved via the workspace's company).

```
ReadinessItem  = { label, ok: boolean, fix?: { label, route } }
ReadinessCheck = {
  id: 'email' | 'sms' | 'whatsapp' | 'storage',
  label, severity: 'error' | 'warning',
  status: 'ready' | 'incomplete' | 'not_configured',
  items: ReadinessItem[],           // the sub-requirements
  summary: string,                  // one-line "what to do"
}
WorkspaceReadiness = {
  checks: ReadinessCheck[],
  channels: { email, sms, whatsapp: boolean },  // == each channel's `ready`
  errorCount, warningCount: number,
}
```

### Definitions

- **email** (severity error): ready iff a `resend` connector (trusted; `config.from` set)
  OR a `ses` connector **AND** ≥1 verified `sending_domains` row **AND** ≥1 `domain_senders`
  row. Items: "Email provider connected (SES or Resend)", "Verified sending domain" (SES),
  "A sender address (From)".
- **sms** (error): ready iff a `sms`/`019` connector exists and is enabled.
- **whatsapp** (error): ready iff a `whatsapp`/`meta_whatsapp` connector exists and is enabled.
- **storage** (warning): "ok" iff `company_r2_config` exists; else a warning
  ("Images are stored in the database; connect Cloudflare R2 for CDN-backed storage").
  Never disables anything — informational only.

`channelsForWorkspace` is refactored to return `{ email, sms, whatsapp }` derived from the
SAME computation (email now additionally requires a sender). So the existing broadcast
composer gating + automation runner skip + the automation inactive-node visual all reflect
the stricter definition automatically (hard-disable, per the decision).

## API

`GET /company/readiness` (capability `manage_content`, workspace-scoped via ctx) →
`WorkspaceReadiness`. Read is broad (marketers see the alert); fix links route to
owner-gated screens (Connectors / Sending domains).

## Frontend

- **Setup screen** `web/src/screens/Setup.tsx`, route `/setup`, nav item "Setup" with a
  red count badge when `errorCount > 0`. Each check renders a card: status pill, the
  sub-items with ✓/✗, and fix buttons (→ `/company/connectors`, `/settings/domains`, …).
- **Global banner** in `AppShell`: when `errorCount > 0`, a dismissible (per-session)
  amber/red banner "Some channels aren't fully set up — Review setup" linking to `/setup`.
  Fetched once on shell mount via `GET /company/readiness`. Warnings do NOT trigger the
  banner (Setup page only), so a missing-R2 workspace isn't nagged globally.

## Dev / e2e reconciliation (critical)

The e2e mocks all providers. To keep it green with the stricter gating + no spurious error
banner, the seed must present a **complete** config that still mocks:
- Add an **`email`/`ses` connector** to the seed company. `sesForWorkspace` reads
  `company_ses_config` (not connectors) and honors `LOCAL_SES_FORCE_MOCK`, so this makes
  email *ready/enabled* WITHOUT flipping sends to real SES (still mocked). The seed already
  has a verified domain + a sender.
- Keep the **sms/019** and **whatsapp/meta** connectors (NULL secret → text sends mock via
  `channelConfigForWorkspace` fallback; presence → channel enabled + ready).
- No R2 config in the seed → a storage *warning* (Setup page only, no banner) — asserted.

Result: all three channels ready → `errorCount === 0` → no banner in the general e2e; the
dedicated Setup spec asserts the checks render and that removing a piece produces an error.

## Tests

- Unit `readiness.test.ts`: pure `computeReadiness` across states (email missing each of
  provider/domain/sender; resend path; sms/whatsapp present/absent; r2 warning).
- Integration `readiness.integration.test.ts` (real PG): `GET /company/readiness` returns
  correct checks + `channels` booleans; email incomplete without a sender; sms/whatsapp;
  r2 warning; workspace-scoped.
- e2e `setup.browser.e2e.spec.ts`: Setup page lists all checks ready for the seed; the
  banner is absent when ready. (Existing specs stay green — seed is complete.)
- Update CLAUDE.md.
```
