# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

`CDP-BUILD-SPEC.md` (v8) is the original build specification; `§N` references below point into it. **Where this file and the spec disagree, this file wins** — it records what was actually built, including deliberate overrides of the spec. Where this file is silent, the spec governs.

This document is a **rules-and-architecture reference, not a changelog.** Record durable constraints, conventions, and non-obvious decisions here. Do not add per-release narration, bug post-mortems, test-file inventories, or `data-testid` catalogs — git history and the code hold those.

## What is being built

A **serverless, multi-tenant marketing CDP** on AWS: companies get isolated workspaces, ingest behavioral events over HTTP, maintain unified customer profiles with rolling aggregates, define segments, and reach people via broadcasts (one-off blasts) and automations (multi-step journeys) over email, SMS, and WhatsApp. An admin SPA provides segment/automation builders, a WYSIWYG email editor, dashboards, and per-workspace cost views.

The system is well past scaffolding: ingestion, profiles, segments, broadcasts, automations, multi-channel sending, subscription management, and the admin SPA are all built and covered by tests.

## Tech stack (locked — §0)

- **Backend:** TypeScript on Node.js 20+, AWS Lambda (real Node runtime, full npm incl. `sharp`).
- **HTTP entry:** API Gateway **REST API** (not HTTP API — chosen for request validation, per-workspace API keys + usage plans, native WAF).
- **Database:** Supabase (managed PostgreSQL), pooled connection from Lambda. System of record.
- **Queue:** SQS **FIFO** (+ DLQ), `MessageGroupId = profile_id`.
- **Email:** Amazon SES or Resend, per company. **Text:** 019 (SMS), Meta (WhatsApp).
- **Auth:** Supabase Auth, validated at the gateway by a **Lambda authorizer** (REST API has no native JWT authorizer).
- **Email editor:** a CUSTOM in-house designer (`web/src/email-designer/`, ported from the owner's nomentor builder; Preact + @preact/signals) — deliberately OVERRIDES the spec's GrapesJS choice. The surviving invariant: the editor **emits MJML, never hand-rolled HTML** (design JSON → `mjml-serializer.ts` → server `compileMjml`, strict).
- **IaC:** AWS CDK (TypeScript). **Frontend:** Preact/React SPA, Vite, static on S3 + CloudFront. **Testing:** Vitest; real Postgres for the integration tier; `aws-sdk-client-mock`; Playwright for browser e2e.

## Non-negotiable invariants

The properties the whole system exists to guarantee. Every change must preserve them; they are pass/fail acceptance gates (§18), not aspirations.

1. **Tenant isolation.** Every tenant-scoped row carries `workspace_id NOT NULL`. Defense-in-depth: (a) app code filters by `workspace_id` in *every* query, (b) Postgres RLS for user-context (admin app) connections. **Critical caveat (§3):** backend processing Lambdas connect with the Supabase **service role, which bypasses RLS** — they MUST scope by `workspace_id` in code; RLS is not their safety net. Query builders bind `workspace_id` at **`$1`** (the tx guard `runStatementsInWorkspaceTx` requires `values[0] === workspaceId`).

2. **Workspace is never client-supplied.** Derive it from the API key at ingest (§7) and from the authorizer-injected claim on the admin API (§12). Never trust a `workspace_id` in a request payload. A cross-workspace id in a path 404s; a cross-workspace foreign key in a body 400s.

3. **Per-profile event ordering.** `MessageGroupId = profile_id` gives per-profile FIFO. Code must be **idempotent and order-convergent** so a `progress` arriving before `profile_created` still resolves (upsert a stub). Don't unit-test "the queue delivered in order" — that's SQS's job; test your convergence.

4. **No lost events.** `200` is returned only after SQS accepts (durable boundary). Forced failures retry, then go to DLQ — never vanish.

5. **Idempotency.** `events.event_id` is producer-supplied and the dedupe key (`INSERT … ON CONFLICT DO NOTHING`); `outbox.dedupe_key` and broadcast `(broadcast_id, profile_id)` prevent double-sends.

6. **Segment SQL is compiled, never interpolated.** The rule-AST → SQL compiler (§8) whitelists fields/operators, emits parameterized SQL only, and **always** prepends `workspace_id = $ws`. Security-critical and the single highest-value unit-test target.

7. **Sending is gated on verification.** The Dispatcher refuses to send for any workspace not `active`/verified (§10).
   - **Verification source (overrides §10A):** the `canSend` gate reads a VERIFIED row in `sending_domains` (the per-domain model's source of truth), derived in `services/dispatcher/src/dispatch.ts`. The legacy `workspaces.sending_identity` jsonb is a fallback for old data only — the per-domain onboarding flow never populates it, so gating on it alone silently refuses fully-verified workspaces.
   - `DispatchDeps.emailTrusted` bypasses the verified-domain gate for Resend (domains are verified in Resend's own dashboard).
   - Text channels (sms/whatsapp) gate on workspace `status='active'` ONLY — a verified *email* domain is meaningless for them.
   - **Guardrails** (frequency cap + quiet hours) come from `workspaces.settings`: `frequency_cap_per_days` (int, 0=off), `quiet_hours {startHour,endHour}` (UTC, null=off), set in Workspace settings → Sending guardrails.
   - Suppression + soft-bounce are EMAIL-keyed and apply only to `medium==='email'` — a text send is never blocked by an email bounce.

## Standing conventions

Apply these without being asked; they are project-wide rules.

- **Server-calling buttons auto-lock.** The kit `Button` (`web/src/ui/kit.tsx`) shows a spinner + disables itself whenever its `onClick` returns a Promise. Wire every server-calling button so the handler RETURNS the promise (`onClick={save}` / `onClick={() => save(id)}`, never `() => void save()`); pass `loading` explicitly for `type="submit"`. No double-submits, always a clear in-flight state.
- **Never use native JS dialogs.** No `confirm`/`alert`/`prompt` — use the shared styled dialogs (`web/src/ui/dialog.tsx`: `askConfirm`) or a purpose-built modal.
- **Transient feedback is a floating toast** (`web/src/ui/toast.tsx` `showToast()`, `ToastHost` in AppShell), not an in-flow banner.
- **Row actions consolidate into one kebab (⋮) `ActionMenu`** (`ui/kit.tsx`). An async item keeps the menu open, spins itself, and locks its siblings until it settles. Items keep stable `data-testid`s.
- **The email editor has no manual Save** — it autosaves and flushes on leave, with a contextual "← Back to broadcast/automation/templates".
- **Reuse before reinventing.** The same `RuleBuilder` serves segment rules, automation IF conditions, and wait-until gates (→ ONE §8 `AstNode`). The same `Suggest` combobox serves every autocomplete. The same clone/return flow serves broadcast and automation email instances. Extract a shared component rather than forking one.
- **Bump the root `package.json` version** on every change: patch = tiny, minor = feature, major only when told.
- **All tests must pass before anything lands on `main`** — typecheck + Vitest + e2e.
- **Develop on a branch, merge to `main`, and deploy ONLY from `main`.** Never deploy a non-main branch.
- **Test-first (§16A):** write the acceptance criteria as failing tests, then implement to green. **Don't mock Postgres** in the integration tier (ordering, idempotency, and isolation bugs live in the SQL and RLS). **Do mock SES** — never send real mail from a test.
- **Lambda handler pattern (§21):** keep each handler thin — it wires up a **pure, injected function** holding the logic, so logic is unit-testable without the AWS wrapper. Every handler is idempotent, stateless, and workspace-scoped.
- **The code base will get large.** Favor modern, factored code; refactor and reuse; test everything.

## Roles & capabilities (§3A)

Four roles. `system-admin` (in `platform_admins`) is the **only cross-tenant role** — the authorizer injects an `is_platform_admin` claim, RLS has a narrow exception for it, and every cross-tenant access is written to `admin_audit_log`. The other three (`owner` / `marketer` / `accounting`) are workspace-scoped via `workspace_users.role`; a user may hold different roles in different workspaces.

Capability gates used throughout the API: `manage_content` (marketer-level: profiles, segments, broadcasts, automations, templates, topics-read), `manage_sending_domain` (provider/connector/domain config), `manage_workspace_users` (owner-level: workspace settings, topics management).

## Workspace settings (`workspaces.settings` jsonb)

Read via `getWorkspaceSettings`, written via the owner-gated `PUT /workspace/settings`. **The write is a sibling-preserving jsonb merge** — never clobber keys you didn't touch. Values are validated server-side before the write (an invalid one 400s and writes nothing), and `workspace_id` comes from ctx only (inv.2). No migration is needed to add a key.

| Key | Meaning |
|---|---|
| `timezone` | IANA zone, default `UTC`. **The single clock for ALL automation time math** (waits, wait-until, hour windows) — DST-correct, never per-broadcast guesswork. |
| `default_phone_country` | ISO-2, for normalizing national phone numbers to E.164. |
| `default_from` | The workspace's default From (`Name <a@b.com>`). **Workspace-level, not company-level** — sending domains and named senders are per workspace, so a company-wide value would make every workspace send as one address regardless of the domain it verified. Wins over the legacy `company_connectors.config.from`, which remains a fallback. |
| `frequency_cap_per_days` / `quiet_hours` | Sending guardrails (see inv.7). |
| `link_tracking` | Opt-in for BOTH open and click tracking. |
| `topics_enabled` | Whether the preference center shows topics (default true). |
| `front_facing_language` | `auto` \| `en` \| `he` for the public pages. |
| `webhook_allowlist` | Deny-by-default host allowlist for automation webhooks. |
| `lowercase_emails` | Legacy ingest normalization flag. |

## Tenancy model

**Company → Workspace (extends §6).** A `companies` table groups workspaces; every workspace has `company_id NOT NULL`. **Isolation is unchanged and stays at the workspace level** — a company is purely the organizational parent so a platform admin can pick company → workspace (sidebar `CompanyWorkspacePicker`, fed by `GET /admin/companies`). Workspaces created without a `company_id` (chiefly integration tests) are auto-assigned to a shared `Unassigned` company by a BEFORE-INSERT trigger; product paths always supply a real one. **A user belongs to ONE company:** `addMember` 409s when adding a user to a workspace whose company differs from one they already belong to.

**Registration creates a COMPANY only — never a workspace.** `POST /auth/register` (`registerOwner`, local-api `session.ts`) inserts the owner `users` row + a `companies` row tagged `owner_user_id`; NO workspace, NO `workspace_users`. The minted token is logged-in but workspace-less, so the response carries `needs_workspace: true`. Because production `authorize()` hard-denies a non-platform-admin token with no active workspace, creating the first workspace is a **session route**: `POST /workspace/bootstrap` (`createFirstWorkspace`) authenticates the token directly, resolves the company server-side from `owner_user_id = <token sub>` (never client-supplied, inv.2), inserts the workspace + owner membership, and **re-mints the token**. `devLogin` mirrors this (workspace-less owner → 200 with `needs_workspace`; anyone else with no membership → 403). The SPA routes such a session to `CreateFirstWorkspace`. Additional workspaces go through the capability-gated `POST /workspaces`.

## Identity model

**The identity key is `email` and/or `phone`, NOT `external_id` (overrides §6/§7).** Events arrive from many source systems, so a stitching identifier is required. `external_id` is optional metadata.

- **Both are CORE, RESERVED columns** (not dynamic attributes). Each alone is optional but **at least one is required** — `CHECK (email IS NOT NULL OR phone IS NOT NULL)`. Uniqueness: `UNIQUE(workspace_id, email)` and a partial `UNIQUE(workspace_id, phone) WHERE phone IS NOT NULL`. **A profile insert must therefore supply an email or a phone** (many test fixtures set `email = external_id` to satisfy this).
- **Phones are stored normalized to E.164** so `+972541111111` == `054-1111111`. `@cdp/channels normalizePhone(raw, defaultCountry)` (libphonenumber-js) → E.164 or `null`, never throws. National numbers resolve against the per-workspace `workspaces.settings.default_phone_country` (ISO-2).
- **Reserved fields** live in `@cdp/shared/customer.ts` (`RESERVED_CUSTOMER_FIELDS`). The `customer.*` resolver and `customerMerge` treat `email`, `phone`, and their `attributes.*` spellings as the core columns (`CORE_ATTRIBUTE_ALIASES`), with a **fallback to `attributes.phone`/`attributes.email` when the column is empty** (pre-backfill profiles). Reserved keys are STRIPPED from dynamic attributes on write (`stripReservedAttributes`).
- **Resolution (`services/local-api/src/identity.ts` `resolveIdentity`, pure):** validate email format, normalize phone, require ≥1 key. **A bad phone alongside a valid email is DROPPED (record kept); a phone-only bad number is REJECTED (400).** Upsert rule is **"prefer email, don't steal the phone"**: with both keys the email is primary, and the phone attaches only if no other profile owns it — never auto-merge, never move a phone off another profile. Wired into `/v1/identify`, `/v1/track`, `POST /profiles` (409 on a taken key), `PATCH /profiles/:id` (409 on conflict, 400 when clearing the last identifier), and profile list/detail/search.
- `scripts/backfill-phone.mjs` moves legacy `attributes.phone` into the column per workspace (idempotent, `--dry-run` supported).

## Architecture flow

```
Producer --API key--> API GW REST (validate, usage plan, WAF)
  --> Ingest Lambda (resolve workspace from key, upsert profile) --> SQS FIFO (group=profile_id)
  --> Processor (idempotent, workspace-scoped): events -> profile_features -> re-eval segments
        -> membership diff + change_log -> automation enrollment (§9B)
  --> outbox row -> 2nd SQS queue --> Dispatcher (gating pipeline) -> SES/Resend/019/Meta -> messages_log
SES events -> SNS -> Feedback Lambda -> per-workspace suppression + reputation policing (auto-suspend)
```

Broadcasts (§9A) and automations (§9B) emit sends through the **same** outbox → Dispatcher pipeline. Automations are a **table-driven state machine** over `automation_enrollments`, advanced by a scheduled Automation-runner Lambda (chosen over Step Functions: cheaper for long multi-day waits at this scale).

## Repository structure (§19)

```
/infra            # CDK: AWS resources, per-workspace usage plans, RLS-aware setup
/services/<fn>    # one dir per Lambda: ingest, processor, dispatcher, broadcast,
                  #   automation-runner, feedback, unsubscribe, image, onboarding,
                  #   batch-eval, metering, api, authorizer, local-api
/packages/shared  # types, env/config, workspace-aware logging, customer.*/event.*
                  #   namespaces, expression engine, timezone helpers
/packages/db      # schema, migrations, RLS policies, pooled client, secret-crypto
/packages/segments# rule AST + SQL compiler (mandatory workspace_id)
/packages/email   # SES + Resend clients, MJML compile, header + link builders
/packages/channels# multi-channel send abstraction (sms/whatsapp) + mock providers
/packages/tenancy # workspace context + role-check helpers
/web              # Preact SPA: builders, email designer, screens
/scripts          # seeds, backfills, dev-db reset, DLQ replay
/tests            # unit + integration (real Postgres) + thin E2E (LocalStack)
```

Packages are `@cdp/<name>`; services are `@cdp/service-<name>`; infra `@cdp/infra`; web `@cdp/web`. Strict TS base in `tsconfig.base.json`; project references (`tsc -b`).

**`services/local-api` is the dev/e2e server** — it mirrors production handlers over a single Hono app so the SPA can run without AWS. It **consumes the BUILT dist of sibling packages** (notably `@cdp/email` and `@cdp/service-unsubscribe`), so **rebuild those after changing them** (`pnpm --filter @cdp/service-unsubscribe build`) or the running server keeps the stale copy.

## Commands

Tooling: **pnpm workspaces + Turborepo + Vitest + TypeScript (strict)**, Node 20+. Run from repo root.

| | |
|---|---|
| Install / build / typecheck | `pnpm install` · `pnpm build` · `pnpm typecheck` |
| Test (all) | `pnpm test` |
| One test file | `pnpm --filter <pkg> exec vitest run path/to/file.test.ts` |
| Lint / format | `pnpm lint` · `pnpm format` |
| Local Postgres | `pnpm db:start` then `pnpm db:migrate` (reset + re-apply `packages/db/supabase/migrations`) |
| Reset dev data | `pnpm db:reset:dev` |
| LocalStack | `pnpm localstack:start` |
| Browser e2e | `pnpm --filter @cdp/web test:e2e` |
| CDK | `pnpm --filter @cdp/infra synth` / `deploy` |

**Migrations auto-apply on boot, in EVERY role.** `services/local-api/src/server.ts` (advisory-locked) calls `@cdp/db runPendingMigrations` on startup: it tracks applied files in `schema_migrations` and applies only OUTSTANDING ones, each in its own tx. A failure throws → boot fails → Fly keeps the prior version, never a half-applied schema. **Do not re-gate this to the worker role:** it was, and when the worker machine happened to be stopped a deploy shipped web code whose queries referenced columns that had never been created — 500s on exactly those routes, with a green health check, because a schema gap only shows on the specific query. Running it in `web` ties the guarantee to the machine whose health check gates the deploy. **A deploy therefore carries its own DB changes — no hand-running SQL in Supabase.** A pre-existing untracked DB is BASELINED on first run (`BASELINE_MIGRATION_PREFIX` in `migrate.ts`). **Migrations MUST stay transaction-safe** (no `CREATE INDEX CONCURRENTLY`). `applyMigrations` (raw full apply) remains for the test tiers.

**e2e DB isolation (critical).** The e2e suite re-seeds (deletes + reinserts the Acme/Beta demo workspaces) on every run, so it is pinned to its OWN database `cdp_e2e` on its OWN ports (local-api :8788, web :5174) in `web/playwright.config.ts`. The dev stack (`cdp`, :8787/:5173) coexists — running e2e does NOT touch dev data and dev servers need not be stopped. **Never point the e2e suite at `cdp`.**

**`pnpm db:reset:dev`** (`scripts/reset-dev-db.mjs`) gives a repeatable clean slate: `TRUNCATE companies CASCADE` (wipes every workspace-scoped table) + deletes all non-platform-admin users, keeping only the system-admin login; also clears `web/test-results` and `web/playwright-report`. Schema untouched. It refuses any DB that isn't a local `cdp`/`cdp_e2e` on localhost. **Browser state is separate** — the login session and profile-table column choices live in `localStorage`; sign in fresh after a reset. Profile column prefs are **per-workspace** (`cdp.profileColumns:<workspace_id>`), the Profiles screen is re-keyed by workspace id in `AppShell` so switching remounts it, and the column picker self-heals attribute columns that no longer exist.

## Prerequisites Claude Code cannot do (§5)

Creating AWS/Supabase accounts, approving SES production access, and adding DNS records are human steps. Flag them rather than attempting them.

---

# Sending

## Connectors — per-company provider registry + channel gating (extends §10)

A company connects PROVIDERS; each powers a messaging CHANNEL (`email`/`sms`/`whatsapp`). A channel is **enabled** iff a connector that can actually send on it is connected; broadcasts and automations gate on that.

- **Unified table `company_connectors`** (company-scoped RLS): `channel`, `provider` (`ses`|`resend`|`019`|`meta_whatsapp`), `config` jsonb, encrypted `secret` (write-only, never returned), `enabled`, `UNIQUE(company_id, channel, provider)`. Three legacy per-provider tables (`company_ses_config`/`company_channel_config`/`company_whatsapp_config`) were copied into it and kept dormant; resolution (`channelConfigForWorkspace` in dispatcher `deps.ts`, `sesForWorkspace` in local-api) reads connectors FIRST with a legacy-table fallback.
- **Email can be SES OR Resend.** `@cdp/email createResendEmailClient` is a DROP-IN for the dispatcher's `sendEmail` (POSTs the same rendered input to `api.resend.com/emails`; SES-only identity methods throw; injectable HTTP). `emailSenderForWorkspace` picks Resend when a `resend` connector exists, else SES. A Resend company is `emailTrusted` (inv.7) and its broadcast email gate waives `sender_id` + the verified-domain check.
- **CRUD:** `GET/PUT /company/connectors`, `DELETE /company/connectors/:id` (`manage_sending_domain`). UI `web/src/screens/Connectors.tsx`: one box per channel; a channel with several providers shows a logo picker and renders ONLY the selected provider's form.
- **Gating:** the broadcast composer disables a medium with no connector. The automation runner (`run.ts` `resolveChannels`) SKIPS a send node whose channel is disabled — the enrollment still advances, as if the step didn't exist. **Lenient:** a company with ZERO connectors is never gated (legacy/dev/mock behavior); gating kicks in once ≥1 connector exists.

## One email provider per company (exclusive)

A company sends email through **exactly one** provider — self-hosted `smtp`, `ses`, or
`resend`. Never two at once.

- Enforced twice: a partial unique index (`company_connectors_one_enabled_email`, at
  most one ENABLED email connector per company) and a **409** from `PUT /company/connectors`
  naming the provider already in use.
- **Switching keeps the old credentials.** The index is partial on `enabled`, so a
  disabled connector for another provider may remain — disconnect, then connect the new
  one, and the previous credentials are still there to switch back to.
- **`emailSenderForWorkspace` dispatches on the connector's provider**, not on a
  preference order. The old order-based resolution ("Resend if present, else SES")
  meant that with both configured, the provider that actually sent depended on
  resolution order rather than on what the company chose — while the domain-verification
  flow differs per provider, so a company could verify a domain for one and send through
  the other.
- **Self-hosted is a platform-admin grant** (`companies.self_hosted_mail_enabled`,
  default false): it spends OUR IP reputation, so it is never self-served. Connecting an
  `smtp` connector without the grant is a 403.
- `smtp` carries **no per-company secret** — the SMTP credential is platform-level (Fly
  env), since every authorized company shares one mail server. Like SES and unlike
  Resend it is **not** `emailTrusted`: we vouch for the domain, so it must be verified
  in-app.

## Configuration readiness

A single source of truth for "is this workspace set up to send?", with a **strict** definition that HARD-DISABLES a channel when unmet.

- **Pure core `services/local-api/src/readiness.ts`:** `computeReadiness(inputs)` (unit-tested) / `gatherReadiness(pool, ws)` (reads then computes) → `{ checks[], channels{email,sms,whatsapp}, errorCount, warningCount }`. Each check is `{ id, severity, status, items[{label, ok, scope, fix?}], summary }`.
- **Definitions.** EMAIL ready = a `resend` connector WITH `config.from`, OR a `ses` connector **AND** ≥1 verified `sending_domains` row **AND** ≥1 `domain_senders` row — a domain alone or a provider alone is NOT enough. SMS = a `019` connector. WhatsApp = a `meta_whatsapp` connector. STORAGE = a `company_r2_config` row (severity `warning`, never disables — images fall back to DB).
- **`channelsForWorkspace` DERIVES from `gatherReadiness().channels`**, so broadcast medium gating, the runner's send-node skip, and the builder's inactive-node visual all follow the strict definition automatically. Exposed at `GET /company/channels` and `GET /company/readiness` (both `manage_content`).
- **Surfacing:** no nav item and no global banner (they nagged about deliberately-unconfigured channels). A small red count **badge** sits on the Company-settings nav item (`companyErrorCount`: provider gaps) and the Workspace-settings nav item (`workspaceErrorCount`: sending-domain gaps); clicking one opens the Setup page (`web/src/screens/Setup.tsx`) deep-linked to that scope (`/setup/company`, `/setup/workspace`, `/setup` = all). Every readiness item carries a `scope`, and a shown check's status pill is recomputed from just the in-scope items. Config screens that stay on their route while mutating readiness inputs must call `refreshReadiness()` (`web/src/store/readiness.ts`) so badges update without a navigation.

## Self-hosted SMTP (third email provider)

Beside SES and Resend, a company may send through **our own mail server**. Same
`sendEmail` interface, so the dispatcher, gating pipeline and outbox are unchanged.
Design and operational detail: `docs/plans/2026-08-04-self-hosted-mail-server-design.md`.

- **`createSmtpEmailClient`** (`@cdp/email`) submits over SMTP. Unlike the hosted
  providers, **we generate the `Message-ID` before sending** (from the outbox message
  id), which makes bounce correlation exact rather than best-effort.
- **VERP bounce addresses.** Every send carries `Return-Path: bounce+<token>@bounce.<mail-domain>`,
  the token an HMAC-signed message id (`packVerpToken`/`unpackVerpToken`). It is
  **signed, not merely encoded** — a guessable bounce address would let anyone forge a
  bounce and suppress an arbitrary recipient. The token holds only the message id; the
  **workspace is resolved from `messages_log`**, so tenancy comes from our own DB, never
  from the wire (inv. 2). That also keeps the local part inside RFC 5321's 64 octets.
- **Per-company sending domains use CNAME delegation**, not a customer-hosted TXT:
  `bounce.<customer>` plus `s1`/`s2._domainkey.<customer>` CNAME to per-company targets
  on our zone. One CNAME covers every record type, so the bounce name inherits our SPF
  **and** MX — giving SPF alignment alongside DKIM, and routing bounces back to us. The
  point is rotation: with a customer-hosted TXT, rotating a key means asking every
  customer to edit DNS, which in practice means never rotating. **Never a shared key** —
  per-company targets, so one compromise cannot affect every tenant.
- **An RSA-2048 DKIM value does not fit one DNS TXT string** (~410 chars against a
  255-byte cap). It must be published as several strings that resolvers rejoin
  (`dkimTxtChunks`); verification joins them before comparing.
- **Inbound bounces and spam reports reuse the SES feedback path's SQL builders.**
  `classifyInboundReport` (`@cdp/service-feedback` `dsn.ts`) folds a DSN or ARF into the
  same `ClassifiedEvent` `classifySesEvent` produces, so suppression, `email_events`,
  `email_status` and soft-bounce counting have ONE implementation.
- **Only permanent failures suppress.** `5.x.x` -> hard bounce -> suppress; `4.x.x` ->
  transient, still being retried by the MTA -> recorded, **never** suppressed. A
  complaint always suppresses. Suppressing on transient failures destroys a list.
- **`POST /internal/mail-events`** ingests raw reports from the MTA agent, authenticated
  by `MAIL_AGENT_SECRET`. That bearer only gets a caller through the door — workspace and
  recipient still come from the verified VERP token, so a leaked bearer cannot suppress
  an arbitrary address. Unattributable reports return 200 so the agent stops retrying.
- **Submission is authenticated.** The app submits on **587 with TLS + Cyrus SASL**
  (`SELF_HOSTED_SMTP_*` secrets); the service is `permit_sasl_authenticated, reject`, so
  an authenticated app may relay anywhere and anyone else nowhere. Port 25 stays
  inbound-only (bounces). `makeSmtpTransport` (`@cdp/email`) is nodemailer-backed and
  **pooled** — a TCP+TLS+AUTH handshake per message would dominate the cost of sending.
- **`SendEmailInput.messageId` is its own field, never `configurationSetName`.** In the
  dispatcher that field carries the workspace's real SES config-set name; signing VERP
  tokens with it yields Return-Paths that resolve to no message while every send still
  looks successful, so bounces silently stop being attributable.
- **Every message is signed TWICE**: `d=<customer-domain>` for DMARC alignment, and
  `d=journeys.on-grow.com` from the `platform` selector. The second signature is what
  lets ONE Yahoo CFL registration and ONE reputation view cover every tenant — feedback
  loops bind to an IP or a DKIM domain, never to a company. OpenDKIM's `SigningTable` is
  a `refile:`, so a `*` entry adds the platform signature to all mail.
- **Google Postmaster Tools (API v2)** registers each customer domain under OUR account,
  so the customer publishes one more DNS record instead of creating a Google account.
  Two traps, both found against the live API: `domainStats:query` needs `parent` in the
  request BODY as well as the path, and `complianceStatus` returns
  `complianceData.rowData[]` requirement/status pairs, not flat `spfStatus`/`dkimStatus`
  fields. Verification is a readiness **warning** and never gates sending.
- **The sending-domain flow BRANCHES ON THE PROVIDER** (`emailProviderForWorkspace`).
  It assumed SES, so a self-hosted company opening its domain was told to add Amazon
  credentials it will never have. SES → the identity + CNAME flow; Resend → nothing to
  publish (it verifies in its own dashboard); **smtp → the DIRECT model**: the customer
  publishes OUR public key at `<selector>._domainkey.<domain>` (TXT) plus a DMARC
  record, and `POST /sending-domains/:id/check` resolves both. One key file on the mail
  server serves every customer domain (its KeyTable entry substitutes the sender's
  domain), so adding a domain needs no work on the box. The key comes from
  **`SELF_HOSTED_DKIM_PUBLIC_KEY`** (+ `SELF_HOSTED_DKIM_SELECTOR`, default `cdp`);
  unset, the screen says the DEPLOYMENT has no signing key rather than blaming the
  customer's DNS. **Never verify against `sending_domains.dkim_tokens` here** — those
  are SES tokens, empty for a self-hosted company, and an empty expected key matched
  any TXT record at all, so a domain could verify without publishing anything. Live DNS
  lookups run only when a real SMTP transport is configured, mirroring the SES path's
  `mode === 'real'`.
- **The MTA agent is a thin forwarder** (`services/mail-agent/mail-agent.mjs`): read
  Maildir, post raw, delete on 2xx. It parses nothing, so a parser fix is an app deploy
  rather than an ssh session on a mail server.

## Email change resets bounce state, never consent

**A bounce is a property of the ADDRESS; a refusal is a property of the PERSON.**

Editing a profile's email resets `email_status` from `bounced` to `active`, so the new
address is sendable — but `complained` persists, and a full unsubscribe additionally
writes profile-keyed `channel_optouts` so consent survives an address change. Without
that second write, `suppressions` being keyed `(workspace_id, email)` means editing an
address silently resurrects someone who asked to be left alone.

Note for test fixtures: a full opt-out now creates `channel_optouts` rows, so any
teardown deleting `profiles` must clear `channel_optouts` first (`profile_id` is
`ON DELETE NO ACTION`, per `PROFILE_CHILD_TABLES`).

## Sending domains (extends §10)

A workspace can have several sending domains (`sending_domains`, workspace-scoped + RLS, each with a `verified` flag). **Sending domains is a TAB in Workspace settings** (`/settings/domains`) — it needs the owner role (`manage_workspace_users`) and the domain's own workspace selected. The list opens a per-domain setup screen where you save the domain (pending), see its DKIM records, and verify.

**Verification uses real SES.** On first open each domain is provisioned as an SES email identity (`createDomainIdentity` → 3 DKIM tokens, stored in `sending_domains.ses_identity`/`dkim_tokens`); the check calls `getIdentityVerificationAttributes` and verifies ONLY when `DkimStatus === 'SUCCESS'` — there is no manual flip.

**The DKIM CNAME target host is read FROM SES, never constructed.** SES returns `DkimAttributes.SigningHostedZone`, which is region-specific (e.g. `dkim.il-central-1.amazonses.com`) and each company picks its own region. It is persisted in `sending_domains.signing_hosted_zone` and used verbatim as `<token>.<signing_hosted_zone>`. Fallbacks (`dkim.<region>.amazonses.com`, then `dkim.amazonses.com`) apply only if SES omits it or under the local mock.

**SES credentials are per-company.** With no company config the handlers fall back to the local MOCK SES so dev/tests verify deterministically (the setup screen then shows a "verification is simulated" note). `LOCAL_SES_FORCE_MOCK` forces the mock.

A `domain_senders` row (a named "From" identity) may only be created for a **verified** domain and is managed inside that domain's setup screen, never in a global list. API (`manage_sending_domain`): `GET/POST /sending-domains`, `GET /sending-domains/:id`, `POST /sending-domains/:id/check`, `DELETE /sending-domains/:id` (blocked while it has senders); `POST /domain-senders`, `DELETE /domain-senders/:id`. **`GET /domain-senders` is `manage_content`** — the broadcast/automation From dropdown needs to read it.

## From / To / Subject live on the EMAIL INSTANCE, not the library template

`email_templates` carries `subject`, `sender_id` (→ `domain_senders`, ON DELETE SET NULL), and `to_address` (NOT NULL, default `{{customer.email}}`).

- **A library template is a reusable DESIGN and shows NO envelope in the editor.** The From/To/Subject card renders only when editing an email *instance* (`kind='copy'`, or opened via a broadcast/automation return flow).
- **Attaching a template CLONES it** into an independently editable working copy (`kind='copy'`, `source_template_id`), copying design + `subject`/`sender_id`/`to_address`. The template is only a starting point — you cannot swap the underlying template inline; "Start over" just unreferences the copy.
- **From / To / Subject are ALL MANDATORY to send. There is NO no-reply fallback.** The From must be a real named sender (a verified-domain `domain_senders` row). The editor's From dropdown offers only a disabled "Choose a sender…" placeholder plus the named senders. `sendBroadcast` 409s in a fixed order — missing sender → missing To → missing subject → *then* the verified-domain gate. The broadcast wizard gates its Content step on the same three, so Schedule/Send is unreachable without a deliberately-chosen From. (`fromAddress` in the dispatcher retains a `no-reply@<domain>` last resort for a null `sender_id`; broadcasts cannot reach it.)
- `validateSenderId` rejects a cross-workspace `sender_id` (inv.2). The **To** is a recipient token rendered per recipient at send; suppression and unsubscribe still key on `profile.email`.
- **Editor return context** (`store/editorReturn.ts`) is persisted in `sessionStorage` so a refresh inside the editor keeps the "← Back to …" target. Standalone editor opens must call `clearEditorReturn()` so a stale return can't mislabel Back.

## Transactional messages (`POST /v1/send`)

A designed message sent to ONE person on demand, with values supplied by the caller.
**Email, SMS and WhatsApp** — the key decides the medium, so the caller never names it.
**Authenticated by a SECRET key (`sk_live_`), never the public write key.** `ingest_keys.kind`
(`public`|`secret`) splits the two: the `pk_live_` key is documented as safe to embed in
front-end code, and honouring it here would turn any customer's page source into a spam
relay sending from their verified domain under our reputation. A secret key is stored as a
hash only (`key_full` NULL) and shown once; ingest (`/v1/identify`, `/v1/track`) accepts
either kind, since secret is strictly more privileged. The workspace comes from the key,
never the body (inv.2).

- **Addressed by a stable KEY, not a uuid.** `email_templates.transactional_key` and
  `text_templates.transactional_key` (each partial-unique per workspace) are what the
  integrator hardcodes, so the message behind `'otp'` can be rewritten or replaced
  without anyone redeploying. Set via `PUT /templates/:id/transactional-key` and
  `PUT /text-templates/:id/transactional-key` (`manage_content`) — deliberately NOT
  part of `updateTemplate`, which is the designer's per-keystroke autosave target
  where a uniqueness 409 would surface as a mystery save failure. Normalized (trim +
  lowercase) on BOTH write and lookup, so `OTP` reaches `otp` instead of a 404.
- **ONE key namespace spans email AND text.** A unique index can't cross two tables,
  so `findTransactionalKeyOwner` checks both and 409s naming the holder. The point is
  that the caller writes `"template": "otp"` and never has to say which medium it is.
- **A transactional email carries its OWN envelope.** `/v1/send` reads `subject` and
  `sender_id` off the template row, so the editor shows the From/Subject card for any
  template with a `transactional_key` — not only for a `kind='copy'` instance. Without
  that the envelope is unreachable and every send 409s. The To is NOT shown: the API
  call supplies the recipient.
- **A transactional TEXT commits to a channel** (`text_templates.transactional_medium`,
  `sms|whatsapp`). Ordinary text templates stay medium-agnostic because a broadcast or
  send node picks the channel; nothing downstream picks it here.
- **Text consent is the channel opt-out only.** Text has no bounce and no complaint
  feedback loop, so `decideTransactionalText` gates on `channel_optouts`
  (`sms_whatsapp`) alone — an email suppression never blocks a text.
- **Discoverability is the `/transactional` screen** (`web/src/screens/Transactional.tsx`),
  a top-level nav item beside Broadcasts and Automations: the three ways to send are a
  blast, a journey, and an API trigger. It lists both media by key and owns the create
  flows.
- **`data.*` is a THIRD merge namespace** beside `customer.*` and `event.*`
  (`dataMerge`, depth-capped): a caller cannot shadow a profile field by naming a
  parameter `email`. Subject AND body render through the same engine.
- **Attachments are INLINE base64 on the request, email only** (`parseAttachments`,
  pure): `attachments: [{ filename, content, content_type? }]` (`content_base64` is
  accepted as an alias). Capped at **20 files / 25 MB decoded**, measured from the
  base64 LENGTH so an oversize batch is refused without ever allocating the bytes.
  Filenames are reduced to a leaf name, executable extensions are refused, and a
  text key with attachments 400s rather than silently dropping them. There is no URL
  fetch and no upload-then-reference: a URL would make the sender fetch arbitrary
  hosts on request. Bytes are metered as `usage_counters.attachment_bytes` (additive
  — nothing stores the file, so no rollup can reconcile it); the cost view does not
  price it yet. `SendEmailInput.attachments` carries them to ALL THREE transports —
  SESv2 `Content.Simple.Attachments` (RawContent is BYTES; the SDK base64-encodes),
  Resend's JSON `attachments`, and a hand-built `multipart/mixed` for self-hosted
  SMTP (that path already composes its own message; SES needs no raw MIME).
- **Consent vs deliverability are separate gates** (`decideTransactionalSend`, pure).
  Hard bounce, permanent soft bounce and complaint ALWAYS block — no flag overrides
  them, because mailing a dead box or a complainant damages the shared IP and cannot
  help the recipient. An unsubscribe blocks **by default** and is overridden per
  request with `ignore_unsubscribe: true`, for messages the recipient triggered and
  needs. A skip is `200 {sent:false, reason}` — a decision, not a failure to retry.

## Broadcasts (§9A)

A broadcast sends over **email** (template instance) or **sms/whatsapp** (a merge-tag-enabled `text_body` on the broadcast row). `broadcasts.medium` (CHECK `email|sms|whatsapp`), `broadcasts.text_body`, `messages_log.medium`.

- **Send gating branches by medium:** email = the ordered envelope 409s + verified-domain gate; text = a non-blank `text_body` only (no envelope, no domain gate).
- **Local delivery:** email only delivers with real SES creds (otherwise a local no-op); **sms/whatsapp ALWAYS deliver locally via the mock provider**, so dev/e2e send for real, deterministically.
- **Wizard steps** are Audience → Content → Schedule with **clickable breadcrumbs** (`canReach(target)` allows jumping to any step whose prerequisites are met).
- **Schedule** offers *Send now* (the finish button sends immediately and surfaces failures rather than leaving a silent draft) or *Schedule for a date & time*, plus a separate *Save as draft*. Scheduling carries a **timezone** (default the browser zone, persisted in `broadcasts.scheduled_tz`) — the wall-clock time is interpreted in that zone → UTC via `zonedInputToUtcIso` (DST-correct). **A scheduled send must be ≥ 5 minutes out** (`MIN_SCHEDULE_LEAD_MS`), enforced in BOTH the wizard and `createBroadcast`/`updateBroadcast` (400).
- **Scheduled broadcasts fire via a sweep.** Production runs `@cdp/service-broadcast scheduledSweepHandler` on an EventBridge cron. The dev server has no scheduler, so `server.ts` runs an in-process sweep every `LOCAL_SCHEDULE_SWEEP_MS` (default 30s) calling `sweepDueScheduledBroadcasts`. **Both sweeps run ONLY in the long-lived server, never in `createApp`**, so tests get no background timer. **On Fly they ARE the production scheduler** (there is no EventBridge cron in this deployment), and they run in EVERY role — not just `worker`. Don't re-gate them: `fly deploy` recreates a serviceless machine in whatever state it was in, so a worker that stopped once stays stopped through every later deploy, silently, and scheduled broadcasts then never fire. Concurrent sweepers are safe by design — automation ticks take a single-winner `FOR UPDATE` claim, and `(broadcast_id, profile_id)` uniqueness on the outbox makes a double-send impossible (inv.5).

## Dispatcher — the send pipeline (`services/dispatcher`)

`decideDispatch` (`core.ts`) applies a **fixed order**:

```
gate → suppression → medium-optout → topic-optout → soft-bounce → frequency-cap → quiet-hours → send
```

Every skip writes a `messages_log` row with `status='skipped'` and a human `reason` (`finalizeNonSend`), so a batch never silently drops a recipient, and the provider is never called. `messages_log.reason` is NULL only for a successful send. Failures record the thrown message with `status='failed'` — terminal, never crashing the batch.

**Skip reasons:** hard suppression; `channel_optouts` for the message's `mediumGroupOf(medium)`; `topic_subscriptions.subscribed=false` for the message's topic; frequency cap; quiet hours; `'recipient has no email address'`; `'recipient has no phone'`; `'invalid phone number'`.

**Missing address is a clean SKIP, never a throw** — checked before `buildSendEmailInput`/SES and before the text provider.

**Routing by medium.** Email → the SES/Resend path (the only email send site), rendering `compiled_html`, `subject`, and `to_address` through `renderTemplateBody`. Text → `dispatchTextChannel`, which renders `text_body` + the To phone (default token `{{customer.phone}}`), normalizes the phone to E.164 with the company `defaultCountry`, calls the injected `ChannelProvider`, and writes `messages_log(medium, provider id)` + `usage_counters` + mark-sent in ONE tx. Text sends do no link/open tracking (no HTML).

**Provider resolution order** in `dispatchTextChannel`: (1) `deps.resolveChannel(medium)` — a test override; (2) `resolveChannelProvider(medium, await resolveChannelConfig(ws) ?? MOCK, channelHttp)`. `channelConfigForWorkspace` reads the company row and **decrypts the bearer only at send time** — the wire, the logs, and the stored row never carry plaintext.

**For an automation send** (no `broadcast_id`) the `medium` and `text_body` are read FROM THE OUTBOX PAYLOAD (an automation has no broadcast row), and the topic comes from the send node's `topic_id` in that payload.

**`@cdp/channels`** holds `Medium`, the narrow `ChannelProvider` interface (`send({to, body, from?}) → {providerMessageId}`), deterministic offline mock providers, `normalizePhone`, the `MediumGroup` canon, and the `resolveChannelProvider` seam. Email is NOT a channel here (it keeps its dedicated pipeline in `@cdp/email`); `resolveChannelProvider('email')` throws. A `TODO(real-providers)` marks where further HTTP adapters slot in.

## Subscription management (extends §10)

Three independent state layers. The hard `suppressions` list is untouched and remains the authoritative full-removal gate.

- **`topics`** (workspace-scoped + RLS, `archived` flag) — the workspace's topic list. CRUD `GET/POST /topics`, `PATCH/DELETE /topics/:id` (`manage_content`); archived topics are hidden unless `?include_archived=true`; DELETE nulls any referencing `broadcasts.topic_id` first, then drops the topic (cascading subscriptions). **Topics MANAGEMENT is a tab in Workspace settings** (owner-gated) — owners define topics, marketers merely pick them.
- **`topic_subscriptions`** (`UNIQUE(workspace_id, profile_id, topic_id)`) — **DEFAULT-SUBSCRIBED**: the ABSENCE of a row means subscribed. Only explicit opt-outs and re-opt-ins are stored.
- **`channel_optouts`** (`UNIQUE(workspace_id, profile_id, medium_group)`, `medium_group ∈ ('email','sms_whatsapp')`) — a row means opted OUT of that whole group. SMS and WhatsApp are deliberately grouped.
- **`broadcasts.topic_id`** tags a broadcast. **There is NO `automations.topic_id` column** — an automation's topic is per SEND NODE (`ActionNode.topic_id` in the DSL), riding the outbox payload to the dispatcher.

**`{{unsubscribe}}` body token and the two-step opt-out.** The dispatcher resolves `{{unsubscribe}}` (a ready `<a>`) and `{{unsubscribe_url}}` (the raw URL) per recipient. The link is **deliberately two-step**: a **GET** returns a re-affirm confirmation page and changes NOTHING (mail clients and proxies prefetch GET links, so a GET must never opt anyone out); only a **POST** writes the `suppressions` row + `profiles.attributes.unsubscribed = true` in ONE workspace-scoped tx. The `{{unsubscribe}}` body link points at the **preference center** (`/manage-subscription`); the RFC 8058 one-click `List-Unsubscribe`/`List-Unsubscribe-Post` header still points at `/unsubscribe` (a compliant full opt-out).

**Public preference center** (`services/unsubscribe`, `GET/POST /manage-subscription`). GET renders a self-contained page: active topics (checkbox = subscribed, default-on), the two channel groups, and an "unsubscribe from everything" action. POST writes the desired end-state in ONE workspace-scoped tx. **Critical semantics: a PARTIAL opt-out (a topic, or one medium group) writes ONLY those granular rows and NEVER the global suppression** — the person stays reachable on still-subscribed channels. Only "unsubscribe from everything" writes the full `suppressions` row + the profile attribute + an `activity_log` entry. The page is **adaptive**: it shows topics when `workspaces.settings.topics_enabled` AND ≥1 active topic exists, else the plain simple-unsubscribe page (reusing the `/unsubscribe` rendering — one source of truth).

**Tokenized links.** Both public routes REQUIRE a valid token and **403 a missing or forged one** — you cannot unsubscribe someone by editing a query param. `workspace_id` + `email` come ONLY from the verified token, never a body field (inv.2).

- Current format is a single opaque **`?t=`** param: `base64url([ version(1) | uuid(16 RAW bytes) | email(utf8) | HMAC-SHA256 truncated to 16 bytes ])` via `packSubscriptionToken`/`unpackSubscriptionToken` (`@cdp/email`), constant-time compared; any mismatch/garble/bad-version → `null`, never throws. **Email is stored VERBATIM (not lowercased)** — the exact send/suppress address. Deterministic, so a re-sent link re-verifies.
- The **legacy** `workspace_id`+`email`+`token` triple (HMAC over `(workspace_id, lower(email))`) is still accepted for already-sent links. A present-but-invalid token → 403; no identity at all → 400.
- Attribution ids ride as SEPARATE, non-trust-sensitive params **`&b=<broadcastId>` / `&c=<automationId>`** (never inside the token) — they only feed the funnel row.
- Keyed by **`UNSUBSCRIBE_LINK_SECRET`**, shared by the dispatcher signer and the handlers. **`unsubscribeLinkSecret()` and `@cdp/db masterKey()` THROW when `NODE_ENV==='production'` and the var is unset** rather than falling back to the repo-committed dev constant — otherwise every token would be forgeable and every tenant secret encrypted under a public key.
- `GET /profiles/:id/subscription-link` (`manage_content`) returns a recipient's exact tokenized link for the Profile ⋮ "Copy subscription link" action.

**Front-facing language.** The public pages render in English or **Hebrew (RTL)** per `workspaces.settings.front_facing_language` ∈ `'auto'|'en'|'he'` (default `'auto'`, validated on write). `resolveLanguage(setting, acceptLanguage)` (`services/unsubscribe/src/i18n.ts`, pure): `en`/`he` force; `auto` reads the recipient's `Accept-Language` (`he`/`he-IL`/`iw` → Hebrew). Hebrew sets `<html lang="he" dir="rtl">`, the card uses `text-align:start`, and the recipient email is wrapped in `dir="ltr"` + `unicode-bidi:isolate` so mixed text renders cleanly. Error pages (rendered before the workspace is known) fall back to the browser language.

**Company logo.** `companies.logo_asset_id` (a SOFT reference — no hard FK, since assets are workspace-scoped and served public-by-uuid) optionally renders atop both public cards. `GET/PUT/DELETE /company/logo` (`manage_sending_domain`); PUT validates the asset belongs to one of the company's workspaces (400 otherwise). Upload reuses `POST /assets`. The logo is decorative — `renderCompanyLogo` NEVER throws and does not render on the 400/403 pages.

## Tracking & metrics

**Both open and click tracking are opt-in per workspace** via `workspaces.settings.link_tracking`, applied in the **dispatcher** — the single point all sends pass through.

- **Clicks:** every `http(s)` link is rewritten to `<base>/t/<token>`, the token a deterministic sha256 of `(workspace, broadcast|automation, url)` — idempotent and **shared across recipients**. `tracked_links` rows are upserted; the public `GET /t/:token` 302-redirects and increments.
- **Opens:** a 1×1 pixel is injected before `</body>` and a `tracked_opens` row is pre-created with `opens=0`, so an unopened send is still attributed. The pixel token is deterministic **per-recipient** (sha256 of `open|workspace|broadcast?:automation|profile`), so a resend reuses it and exactly one row exists per `(broadcast|automation, profile)` — making **opened = count of rows with `opens > 0`** a distinct-profile count. The public `GET /o/:token` **ALWAYS returns a 43-byte transparent GIF** (`no-store`) — a pixel must never error to the client — and best-effort bumps the counters; an unknown or foreign token still returns the gif and records nothing.
- **Unsubscribe attribution:** the unsubscribe POST parses `&b=`/`&c=` and writes an `email_events` row `type='unsubscribe'` attributed to the source + profile. Not trust-sensitive (metrics only); suppression writes stay scoped to the verified token's workspace. A generic header click attributes nothing.
- **Broadcast funnel** on the list: Sent · Delivered · Failed · Opened · Clicked · Unsubscribed, each a count and a %. Denominators: delivered/failed of *sent*; opened/clicked/unsubscribed of *delivered*; divide-by-zero → `0%`. Delivered/Failed come from `email_events` joined to `messages_log` by `ses_message_id`.
- **Local dev caveat:** Delivered/Failed are 0 without the feedback pipeline, but clicks, opens, and unsubscribes DO populate locally through those public endpoints.
- **Delivery health** (`GET /dashboards/delivery-health?days=N`, `manage_content`, default 30d, clamped 1..365) is **EMAIL-ONLY** (`messages_log medium='email'`) so text sends don't pollute SES reputation metrics. Returns outcomes, rates (bounce = bounced/(delivered+bounced); complaint = complained/delivered) colored against SES thresholds (bounce >5% warn / >10% danger; complaint >0.1% warn / >0.5% danger), current suppression size by reason (not windowed), and a gap-filled per-day trend.

---

# Automations (§9B)

## Trigger kinds & enrollment

`definition.startNode` is the single **trigger node** — one of four `kind`s (`services/automation-runner/src/dsl.ts`):

- **`segment_entry`** — the trigger segment lives on the **automation ROW** (`automations.trigger_segment_id` + `trigger_on` enter|exit), NOT on the node. Drives `enrollFromSegmentChange`.
- **`event`** — the node carries `eventType` (required) + an optional **payload filter** (a `payload.*`-namespace `AstNode`), both in the definition JSON. Drives `enrollFromEvent`. The filter is a **pure, closed-grammar, in-memory** eval (`evaluateEventPayloadFilter`) reusing the `@cdp/segments` operator whitelist — a non-whitelisted operator or a non-`payload.*` field THROWS, never interpolates. **Dotted keys resolve DEEP and FORGIVING** (`webinar_data?.id` semantics) via the shared `resolveEventPath`, with array indices (`items.0.sku`); any missing segment yields `undefined`, so `webinar_data.id exists` is `false` rather than an error.
- **`profile`** — enrolls when a profile is created or updated; the node carries `profileChange: 'created'|'updated'|'any'` (default `'any'`; anything else is rejected). No event payload is persisted, so a downstream `{{event.*}}` resolves safe-empty — read the profile via `customer.*`.
- **`manual`** — enrolled only by `POST /automations/:id/enroll`.

**Where enrollment fires:** in the SAME workspace-scoped tx as the segment re-eval, on the same tx client, right after the event row + feature recompute + realtime re-eval — no nested BEGIN/COMMIT. Production: `services/processor` `runPlanInWorkspaceTx → runSegmentReevalInTx`. Dev mirror: local-api `recomputeFeaturesAndSegments`. Profile triggers fire from `createProfile` / `updateProfile` / `importProfilesCsv` on the request pool's own workspace-scoped tx.

**`POST /automations/:id/enroll`** (`manage_content`) takes **exactly one** of `profile_id` | `segment_id`, scopes automation/profile/segment to `ctx.workspaceId` (cross-workspace → 404), and enrolls either the profile or a **point-in-time SEGMENT SNAPSHOT** (current members via `buildResolveAudience`) — later segment changes do NOT retroactively enroll.

**Re-enrollment policy is `'once'` for ALL kinds.** Enforced structurally by `UNIQUE(automation_id, profile_id)` + `ON CONFLICT DO NOTHING` (`buildEnrollmentInsert`) and decided by `decideReenrollment(hasExisting, 'once')`. Every kind funnels through that insert, so a replayed event, repeated segment entry, or re-run manual enroll yields at most one enrollment. `'always'` remains a forward-compat enum value, not enabled. **Enrollment emits no sends** — it writes `automation_enrollments` only; the runner sweep later drives sends.

Only an `active` automation enrolls (archived/paused never do). The trigger event is persisted onto `automation_enrollments.state.event` at enroll time — **only** in `enrollFromEvent`, the sole path holding the event.

## Node DSL

Eight palette types: `wait`, `wait_until`, `hour_window`, `if`, `send`, `update_profile`, `webhook`, `exit`.

**`validateAutomationDefinition` is the graph gatekeeper**, run on every persist. Beyond per-type field checks it enforces: exactly ONE trigger; resolvable edges; a reachable exit; **no CYCLES** (`detectCycle`, a DFS grey-stack — a self-loop or back-edge throws, but a diamond/re-convergence is ALLOWED); **no ORPHANS** (every defined node reachable from `startNode`). Cycle detection runs BEFORE the reachable-exit check so a loop is diagnosed as a loop.

**Wait.** A SIMPLE `wait` carries `delay` only. A **rich `wait_until`** is a `type:'wait'` node carrying any of: `until` (absolute, tz-aware), `untilOffset {amount, unit, anchor, direction}` (anchor is `'now'` or a `{{…}}` expression resolving to a timestamp; `direction` `'after'` (default) adds, `'before'` subtracts — the reminder pattern), `waitCondition` (a §8 `AstNode`), `combine: 'and'|'or'` (default `'and'`, meaningful only when both gates exist), and `maxWait` (a cap). Validation requires ≥1 gate.
*Semantics:* proceed when the time and condition gates are satisfied per `combine` among enabled+resolvable gates, OR when `maxWait` elapses — the cap is ALWAYS an OR / proceed-on-timeout, with a **single output edge** (no timeout branch). An unresolvable anchor DROPS the time gate; a no-gate-no-deadline node proceeds rather than stranding. A pending condition is re-checked every sweep.
*Pinning:* on first arrival the resolved time target and the max-wait deadline are **PINNED on `state.wait.<nodeId>`** so later sweeps don't drift against a moving `now` or a re-resolved anchor. The pin is written atomically inside the guarded advance UPDATE (a seeded nested `jsonb_set`, node id a bound param) so it can't bump `updated_at` separately and break the claim guard.

**`hour_of_day_window`.** `startHour`/`endHour` (0–23; `start > end` is a VALID overnight wrap), optional `daysOfWeek` (0–6, unique, non-empty). Inside the window → advance immediately; outside → PARK with `next_run_at = nextWindowOpening(now, win, tz)`, honored by the real sweep SQL (no app timer).

**`send`.** Carries `medium` (`email` default | `sms` | `whatsapp`) and, for text, a merge-tag-enabled `text_body`; an sms/whatsapp send REQUIRES a non-blank `text_body`. An EMAIL send node owns its own email INSTANCE: `POST /automations/:id/send-nodes/:nodeId/attach-template` CLONES the chosen library template into a `kind='copy'` and repoints the node's `template_id`. That handler is **draft-aware** — it reads `draft_definition ?? definition` and writes back into the draft when one exists (otherwise a template-less draft shadows a live-only attach and silently drops the email). An unattached `template_id` is a valid draft, gated at publish.

**`update_profile` (`set_attribute`).** Carries `assignments: [{key, value}]` (a legacy single `key`/`value` is still accepted). `buildSetAttribute` applies ALL pairs in ONE parameterized UPDATE via **nested `jsonb_set`**, `workspace_id` at `$1`, every value a bound `::jsonb` param (inv.6) — idempotent on retry. There is also `set_journey`, writing per-enrollment variables to `automation_enrollments.state.journey`.

**`webhook`.** `url` (http(s) only), `method` ∈ GET/POST/PUT/PATCH/DELETE, optional `headers`, `bodyTemplate`, `timeoutMs`, `maxRetries`.

## Value specs (`update_profile` and friends)

A `value` is a **VALUE SPEC**: `{kind:'literal', value}`, `{kind:'expression', expression}` of `{{customer.*}}`/`{{event.*}}`/`{{journey.*}}` tokens, `{kind:'js', code}`, or a legacy bare scalar (implicit literal). `resolveValueSpec` + the shared `{{token}}` engine `renderExpression` live in `packages/shared/src/expression.ts`. **An undefined or unknown path resolves SAFELY to `''`** — never throws, never writes a raw `{{…}}`. Resolution is read-only string substitution, never SQL. Because the value re-resolves from immutable persisted state, retries produce an identical write.

**Sandboxed JS values — security-critical.** `@cdp/shared` is ISOMORPHIC (the web bundle imports it) so it **never evaluates `js`** — no `node:vm` import; an unrecognized `js` spec resolves to a defensive null. The Node-only evaluator is `services/automation-runner/src/js-value.ts` `evaluateJsValue`. Its safety model:

- Every `{{token}}` is interpolated as `JSON.stringify(value)` — a QUOTED literal, injection-inert; unknown → `""`.
- `customer` and `event` are passed as JSON strings and `JSON.parse`d **INSIDE** the VM context (context-native), defeating the `customer.constructor.constructor('return process')()` realm escape.
- The context is `vm.createContext(Object.create(null))` — EMPTY, no host globals (`process`/`require`/`Buffer`/`global` are undefined).
- A strict IIFE wraps the code; `runInContext` has a 100ms timeout.
- **The result is coerced to a string INSIDE the context, under the timeout**, so a returned object with a looping or throwing `toString` is bounded by the vm timeout — a host-side `String(result)` would run it OUTSIDE the guard. Only a string primitive crosses back.
- ANY throw, timeout, or escape → `''` (safe-empty), never propagated to the tick. Validation only checks that `code` is a string; nothing is evaluated at validate time.

## Runner execution

**Single-winner claim.** `runEnrollment` advances under a `FOR UPDATE` tx (a legacy CAS path also exists); per-`(automation, profile, node)` dedupe plus outbox dedupe make every step at-most-once. `MAX_STEPS_PER_TICK` bounds a chain.

**Pause gate.** The tick reads `automations.status` alongside the definition and advances ONLY when `isEnrollableAutomationStatus(status)` (i.e. `'active'`). A paused automation's due enrollment is left PARKED exactly where it is — no node move, no outbox, no webhook — a reversible halt.

**Workspace timezone governs all time math.** The tick reads `workspaces.settings.timezone` (default `UTC`, validated) from the enrollment's own `workspace_id` — never client-supplied — and threads it into `processNode`. A **bare wall-clock** `until` (no Z/offset) is interpreted in that zone; an explicit-offset value is honored verbatim. Shared helpers (`tzOffsetMs`, `zonedInputToUtcIso`, `utcIsoToZonedInput`, `timeZoneList`, `isValidTimeZone`, `zonedComponents`, `isWindowOpen`, `nextWindowOpening`) live in `packages/shared/src/timezone.ts` so the broadcast scheduler and automation time math share ONE DST-correct implementation. `timeZoneList()` guarantees `'UTC'` is present (some engines list only `Etc/UTC`).

**Webhooks fire POST-COMMIT, never inside the FOR UPDATE tx** (mirroring `enqueueSends`): the tick collects a `{kind:'webhook'}` intent, the tx commits the guarded advance, then `runWebhooks` calls the **injected** `WebhookHttpClient` — an external call must not hold a row lock. Single-winner claim ⇒ **at-most-once**; an `activity_log` marker (`dedupe_key`, partial unique index, `ON CONFLICT DO NOTHING`) prevents a crash-recovery re-fire.

**`@cdp/runner-webhook` safety model.** `assertWebhookTargetAllowed` runs BEFORE any client call: a **deny-by-default per-workspace host allowlist** (`workspaces.settings.webhook_allowlist`; empty or missing ⇒ every host refused; never client-trusted, inv.2), PLUS refusal of literal loopback/`localhost`, `169.254/16` metadata, RFC1918, and IPv6 ULA/loopback, http(s) only. A blocked target returns `{ok:false, error:'blocked', attempts:0}` with ZERO client calls and never throws. **Retries** are bounded by `1+maxRetries` and only on ≥500 or network timeout — **never on 4xx**. The body is merge-rendered; an encrypted auth-header secret is decrypted at call time only — the stored definition and the recorded `activity_log` detail never carry plaintext. **Failure isolation is continue-on-failure:** a failed or blocked webhook is a notification side effect, not a gate — it records an `activity_log` row (`success`/`failed`/`blocked`) and the enrollment ADVANCES, never stranded on a flaky host.

**In-tick journey visibility.** A tick-local accumulator (seeded from `state.journey`) folds forward after each `set_journey`, so "set a journey var → branch on it" or "→ send `{{journey.x}}`" works IN THE SAME TICK. Without it the IF would read stale start-of-tick state, since the SQL write only commits at tx end.

**Dev sweep.** Production advances enrollments via `scheduledSweepHandler` on an EventBridge cron. The dev server has no scheduler, so `server.ts` runs an in-process `sweepDueAutomationEnrollments` every `LOCAL_AUTOMATION_SWEEP_MS` (default 30s) using the SAME single-tx FOR UPDATE path, with a NO-OP `SqsSender` (local has no queue) and per-row try/catch so one bad enrollment can't abort the cross-workspace sweep. After the tick it drains new pending automation outbox rows so send nodes actually deliver in dev.

## Lifecycle, drafts & versions

**Lifecycle** (`automations.status`: draft | active | paused | archived) via `POST /automations/:id/{pause,resume,archive}` (`manage_content`, workspace-scoped), gated by the pure transition table `nextLifecycle`: pause `active→paused` (idempotent), resume ONLY from `paused` (else 409), archive from any state. Archived rows drop from the default list.

**Delete vs archive.** An automation that was **never published** (`active_version_id IS NULL`) can be hard-DELETED via `DELETE /automations/:id` — one workspace tx dropping enrollments then the automation (versions cascade). A **published** automation 409s: *"A published automation can't be deleted — archive it instead."* — it is history.

**Draft/live separation.** The runner reads the LIVE `automations.definition` + `trigger_segment_id`, untouched by editing. Alongside: `draft_definition` (NULL ⇒ no unsaved draft), `draft_trigger_segment_id`, `active_version_id` → `automation_versions` (workspace-scoped + RLS, `UNIQUE(automation_id, version)`, **append-only** snapshots).

All endpoints are `manage_content`, workspace-scoped (a foreign automation/version id → 404), `workspace_id` never from the body:

- **`PUT /automations/:id/draft`** `{definition, trigger_segment_id?}` — the builder's autosave target. Writes ONLY the draft columns, never live/status. Validates the graph (typed 400). **Every node-graph edit goes here**; `PUT /automations/:id` remains for name/trigger edits.
- **`GET /automations/:id`** → `definition` = the draft to EDIT (`draft_definition ?? definition`), plus `liveDefinition`, `hasDraft` (present AND differing), `activeVersion`, the draft trigger, `status`, `trigger_on`, `keep_while_in_segment`.
- **`POST /automations/:id/publish`** `{name, scope:'forward'|'backfill'}` — in ONE tx: take the draft; run the shared **publish gate** (`runAutomationPublishGate`) BEFORE any mutation; snapshot a version (`version = max+1`); set live = published, `active_version_id`, `status='active'`; CLEAR the draft. With `scope='backfill'` **and** a `segment_entry` trigger with a segment, enroll the segment's CURRENT members on the SAME tx client (so the freshly-set `active` status is visible), idempotent via the `'once'` conflict. Forward / event / manual triggers backfill NOTHING. Returns `{version, name, enrolled}`.
- **`GET /automations/:id/versions`** — newest-first, `is_active` flagged. **`POST /automations/:id/revert`** `{version_id}` loads that version INTO the draft; LIVE is untouched (append-only history never destroys). Reverting to the CURRENTLY ACTIVE version 409s, and the UI hides that row's revert control.
- **`GET /automations/:id/enrollments`** — the Journeys tab: enrollments joined to profiles, newest first, LIMIT 200.
- `POST /automations/:id/activate` remains an in-place re-activate of the LIVE definition; `publish` is the draft→live flow.

**The publish gate** (`collectSendNodeEnvelopeGaps` in `dsl.ts`, BFS order) walks the send nodes and emits the SAME ordered 409s as `sendBroadcast`, **naming the offending node**: an EMAIL send → sender → to → subject, then the verified-domain gate; a TEXT send is gated ONLY on `text_body`, skipping the envelope AND the domain gate. So a text-only or send-less automation activates WITHOUT a verified sending domain. The gate runs server-side before mutation; the UI surfaces the reason inline AND on the offending card (the API client must carry the FULL error body through, not just `{status,error}`, or the `node`/`missing` fields are lost).

## Builder canvas

`web/src/screens/AutomationBuilder.tsx` renders an `AutomationDefinition` as a **downward tree**. The DSL `{startNode, nodes}` stays the SINGLE graph model: **NO stored coordinates** (positions are recomputed every render) and **NO loops or orphans** (editor-enforced, server-validated).

Pure modules under `web/src/automations/`:
- `model.ts` — `parseDefinition`/`buildDefinition` round-trip the DSL ↔ a normalized `CanvasModel` whose edge list derives ONLY from `next`/`onTrue`/`onFalse`.
- `layout.ts` — a Reingold-Tilford-style two-pass tree: BFS depth → y (every child strictly BELOW its parent; a re-convergence node takes `max(parentDepth)+1`, counted once), then x-packing so siblings are disjoint and a condition's arms fan to the sides.
- `orthogonal-path.ts` — rounded ORTHOGONAL SVG paths built from V/H runs with clamped Q corners: **diagonal-free by construction**, and it THROWS if the target isn't below the source.
- `mutate.ts` — every graph mutation, unit-tested first.
- `node-config.ts` — pure read/write serializers per node type; `applyNodeConfig` MERGES the patch, so a writer must emit every field it owns (including `undefined` for a disabled gate) or a stale value lingers.

**Mutation rules.** `insertOnEdge` only ever rewrites `A→B` into `A→NEW→B`, so a back-edge is unconstructable. **A condition insert REJOINS**: both `onTrue` and `onFalse` point at the continuation B, making B a **JOIN purely structurally — the node with 2+ incoming edges**. There is NO stored `join` flag. An EMPTY arm is simply the slot still pointing at the join (it passes through); to terminate one arm, insert an `exit` on it, which is allowed whenever the arm is CONVERGING (the join stays reachable via the sibling) and refused when it would orphan B on a non-converging edge. `deleteNode` splices a single-out node or removes a condition keeping its `onTrue` arm, and REFUSES to delete the trigger or the last reachable exit. `insertAfterBranch` (the merge `+`) re-points every boundary edge feeding the continuation through a new node, so both arms flow through it.

**Move / Duplicate.** `movePlan(model, rootId)` decides the unit: a **CONDITION** relocates its EXCLUSIVE SUBTREE (`S = fromR \ reachableWithoutR`, with a single boundary target as the continuation — 2+ boundary targets throws "This branch can't be moved as a unit"); a **non-condition single-out node** moves as `mode:'single'` — JUST that node (splice-out + insert), not its downstream tail, which is both more intuitive and lets a step be dropped onto a sibling arm. `canDropOnEdge` gates valid placement targets for both move and duplicate. Duplicate clones with FRESH ids (fresh ids cannot cycle) and leaves originals intact.

**Every mutation is double-checked:** local guards `assertWellFormed` (reachable exit, no dangling edge, `hasCycle` DFS — deliberately NO runner import in the web bundle) throw a `MutationError` surfaced as a toast, and the server's `validateAutomationDefinition` re-checks on persist (it also catches ORPHANs the lightweight local guards intentionally skip).

**Two first-class rendering invariants**, asserted over many graph shapes in `web/src/automations/branch-invariants.test.ts`:
- **RULE 1 — every `+` has a line above AND below it.** Every insertion control is centered on a STRAIGHT VERTICAL run with at least `PLUS_PAD` of connector above and below — never bare, never within `PLUS_PAD` of a corner. **The pad on each side must be ≥ the height of the `+` circle, wherever a `+` renders**, hence `PLUS_PAD = PLUS_DIAMETER` and `MIN_SEGMENT = 3·PLUS_DIAMETER`. Node-following `+`s bias HIGH under their source card (`padHigh`, clamped so the below-pad still holds); merge and straight-run `+`s center (`padCenter`).
- **RULE 2 — an If's two arms are EQUAL height, kneeing back only at the longer arm's end.** The join sits at `If.depth + max(armLength) + 1`. The shorter arm's column runs straight down a plain empty vertical, and BOTH arms knee back to center at the SAME shared y (`crossY`), converging on the join below.

Supporting layout rules: a condition's arms sit at center ± a FIXED `BRANCH_HALF_GAP`, **identical at every depth** — the offset uses each arm's EXCLUSIVE width (stopping at anything reachable from the sibling), so the shared join and post-merge trunk never inflate it, and only an arm containing a nested branch widens (its own side only). A node with a SINGLE outgoing edge always places its child at the same x, so linear chains are pure straight verticals; joins drag their whole downstream subtree when re-centered. Empty diamonds get the same treatment as populated ones — rounded shoulders, centered arm `+`s, a padded merge `+`. **Constants to tune live in `orthogonal-path.ts` (`MIN_SEGMENT`, `PLUS_PAD`, `PLUS_TOP_GAP`, `RAIL_INSET`, `CORNER_RADIUS`) and `layout.ts` (`LAYOUT.rowHeight`, `BRANCH_HALF_GAP`, `EMPTY_ARM_LANE`, `JOIN_*_DROP`, `MERGE_LOWER_RUN`) — change them together and re-run the invariant tests.**

**Interaction.** The canvas zooms 40–200% (view-only `transform: scale()`; connector coordinates are unchanged, so geometry assertions hold at scale 1), pans by dragging the **board background only** (`onPointerDown` bails when the target matches the interactive selector — cards, `+`s, menus, banners, controls), and pinch-zooms via a **non-passive** `wheel` listener registered through a ref (Preact's `onWheel` is passive and cannot `preventDefault`); a non-ctrl wheel is not intercepted, so native scrolling still works. Placement mode (move/duplicate) shows a sticky banner, re-labels every `+` as a placement target, and cancels on Escape via a **single lifetime-stable** capture-phase listener reading the latest state from refs (a deps-array listener silently stops re-registering after the first cancel).

**Screens.** `/automations` is a LIST (`AutomationsList`); the builder lives at `/automations/new` and `/automations/:id` (`AutomationDetail`), mirroring the broadcasts list/wizard split. **The route table must map `/automations/:id`** — the email editor's Back navigates there and the builder re-opens via `takeReturnedTo()`. Tabs: Builder · Journeys · History. Email design lives ONLY inside a send node's editor; there is no standalone "Design email" button on the automations page.

**Two wiring rules that make the send-node editor work:** (1) `openEditor` ALWAYS persists the model before opening a node editor — a freshly-inserted node must exist server-side or `attach-template` 404s; (2) after `attach-template` the editor reloads the automation BEFORE closing, so the model picks up the server's repointed `template_id` and a later re-persist can't wipe it.

---

# Segments & personalization

## Merge values are ESCAPED at the HTML sinks

**A merge value is data, not markup.** A broadcast's merge map is built from PROFILE
ATTRIBUTES, and those are writable by anyone holding the `pk_live_` key we document
as safe to embed in a public web page (`/v1/identify` is keyed by email, so the
writer is not limited to their own row). Rendered raw, a trait of
`<a href="https://phish.example">Update your details</a>` becomes a working link in
mail signed by the workspace's own domain — and click tracking then rewrites it to
OUR domain. Not XSS (clients strip `<script>`); worse for a sending platform.

- **`renderExpressionHtml` (`@cdp/shared`) is the HTML sink renderer**, separate from
  `renderExpression` by construction — most callers must NOT escape (a subject line,
  a To address, an SMS body, a profile-attribute write would each carry a literal
  `&amp;`). Only TWO sinks use it: the dispatcher's `buildSendEmailInput` html
  (`onUnknown:'keep'`) and `renderTransactional`'s html (`'empty'`). Note
  `renderTemplateBody` has SEVEN call sites and only one is HTML — never add
  escaping inside it.
- **`{{{token}}}` writes a value RAW**, for a value that genuinely is a designed HTML
  block (`{{{data.body_html}}}`). The triple form LEADS the alternation so a raw
  substitution is never re-scanned by the escaping pass.
- **`SYSTEM_HTML_MERGE_KEYS`** (currently just `unsubscribe`) are written verbatim in
  the double-brace form too: `{{unsubscribe}}` resolves to an anchor the dispatcher
  builds from the signed token, and escaping it leaves every marketing email without
  a working unsubscribe link. Trusted because nothing outside our code can set a bare
  key — profile data lands under `customer.*`.
- **`sanitizeHrefSchemes` runs on the FINAL rendered HTML**, not on the template:
  escaping does nothing for a value that IS a URL (`javascript:alert(1)` has no
  HTML-significant character), and the tracking rewrite runs before substitution so it
  only ever sees `{{token}}`. Allowlist `http`/`https`/`mailto`/`tel`; a schemeless
  href is left alone; anything else has the attribute REMOVED. Whitespace and control
  characters are stripped before the scheme is read (`java\tscript:` runs in clients).

## `customer.*` namespace (extends §8/§11)

One systemwide token scheme for referring to a profile in **both** segment rules and merge tags. `customer.email` / `customer.phone` / `customer.external_id` / `customer.email_status` / `customer.created_at` map to profile columns; `customer.attributes.<key>` is a custom attribute; and **`customer.<key>` is shorthand for `customer.attributes.<key>`** — so `{{customer.tier}}` ≡ `{{customer.attributes.tier}}`, and in a rule `customer.tier` ≡ `attributes.tier`. Single source of truth: `packages/shared/src/customer.ts` (`expandCustomerPath`, `expandCustomerToken`, `resolveCustomerField`, `customerMerge`). The segment compiler normalizes the field BEFORE the whitelist (inv.6 unchanged). Legacy bare `attributes.*` / scalar names still work.

**Merge tags render in the SUBJECT, the To, AND the HTML body** — all three pass through `renderTemplateBody` in `buildSendEmailInput`.

## `event.*` namespace

The structural TWIN of `customer.*`, referencing the **trigger event payload** that enrolled a profile: deep-dot with array indices (`{{event.items.0.sku}}`). Canonical in `packages/shared/src/event.ts`. It resolves from the immutable `state.event` persisted at enrollment, which is why re-resolution on retry is identical. Where no event was persisted (segment/manual enrollment) it resolves safe-empty.

## Rule kinds

The shared `RuleBuilder` offers five kinds: **Profile attribute**, **Event**, **Segment**, **Trigger event**, and **Journey attribute**.

**Trigger-event and Journey leaves are NOT SQL-compilable** — trigger payloads and per-enrollment journey vars don't live in a profile table. The runner evaluates them **in memory** and folds each to a `ConstNode` BEFORE the segment SQL (`rewriteTriggerEventLeaves`, then `rewriteJourneyLeaves`, then `buildBranchMatchQuery`). `@cdp/segments` `validateAst` accepts them, but **`compileWhere` THROWS** if one reaches SQL — that is a bug, not a fallback. Both use the same whitelisted operator semantics and deep-dot, forgiving resolution.

---

# Data & storage

## Uploaded images — per-company object storage (Cloudflare R2)

An `assets` row records WHERE the bytes live: `storage='r2'` keeps only the object `r2_key` + `size_bytes`; `storage='db'` is the legacy base64 fallback.

- **Per-company, like every other provider:** `company_r2_config` (company-scoped + RLS, `secret_access_key` encrypted via `@cdp/db` secret-crypto, write-only). Each company brings its own bucket and pays its own storage. CRUD `GET/PUT/DELETE /company/r2-config` (`manage_sending_domain`).
- **S3-compatible seam** `services/local-api/src/storage.ts` (`ObjectStorage` with put/get/del, `makeR2Storage(cfg)`), resolved per request by `r2StorageForWorkspace` which decrypts the secret only there. **Null when the company has no config → base64-in-DB fallback**, so dev and tests need no bucket. The factory is injected via `LocalApiDeps.makeR2Storage` for an in-memory fake.
- **`GET /assets/:id` STREAMS the bytes back through the app on the SAME domain** — no separate `assets.*` host. This is a requirement, not an accident: URLs are frozen into saved `email_templates` (design, mjml, compiled_html) and must keep resolving. The tradeoff is that image bytes ride Fly bandwidth rather than R2's free CDN egress (modest — email proxies cache).
- `POST /assets/backfill-r2` (`manage_sending_domain`, workspace-scoped, idempotent — only `storage='db'` rows) migrates existing images into the company bucket.

## Text-template library

A workspace-defined library of reusable PLAIN-TEXT messages, **medium-agnostic** (one body serves SMS or WhatsApp). `text_templates` (workspace-scoped + RLS). CRUD `GET/POST /text-templates`, `GET/PUT/DELETE /text-templates/:id` (`manage_content`; blank name or body → 400).

Unlike an email template, this is **copy-on-select with NO live reference and NO new column**: picking one in a text send's body step COPIES its body into the existing `text_body` (the broadcast row, or the automation send node's field in the definition jsonb). The picker appears in the broadcast wizard and the automation send-node editor, and only when ≥1 template exists. Bodies are merge-tag enabled.

## Activity log

`GET /activity` (`listActivity`) UNIONs four sources: `events` (behavioral), `email_events` (feedback), `messages_log` (sends), and `activity_log`.

**`activity_log`** is an append-only feed for SYSTEM/admin actions that are NOT behavioral events and must NOT pollute `events` (which feeds segment rules and the profile timeline): unsubscribes, profile created/updated, CSV imports (one summary row, not per-profile), and webhook outcomes. The public ingest API logs `profile_created` **only on actual creation**, not on the per-event update, to avoid flooding. `activity_log.workspace_id` is `ON DELETE CASCADE` (so a test teardown that deletes the workspace needs no extra step) and `profile_id` is `ON DELETE SET NULL` (reassigned to the survivor on merge).

For a `messages_log` row the activity TYPE is the **medium** (`sms`/`whatsapp`/`email`, not the literal `send`) and the detail is `COALESCE(reason, status)`, so a skip reason like `'recipient has no phone'` is visible. The log is master/detail: a row with detail expands in place to a `JsonView`; the profile cell is a link.

## Profile actions

The Profile detail header consolidates into one ⋮ `ActionMenu`: **Send event**, **Merge…**, **Copy subscription link**, **Delete profile…**.

**Send event** (`POST /profiles/:id/events`, `manage_content`) records ONE behavioral event on the profile's behalf and, in ONE workspace-scoped tx, recomputes rolling features + re-evaluates `dynamic_realtime` segments via the shared `recomputeFeaturesAndSegments`. A manual event therefore behaves exactly like an ingested one.

**Delete profile** (`DELETE /profiles/:id`, `manage_content`) is a HARD delete + FULL erasure (GDPR right-to-be-forgotten). Because every `profile_id` FK is `ON DELETE NO ACTION` (only `activity_log` is SET NULL), children are deleted FIRST in ONE workspace-scoped tx: the handler loops **`PROFILE_CHILD_TABLES`** (`events, email_events, messages_log, outbox, segment_change_log, segment_memberships, automation_enrollments, topic_subscriptions, channel_optouts, tracked_opens, activity_log, profile_features`), then deletes the suppression keyed by the profile's **email** (`suppressions` has no `profile_id` — full erasure was chosen over retaining the address), then the profile row. **Keep `PROFILE_CHILD_TABLES` in sync whenever a new profile-referencing table is added.**

---

# Frontend notes

**Responsive.** The SPA reflows for mobile/tablet while the desktop layout and every `data-testid` are preserved (the Playwright gate runs at desktop viewport). The sidebar is a slide-in drawer below `md` and the unchanged sticky `w-64` sidebar at `md+`; a mobile topbar holds the hamburger, a scrim closes it, and it auto-closes on route change. Tables scroll inside their cards, never the page. **The automation canvas and the email designer stay DESKTOP-FIRST** (they have their own pan/zoom/scroll) — their containers just must not break the page.

**Read-only JSON** renders through the shared `web/src/ui/JsonView.tsx` (`prettyJson` handles an object or a JSON string; a plain string passes verbatim).

**Autocomplete** uses the shared `web/src/ui/Suggest.tsx` combobox — free-text input that opens a dropdown of existing workspace values on focus and filters as you type (debounced, click-outside closes). Free text is always still allowed. It is deliberately NOT a `<datalist>` (hidden until you type, which reads as "no suggestions") and not a tag cloud. Backed by `/events/types`, `/events/payload-keys`, `/events/payload-values`.

# Production secrets

Secrets use envelope encryption (`@cdp/db` secret-crypto) with `CDP_MASTER_KEY` as the KEK. **In production the KEK should move to AWS KMS / Secrets Manager**, not a plain env var. `UNSUBSCRIBE_LINK_SECRET` and `CDP_MASTER_KEY` both **fail fast** in production when unset. Live secret locations are recorded in the `reference-prod-secrets-locations` memory; provider setup steps are in `.a5c/PROVIDERS-SETUP.md`.
