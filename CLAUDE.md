# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is a **greenfield project**. The only file present is `CDP-BUILD-SPEC.md` (v8) — a complete, implementation-ready build specification. No code, package manifests, or infrastructure exist yet. The spec is the source of truth; build from it phase by phase (§17), test-first (§16A).

When the spec and this file disagree, **the spec wins** — and update this file. Section references below (`§N`) point into `CDP-BUILD-SPEC.md`.

## What is being built

A **serverless, multi-tenant marketing CDP** on AWS: companies get isolated workspaces, ingest behavioral events over HTTP, maintain unified customer profiles with rolling aggregates, define segments, and reach people via broadcasts (one-off blasts) and campaigns (multi-step journeys) through Amazon SES. An admin SPA provides segment/campaign builders, a WYSIWYG email editor, dashboards, and per-workspace cost views.

## Tech stack (all decisions are locked — see §0)

- **Backend:** TypeScript on Node.js 20+, AWS Lambda (real Node runtime, full npm incl. `sharp`).
- **HTTP entry:** API Gateway **REST API** (not HTTP API — chosen for request validation, per-workspace API keys + usage plans, native WAF).
- **Database:** Supabase (managed PostgreSQL), pooled connection from Lambda. System of record.
- **Queue:** SQS **FIFO** (+ DLQ), `MessageGroupId = profile_id`.
- **Email:** Amazon SES; each workspace sends from its own verified domain.
- **Auth:** Supabase Auth; validated at the gateway by a **Lambda authorizer** (REST API has no native JWT authorizer).
- **Email editor:** a CUSTOM in-house designer (`web/src/email-designer/`, ported from the owner's nomentor builder; Preact + @preact/signals) — this deliberately OVERRIDES the spec's GrapesJS choice. The surviving invariant is unchanged: the editor **emits MJML, never hand-rolled HTML** (design JSON → `mjml-serializer.ts` → server `compileMjml`, strict). Templates are a LIBRARY; attaching one to a broadcast/campaign CLONES it (`kind='copy'`, `source_template_id`) into an independently editable working copy.
- **IaC:** AWS CDK (TypeScript).
- **Frontend:** Preact/React SPA, Vite, static on S3 + CloudFront.
- **Testing:** Vitest or Jest; Supabase CLI / Testcontainers for ephemeral Postgres; `aws-sdk-client-mock` for AWS SDK; LocalStack for the thin E2E tier.

## Non-negotiable invariants

These are the properties the whole system exists to guarantee. Every change must preserve them; they are pass/fail acceptance gates (§18), not aspirations.

1. **Tenant isolation.** Every tenant-scoped row carries `workspace_id NOT NULL`. Isolation is defense-in-depth: (a) app code filters by `workspace_id` in *every* query, (b) Postgres RLS for user-context (admin app) connections. **Critical caveat (§3):** backend processing Lambdas connect with the Supabase **service role, which bypasses RLS** — they MUST scope by `workspace_id` in code; RLS is not their safety net.

2. **Workspace is never client-supplied.** Derive it from the API key at ingest (§7) and from the authorizer-injected claim on the admin API (§12). Never trust a `workspace_id` in a request payload.

3. **Per-profile event ordering.** `MessageGroupId = profile_id` gives per-profile FIFO. Code must be **idempotent and order-convergent** so a `progress` arriving before `profile_created` still resolves correctly (upsert a stub). Don't unit-test "the queue delivered in order" — that's SQS's job; test your convergence.

4. **No lost events.** `200` is returned only after SQS accepts (durable boundary). Forced failures retry, then go to DLQ — never vanish.

5. **Idempotency.** `events.event_id` is producer-supplied and the dedupe key (`INSERT ... ON CONFLICT DO NOTHING`); `outbox.dedupe_key` and broadcast `(broadcast_id, profile_id)` prevent double-sends.

6. **Segment SQL is compiled, never interpolated.** The rule-AST → SQL compiler (§8) whitelists fields/operators, emits parameterized SQL only, and **always** prepends `workspace_id = $ws`. This is security-critical and the single highest-value unit-test target.

7. **Sending is gated on verification.** The Dispatcher refuses to send for any workspace not `active`/verified (§10). Every send passes suppression → frequency-cap → quiet-hours checks.

## Roles (§3A)

Four roles. `system-admin` (in `platform_admins`) is the **only cross-tenant role** — the authorizer injects an `is_platform_admin` claim, RLS has a narrow exception for it, and every cross-tenant access is written to `admin_audit_log`. The other three (`owner` / `marketer` / `accounting`) are workspace-scoped via `workspace_users.role`; a user may hold different roles in different workspaces.

## Architecture flow

```
Producer --API key--> API GW REST (validate, usage plan, WAF)
  --> Ingest Lambda (resolve workspace from key, upsert profile) --> SQS FIFO (group=profile_id)
  --> Processor (idempotent, workspace-scoped): events -> profile_features -> re-eval segments -> membership diff + change_log
        -> segment entry drives campaign enrollment (§9B) and is available to broadcasts (§9A)
  --> outbox row -> 2nd SQS queue --> Dispatcher: suppression -> freq-cap -> quiet-hours -> SES (workspace config set) -> messages_log
SES events -> SNS -> Feedback Lambda -> per-workspace suppression + reputation policing (auto-suspend offender)
```

Broadcasts (§9A) and campaigns (§9B) both emit sends through the **same** outbox → Dispatcher → SES pipeline. Campaigns are a **table-driven state machine** over `campaign_enrollments`, swept by a scheduled Campaign-runner Lambda (chosen over Step Functions: cheaper for long multi-day waits at this scale).

## Planned repository structure (§19)

```
/infra            # CDK: all AWS resources, per-workspace usage plans, RLS-aware setup
/services/<fn>    # one dir per Lambda: ingest, processor, dispatcher, broadcast,
                  #   campaign-runner, feedback, unsubscribe, image, onboarding,
                  #   batch-eval, metering, api, authorizer
/packages/shared  # types, env/config, workspace-aware logging
/packages/db      # schema, migrations, RLS policies, pooled client
/packages/segments# rule AST + SQL compiler (mandatory workspace_id)
/packages/email   # SES client, MJML compile, header builders
/packages/tenancy # workspace context + role-check helpers
/web              # Preact/React SPA, GrapesJS+MJML editor, onboarding wizard
/scripts          # seed multi-workspace data, ordering/isolation tests, DLQ replay
/tests            # unit + integration (real Postgres) + thin E2E (LocalStack)
```

**Lambda handler pattern (§21):** keep each handler thin — it wires up a **pure, injected function** that holds the logic, so logic is unit-testable without the AWS/Lambda wrapper. Every handler is idempotent, stateless, and workspace-scoped.

## How to build (until tooling exists, this is the contract)

- **Build tenancy first** (workspaces, `workspace_id` everywhere, RLS, authorizer) before any feature, so nothing is retrofitted.
- **Work phase by phase (§17)**; a phase is done only when its §18 acceptance criteria pass as tests in CI.
- **Test-first (§16A):** write the phase's §18 criteria as failing tests, then implement to green.
  - **Don't mock Postgres** in the integration tier — ordering, idempotency, and isolation bugs live in the SQL and RLS. Use local Supabase (Supabase CLI) or Testcontainers.
  - **Do mock SES** — assert `SendEmail` is called with the right Configuration Set, only after suppression/cap checks; never send real mail.
- Local dev: SAM local / serverless-offline + LocalStack (SQS/S3/SNS/API GW) + Supabase CLI. Seed multiple workspaces with overlapping `external_id`s/emails to test isolation.

## Prerequisites Claude Code cannot do (§5)

Creating AWS/Supabase accounts, approving SES production access, and adding DNS records are human steps. Flag these rather than attempting them.

## Commands

Tooling: **pnpm workspaces + Turborepo + Vitest + TypeScript (strict)**. Node 20+. Run from repo root.

- **Install:** `pnpm install`
- **Build:** `pnpm build` (turbo → `tsc -b` per package)
- **Typecheck:** `pnpm typecheck`
- **Test (all):** `pnpm test` (Vitest)
- **Single test file:** `pnpm --filter <pkg> exec vitest run path/to/file.test.ts` (e.g. `--filter @cdp/segments`)
- **Lint / format:** `pnpm lint` · `pnpm format` (Prettier)
- **Local Postgres (Supabase CLI):** `pnpm db:start` then `pnpm db:migrate` (reset + re-apply migrations in `packages/db/supabase/migrations`)
- **LocalStack (SQS/S3/SNS/API GW):** `pnpm localstack:start` (docker compose; see `docker-compose.yml`)
- **Browser e2e (Playwright):** `pnpm --filter @cdp/web test:e2e`. **DB isolation (critical):** the e2e suite re-seeds (deletes+reinserts the Acme/Beta demo workspaces) on every run, so it is pinned to its OWN database `cdp_e2e` on its OWN ports (local-api :8788, web :5174) in `web/playwright.config.ts`. The dev stack (`cdp`, :8787/:5173) and the e2e stack coexist — running e2e does NOT touch live dev data, and dev servers need not be stopped. Never point the e2e at `cdp`.
- **CDK:** `pnpm --filter @cdp/infra synth` / `... deploy`

Workspace layout: packages are `@cdp/<name>` (shared, db, segments, email, tenancy); services are `@cdp/service-<name>`; infra is `@cdp/infra`; web is `@cdp/web`. Strict TS base in `tsconfig.base.json`; each package extends it and uses project references (`tsc -b`).

### Status of scaffolding

**Company → Workspace hierarchy (extends spec §6):** a `companies` table groups workspaces — every `workspace` has `company_id NOT NULL` (migration `0012`). Tenant **isolation is unchanged**: it stays at the workspace level (every tenant row carries `workspace_id`; RLS still keys on `workspace_id`). A company is purely the organizational parent so a platform admin can pick a company → a workspace within it (sidebar `CompanyWorkspacePicker`, fed by `GET /admin/companies`). Unassigned workspaces share a single `Unassigned` company (BEFORE-INSERT trigger, migration `0013`) rather than spawning one each. **A user belongs to ONE company:** access is per-workspace (`workspace_users`), but `addMember` rejects adding a user to a workspace whose company differs from one they're already in (409) — so a user's memberships always stay within a single company (which may own several workspaces).

**Identity key (overrides spec §6/§7):** a profile's per-workspace identity/merge key is **`email`**, NOT `external_id`. Events arrive from many source systems; email is the only identifier that stitches a person's events together, so ingestion requires `email`, profiles are `UNIQUE(workspace_id, email)` (migration `0010`), and the ingest/processor upserts + the manual `POST /profiles` all merge on `(workspace_id, email)`. `external_id` is optional metadata (the spec's original dedupe-by-external_id design is superseded).

**Sending domains are a LIST with a per-domain setup screen (extends §10):** a workspace can have several sending domains — `sending_domains` table (migration `0021`, workspace-scoped + RLS), each with a `verified` flag. UI is `/onboarding` (the **list only** — `SendingDomainsList`, nav label "Sending domains") → click a row or "Add domain" opens the **per-domain setup screen** `/onboarding/:id` (or `/onboarding/new`) — `SendingDomainDetail`. There you save the domain (pending), see its **Amazon SES Easy-DKIM CNAME records** to publish, and **verify via SES** (`POST /sending-domains/:id/check`). Verification uses **real SES**: on first open each domain is provisioned as an SES email identity (`SesEmailClient.createDomainIdentity` → 3 DKIM tokens, stored in `sending_domains.ses_identity` + `dkim_tokens`, migration `0023`); the check calls `getIdentityVerificationAttributes` and verifies ONLY when `DkimStatus === 'SUCCESS'` — no manual flip. **The DKIM CNAME target host is read FROM SES, never constructed** (multi-region: each company picks its own SES region): SES returns `DkimAttributes.SigningHostedZone` (region-specific, e.g. `dkim.il-central-1.amazonses.com`), persisted in `sending_domains.signing_hosted_zone` (migration `0029`) and used verbatim as `<token>.<signing_hosted_zone>` (`dkimCnameHost` in `handlers.ts`; pre-`0029` rows backfill on next load). Fallbacks only if SES omits it / local mock: `dkim.<region>.amazonses.com`, then `dkim.amazonses.com`. **SES is PER-COMPANY:** each company stores its own AWS SES credentials (`company_ses_config` table, migration `0024`: region + access_key_id + secret_access_key; secret is write-only over the API, never returned; company-scoped RLS like `companies`). Managed in **Company settings** (`CompanySesConfig`, API `GET/PUT/DELETE /company/ses-config`, capability `manage_sending_domain`). The sending-domain handlers build the SES client from the active workspace's company config (`sesForWorkspace` → `createSesClient` from `@cdp/email`); **with no company config they fall back to the local MOCK** SES, so dev/tests verify deterministically and the domain setup screen shows a "verification is simulated" note (`sesConfigured:false`). (The earlier `USE_REAL_SES` env switch and the `0022` TXT-token approach are both superseded/unused.) A `domain_senders` row (named "From" identity, migration `0020`) may only be created for a **verified** domain (enforced in `createDomainSender`) and is managed **inside that domain's setup screen** (local-part input fixed to `@<that-domain>`), never in a global list. API (all `manage_sending_domain`): `GET/POST /sending-domains`, `GET /sending-domains/:id` (domain + DNS records), `POST /sending-domains/:id/check`, `DELETE /sending-domains/:id` (blocked while it has senders); `GET/POST /domain-senders`, `DELETE /domain-senders/:id`. The legacy workspace-level wizard routes (`/sending-domain/{start,check,activate}`) still exist (and activate still upserts its domain into `sending_domains` verified) but are no longer surfaced in the UI. **`GET /domain-senders` is `manage_content`** (read needed by the broadcast/campaign From dropdown); creating/deleting a sender stays `manage_sending_domain`.

**From / To / Subject live on the EMAIL INSTANCE (the template), not the broadcast/campaign (migration `0028`):** `email_templates` gained `subject text`, `sender_id uuid → domain_senders(id) ON DELETE SET NULL`, and `to_address text NOT NULL DEFAULT '{{customer.email}}'`. They are edited **in the email editor** (`TemplateEditor` — an envelope Card with `email-sender` / `email-to` / `email-subject`, autosaved with the design). Because attaching a template to a broadcast/campaign **clones** it into a working copy (`kind='copy'`), each send has its own editable envelope — `cloneTemplate` copies these columns. The **To** is a recipient token (default `{{customer.email}}`) rendered per recipient at send (falls back to `profile.email`; suppression/unsubscribe still key on `profile.email`). The **From** is an optional named sender (verified-domain `domain_senders` row); `null` → `no-reply@<from_domain>`. The **Dispatcher** reads `compiled_html, subject, sender_id, to_address` from the template, resolves `sender_id` → `"Name" <email>` (`fromAddress` in `core.ts`), and renders `to_address`. The broadcast/campaign **outbox payload no longer carries** subject/sender — only `broadcast_id`. A **subject is required to send** a broadcast: `sendBroadcast` joins the template and 409s "Add a subject line to the email" when blank. `validateSenderId` (local-api, reused by `createTemplate`/`updateTemplate`) rejects a cross-workspace `sender_id` (inv.2); `GET /domain-senders` is `manage_content` (the editor's From dropdown). The broadcast wizard / campaign builder no longer have envelope fields — they point you to "Design email".

**Broadcast metrics + click tracking (extends §9A/§10):** the broadcasts list shows per-broadcast **Failed / Delivered / Clicked** (Opened & Converted deferred). Attribution: `messages_log.broadcast_id` (migration `0026`, mirrors `campaign_id`; the dispatcher writes it from `outbox.payload.broadcast_id`). Delivered/Failed are aggregated from `email_events` (delivery/bounce/complaint) joined to `messages_log` by `ses_message_id`; Clicked sums `tracked_links.clicks`. **Click tracking is opt-in per workspace** (`workspaces.settings.link_tracking`, toggled in Workspace settings). When on, the **dispatcher** (the single point ALL sends pass through — broadcasts AND campaigns) rewrites every `http(s)` link in the email to `<linkTrackingBaseUrl>/t/<token>` (`rewriteTrackingLinks`, deterministic sha256 token per `(workspace, broadcast|campaign, url)` → idempotent + shared across recipients) and upserts `tracked_links` rows (migrations `0026`/`0027`). The public `GET /t/:token` (in `app.ts`, like `/assets/:id`) 302-redirects to the original URL and increments `clicks`. Metrics are 0 in local dev (the dispatcher/feedback pipeline doesn't run); they populate in a deployed pipeline. A `broadcast.updated_at` drives the "Edited X ago" line.

**Workspace delivery-health on the dashboard (extends §10):** the Dashboards screen (`SimpleScreens.tsx`) has a **Delivery health** section fed by `GET /dashboards/delivery-health?days=N` (`manage_content`, default 30d, clamped 1..365). It returns, all workspace-scoped: `outcomes` (sent from `messages_log`; delivered/bounced/complained from `email_events`, windowed by `occurred_at`), `rates` (bounce = bounced/(delivered+bounced); complaint = complained/delivered) colored against SES thresholds (bounce >5% warn / >10% danger; complaint >0.1% warn / >0.5% danger, shown via `rateTone`), `suppression` (current list size by reason — NOT windowed), and a gap-filled per-day `trend` (`generate_series`) rendered by a dependency-free `Sparkline` (`ui/kit.tsx`). Same caveat: outcomes/rates are 0 in local dev (no feedback pipeline); the suppression count is live. testids: `delivery-health`, `dh-sent/delivered/bounced/complained`, `dh-bounce-rate`, `dh-complaint-rate`, `dh-reputation-warning`, `dh-suppressed-total`, `dh-supp-<reason>`, `dh-trend`.

**`customer.*` personalization namespace (extends §8/§11):** one systemwide token scheme for referring to a profile in segment rules AND email merge tags. `customer.email` / `customer.external_id` / `customer.email_status` / `customer.created_at` map to the matching `profiles` column; `customer.attributes.<key>` is a custom attribute; and **`customer.<key>` is shorthand for `customer.attributes.<key>`** (so `{{customer.tier}}` ≡ `{{customer.attributes.tier}}`, and in a segment rule `customer.tier` ≡ `attributes.tier`). The single source of truth is `packages/shared/src/customer.ts` (`expandCustomerPath` / `expandCustomerToken` / `resolveCustomerField` / `customerMerge`). The segment compiler (`packages/segments`) normalizes the field BEFORE the whitelist (invariant 6 unchanged); the dispatcher builds the `customer.*` merge from the recipient profile and `renderTemplateBody` expands the shorthand at send time. Legacy bare `attributes.*` / scalar field names still work.

Phase-1 scaffolding only — no business/feature logic yet. The full §6 schema (all tables, RLS enabled with the `workspace_id` policy + narrow `is_platform_admin` exception, `workspace_id`-leading indexes) is encoded in `packages/db/supabase/migrations/0001..0010`. Foundation services (authorizer/ingest/processor) have thin handler shells; later-phase services are placeholders. `packages/db/src/client.ts` is a pooled `pg` connection helper (no queries).
