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
- **Email editor:** Core GrapesJS (BSD-3, free) + MJML plugin — NOT the paid Studio SDK. Editor must emit MJML, never hand-rolled HTML.
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

No build/test/lint commands exist yet — there is no `package.json`. **When scaffolding the project, add the chosen commands (build, test, single-test, lint, CDK deploy, local dev) to this section** so future instances don't have to rediscover them.
