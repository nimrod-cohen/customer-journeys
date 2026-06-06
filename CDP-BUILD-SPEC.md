# Serverless Marketing CDP — Build Specification (v8)

**Purpose:** a complete, implementation-ready plan for an engineer or Claude Code to build the system. v8 adds the **4-role model** (§3A) and scopes the **core features** — segments (dynamic + manual), broadcasts (§9A), and campaigns as a multi-step workflow engine (§9B). All major decisions are locked (§0).

---

## 0. Locked decisions

| Decision | Choice |
|---|---|
| Platform | **AWS**, fully serverless (no servers to manage) |
| Backend language | **TypeScript on Node.js** (Lambda, real Node runtime) |
| HTTP entry (ingest + admin API) | **API Gateway REST API** (request validation, **per-workspace API keys + usage plans**, native WAF) |
| Multi-tenancy | **Pooled / shared-schema**: single DB, `workspace_id` on every tenant row, enforced by **Postgres RLS** + app-level scoping |
| Queue | **Amazon SQS FIFO** (+ DLQ), `MessageGroupId = profile_id` |
| Database | **Supabase (managed PostgreSQL)**, pooled connection from Lambda |
| Email | **Amazon SES**; **each workspace sends from its own verified domain**; **shared IP pool by default**, with **opt-in dedicated IP** that the system **recommends** once volume/pattern justify it; per-workspace suppression, Configuration Set, reputation policing; open/click tracking enabled |
| Email editor | **Core GrapesJS (open-source, BSD-3) + MJML plugin** (NOT the paid Studio SDK) |
| App-user auth | **Supabase Auth**; **users may belong to multiple workspaces** (switcher); JWT carries the active `workspace_id`; validated at the gateway via a **Lambda authorizer** |
| Object storage / CDN | **S3 + CloudFront** |
| Cost attribution | **Self-metered usage** per workspace, **hybrid policy**: direct costs (email sends, **dedicated IP ~$25 if upgraded**, image bytes) by usage; fixed costs (Supabase, baseline compute) split evenly across active workspaces (no billing system yet) |
| Infra as Code | **AWS CDK (TypeScript)** |

---

## 1. What we are building (plain summary)

A self-hosted, **multi-tenant** marketing Customer Data Platform (CDP) that other companies can use:

1. Each **company has a workspace**; users, events, profiles, segments, templates, sends, and suppressions all belong to a workspace and are isolated from other workspaces.
2. **Ingests behavioral events** per workspace over HTTP.
3. Maintains a **unified customer profile** per person *within a workspace*, with rolling aggregates.
4. Lets each workspace's marketers define **complex segments**.
5. Evaluates segment membership in **near-real-time** and fires **triggers** (e.g. send email) on entry/exit.
6. Sends email via **Amazon SES** with full **bounce/complaint/suppression** handling, isolated and policed per workspace.
7. Provides an **admin web app** (React/Preact) scoped to the logged-in user's workspace, with a **WYSIWYG email editor**, segment builder, campaigns, dashboards.
8. **Meters per-workspace usage** so each company's cost share can be computed.

### Design goals (priority order)
1. **No lost events** — durability over raw availability.
2. **No servers to manage** — fully serverless/managed.
3. **Tenant isolation** — no workspace can ever read or affect another's data.
4. **Per-profile event ordering** — a `progress` event never processes before its `profile_created`.
5. **Near-real-time** segmentation (seconds is fine).
6. **Cheap at this scale**, scaling cleanly, with usage attributable per workspace.

---

## 1A. Core features (product scope)

Three user-facing capabilities, all workspace-scoped. (Kept intentionally high-level here; per-feature detail is defined in its build phase.)

- **Segments** — a group of people, of two kinds:
  - **Dynamic** — rule-based on **events they did or attributes they have** (the §8 rule-AST engine; realtime + batch). Membership auto-updates.
  - **Manual** — a static group the user explicitly curates (hand-pick / CSV import). Membership changes only when the user edits it.
- **Broadcasts** — a **single email sent once** to a segment or manual group (a one-off blast). Resolves the audience at send time and runs each recipient through suppression / frequency-cap / quiet-hours before sending (§9A).
- **Campaigns** — a **multi-step workflow / journey**: triggers, conditions, branches, waits, and actions (e.g. enroll on segment entry → wait 2 days → if opened, send B, else send C). A durable per-profile state machine (§9B).

Segments feed both broadcasts and campaigns. Broadcasts and campaigns both emit sends through the same Dispatcher → SES pipeline (§9).

---

## 2. Scale assumptions

| Metric | Today | 5-year |
|---|---|---|
| Workspaces (companies) | a few | many (plan for it) |
| Customer profiles (total across workspaces) | ~40,000 | ~200,000 |
| **Inbound events** | **~5,000/day ≈ 150,000/month** | similar order of magnitude |
| Emails sent | ~500,000/month | ~2,500,000/month |
| Regions | Single region | same |

- *Inbound events* (~150k/mo) are the externally-controlled number. Each triggers internal work (ingest → processor → segment eval → dispatcher), totalling roughly **500k–900k Lambda invocations/month** — around the 1M free-tier line, so **compute is effectively free**.
- The bill is dominated by **SES email**, which tracks send volume.
- **Pooled multi-tenancy** keeps this true: one shared, cheap infrastructure serving all workspaces, rather than per-tenant infrastructure that would multiply fixed costs.

**No streaming database** is needed at this scale; PostgreSQL queries handle segmentation.

---

## 3. Multi-tenancy model

### Isolation strategy: pooled / shared-schema
- **One database, one set of tables.** Every tenant-scoped row carries a `workspace_id`.
- Isolation enforced **two ways (defense in depth)**:
  1. **Application code** always filters by `workspace_id` (mandatory in every query and the segment SQL compiler).
  2. **Postgres Row-Level Security (RLS)** policies restrict rows to the caller's workspace.
- **Why pooled (not schema-per-tenant or db-per-tenant):** cheapest and simplest to operate, fits many small tenants, and Supabase RLS is purpose-built for it. Per-schema/per-db isolation multiplies fixed cost and migration complexity — only worth it for a large enterprise tenant demanding hard isolation, which you can graduate a single tenant into later without re-architecting the rest.

### Entities
- `workspaces` — the company/tenant (plus its sending-identity config and status).
- `workspace_users` — membership linking a Supabase Auth user to a workspace, with a **workspace role** (`owner` / `marketer` / `accounting`). A user may hold different roles in different workspaces.
- `platform_admins` — separate table of **`system-admin`** users (the platform operator). Cross-tenant; *not* workspace-scoped. See §3A.
- Every domain table (profiles, events, segments, campaigns, templates, outbox, messages_log, suppressions, email_events, …) has `workspace_id NOT NULL`.

### Uniqueness becomes per-workspace
- `profiles.external_id` is unique **per workspace**, not globally (`UNIQUE(workspace_id, external_id)`). Two companies can have a customer with the same external id.
- Suppressions are keyed `(workspace_id, email)` — see §10.

### RLS caveat (important for implementation)
- The **admin app** connects with the **user's JWT** → RLS applies and enforces workspace scoping automatically.
- **Backend processing Lambdas** (ingest/processor/dispatcher/feedback) connect with the Supabase **service role**, which **bypasses RLS**. Those Lambdas **must enforce `workspace_id` scoping in code** — RLS is not a safety net for them. Treat explicit `workspace_id` filtering as mandatory in all service code; RLS is the guard for user-context (admin app) access.

---

## 3A. Roles & permissions

Four roles. `system-admin` is **platform-level (cross-tenant)**; the other three are **workspace-scoped** (from `workspace_users.role`, per workspace).

| Capability | system-admin | owner | marketer | accounting |
|---|:--:|:--:|:--:|:--:|
| View **all** companies & workspaces (cross-tenant) | ✓ | – | – | – |
| Manage workspace users & roles | ✓ | ✓ | – | – |
| Manage sending domain / IP upgrade | ✓ | ✓ | – | – |
| Segments, broadcasts, campaigns, templates, profiles | ✓ | ✓ | ✓ | – |
| Billing / spend / usage view | ✓ | ✓ | – | ✓ |

- **system-admin** — the platform operator (you). Sees and supports every company's workspaces. The **only** role that crosses tenant boundaries.
- **owner** — full control *within* their workspace(s): users/roles, domain & IP, plus everything marketer and accounting can do.
- **marketer** — builds and runs segments, broadcasts, campaigns, templates; views profiles. No user/domain/billing admin.
- **accounting** — read access to billing/spend/usage (the §20 cost data). No campaign/segment editing.

### system-admin: handling the one cross-tenant role (security-sensitive)
- Stored in `platform_admins` (user_id). The Lambda authorizer detects membership and injects an `is_platform_admin` claim.
- **RLS exception:** tenant-table policies allow access when `is_platform_admin` is true (e.g. `USING (workspace_id = active_ws_claim OR is_platform_admin_claim)`). This is the deliberate isolation break — keep it narrow.
- **Guardrails:** every system-admin access is **audit-logged** (who, which workspace, what); destructive cross-tenant actions require explicit confirmation; prefer read-mostly support views. Treat this role's credentials as high-value (MFA, few holders).

---

## 4. Technology stack (concrete)

| Concern | Choice | Notes |
|---|---|---|
| Language (backend) | **TypeScript on Node.js** (Lambda, Node 20+) | Real Node → full npm incl. `sharp`. |
| Compute | **AWS Lambda** | ingest, processor, dispatcher, feedback, unsubscribe, image, batch-eval, api, authorizer, metering. |
| HTTP entry | **API Gateway REST API** | Ingest + admin API. **Per-workspace API keys + usage plans** (now load-bearing for tenancy), request validation, WAF. |
| Auth on admin API | **Lambda authorizer** validating **Supabase** JWTs + resolving workspace | REST API has no native JWT authorizer; authorizer verifies token against Supabase JWKS and injects `workspace_id` + role into request context. |
| Multi-tenant isolation | `workspace_id` + **Postgres RLS** + app scoping | See §3. |
| Queue | **Amazon SQS FIFO** (+ DLQ) | `MessageGroupId = profile_id` (UUID, globally unique); `workspace_id` travels in the message body. |
| Scheduling | **EventBridge Scheduler** | Batch segment eval, soft-bounce retry, usage rollups. |
| Database | **Supabase (managed PostgreSQL)** | System of record. **Pooled** connection string from Lambda. |
| Object storage | **Amazon S3** | Email images per workspace (key-prefixed by `workspace_id`). |
| CDN | **Amazon CloudFront** | Serve SPA + images. |
| Email | **Amazon SES** | $0.10/1k; dedicated IP (~$25/mo); Configuration Set(s); per-workspace policing. |
| Email feedback | **SNS** (SES event publishing) → Feedback Lambda | Bounce/complaint/delivery/open. |
| Frontend | **Preact (or React) SPA, Vite** | Static on S3 + CloudFront; scoped to the user's workspace. |
| App-user auth | **Supabase Auth** | Marketers/admins. Users ↔ workspaces via `workspace_users`. |
| Email WYSIWYG editor | **Core GrapesJS (BSD-3, free) + MJML plugin** | Client-side; emits MJML → compiled to cross-client HTML. Unlayer is the fallback. |
| MJML → HTML | **mjml** npm in a Lambda at template-save time | |
| Image processing | **sharp** in a Lambda | |
| Infra as Code | **AWS CDK (TypeScript)** | |
| Local dev | **SAM local**/**serverless-offline** + **Supabase CLI** | |
| Observability | **CloudWatch** logs/metrics/alarms; **per-workspace** reputation + usage metrics | |

> **Cloudflare alternative** (flat pricing, zero image egress): Workers/Queues/R2 instead of Lambda/SQS/S3; keep SES + Supabase. Same shape; Workers isn't full Node and `sharp`→Images binding.

---

## 5. Prerequisites — what *you* must set up

1. **AWS account** + IAM admin role for deployment (CLI profile; never hardcode).
2. **Supabase project** (Pro). Pooled + direct connection strings, URL, anon/service keys, JWT/JWKS details. Plan a **custom JWT claim** for `workspace_id` (set via Supabase Auth hooks / your login flow).
3. **SES production access** — request early (new accounts are sandboxed). Note: because each *customer company* verifies its own sending domain, **you** mainly need an operator domain for the admin app; sending domains are added per workspace during onboarding (§10).
4. **SES dedicated IP** (~$25/mo) + warm-up plan (standard ramp in §10). (Plan for **dedicated IP pools per workspace** as any tenant's volume/reputation warrants — §10.)
5. **Admin app domain** + ACM cert (us-east-1) for CloudFront.
6. **Supabase custom JWT claim** for the active `workspace_id` — set via a Supabase Auth hook / your login flow, and updated when a user switches workspace.

---

## 6. Data model (PostgreSQL / Supabase)

UUID PKs, `timestamptz`, `citext` emails. **Enable RLS on every tenant-scoped table** with policy `workspace_id = (auth.jwt() ->> 'workspace_id')::uuid`. Index tenant tables with `workspace_id` as the leading column.

```sql
-- Tenancy core
CREATE TABLE workspaces (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'onboarding', -- onboarding|active|suspended
  sending_identity jsonb NOT NULL DEFAULT '{}',        -- {from_domain, ses_identity, dkim_tokens, dmarc_status, config_set, verified}
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Many-to-many: a user may belong to multiple workspaces (switcher in the UI)
CREATE TABLE workspace_users (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id      uuid NOT NULL,                        -- Supabase auth user id
  role         text NOT NULL DEFAULT 'marketer',     -- owner|marketer|accounting
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Platform operators (cross-tenant). NOT workspace-scoped. See §3A.
CREATE TABLE platform_admins (
  user_id    uuid PRIMARY KEY,                       -- Supabase auth user id
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log for cross-tenant (system-admin) access
CREATE TABLE admin_audit_log (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL,
  workspace_id uuid,                                 -- which workspace was accessed (if any)
  action       text NOT NULL,
  detail       jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- Maps an API Gateway usage-plan key to a workspace (for ingest attribution)
CREATE TABLE workspace_api_keys (
  api_key_id   text PRIMARY KEY,                     -- API Gateway key id
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Identity (system of record)
CREATE TABLE profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  external_id   text,
  email         citext,
  email_status  text NOT NULL DEFAULT 'active',
  attributes    jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_id)
);
CREATE INDEX ON profiles (workspace_id, email);
CREATE INDEX ON profiles USING gin (attributes);

CREATE TABLE events (
  event_id     uuid PRIMARY KEY,                     -- producer-supplied; dedupe key
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  type         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON events (workspace_id, profile_id, occurred_at);

CREATE TABLE profile_features (
  profile_id         uuid PRIMARY KEY REFERENCES profiles(id),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  total_events       int NOT NULL DEFAULT 0,
  last_event_at      timestamptz,
  last_email_open_at timestamptz,
  counters           jsonb NOT NULL DEFAULT '{}',
  monetary_total     numeric NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  definition   jsonb,                                 -- rule AST for dynamic kinds; null for manual
  kind         text NOT NULL DEFAULT 'dynamic_realtime', -- dynamic_realtime|dynamic_batch|manual
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Works for both kinds: dynamic kinds are written by the evaluator; manual kind is
-- edited directly by the user (hand-pick / CSV import). source distinguishes them.
CREATE TABLE segment_memberships (
  segment_id   uuid NOT NULL REFERENCES segments(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source       text NOT NULL DEFAULT 'evaluator',     -- evaluator|manual
  entered_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, profile_id)
);

CREATE TABLE segment_change_log (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  segment_id   uuid NOT NULL REFERENCES segments(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  action       text NOT NULL,                        -- entered|exited
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- Campaign = a multi-step workflow (graph of nodes). See §9B.
CREATE TABLE campaigns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  name               text NOT NULL,
  definition         jsonb NOT NULL,                  -- workflow graph: nodes [trigger|wait|condition|action|exit] + edges
  trigger_segment_id uuid REFERENCES segments(id),    -- enrollment trigger (segment entry); other triggers live in definition
  frequency_cap_per_days int,
  quiet_hours        jsonb,
  status             text NOT NULL DEFAULT 'draft',   -- draft|active|paused|archived
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Per-profile journey state (the "waits" + position live here). See §9B.
CREATE TABLE campaign_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  current_node text NOT NULL,
  status       text NOT NULL DEFAULT 'active',        -- active|completed|exited|failed
  next_run_at  timestamptz,                           -- when the current wait/step is due
  state        jsonb NOT NULL DEFAULT '{}',
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, profile_id)                    -- one active enrollment per profile (re-enrollment policy TBD per phase)
);
CREATE INDEX ON campaign_enrollments (status, next_run_at);  -- the runner's sweep query

-- Broadcast = a single email sent once to a segment or manual group. See §9A.
CREATE TABLE broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  template_id   uuid REFERENCES email_templates(id),
  audience_kind text NOT NULL,                         -- segment|manual_group
  audience_ref  uuid NOT NULL,                         -- segment_id (segment or manual segment)
  scheduled_at  timestamptz,                           -- null = send now
  status        text NOT NULL DEFAULT 'draft',         -- draft|scheduled|sending|sent|cancelled
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE TABLE email_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  mjml          text NOT NULL,
  compiled_html text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  campaign_id  uuid REFERENCES campaigns(id),
  template_id  uuid REFERENCES email_templates(id),
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'pending',
  attempts     int NOT NULL DEFAULT 0,
  payload      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX ON outbox (status, created_at);

CREATE TABLE messages_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  profile_id     uuid NOT NULL REFERENCES profiles(id),
  campaign_id    uuid REFERENCES campaigns(id),
  ses_message_id text,
  status         text NOT NULL DEFAULT 'sent',
  sent_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages_log (workspace_id, sent_at);
CREATE INDEX ON messages_log (workspace_id, profile_id, sent_at);

-- Suppression list, scoped per workspace (an unsubscribe is relative to the sender)
CREATE TABLE suppressions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email        citext NOT NULL,
  reason       text NOT NULL,                        -- hard_bounce|complaint|unsubscribe|manual
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);
-- Optional global hard-bounce list for invalid mailboxes (cross-workspace):
CREATE TABLE global_hard_bounces (
  email      citext PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_events (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  ses_message_id text,
  profile_id     uuid REFERENCES profiles(id),
  type           text NOT NULL,                      -- delivery|bounce|complaint|open|click
  sub_type       text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  raw            jsonb
);
CREATE INDEX ON email_events (workspace_id, occurred_at);

-- Usage metering for per-workspace cost attribution (§20)
CREATE TABLE usage_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  period       date NOT NULL,                        -- month bucket (first day)
  metric       text NOT NULL,                        -- emails_sent|events_ingested|image_storage_bytes|image_egress_bytes
  value        numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period, metric)
);
```

---

## 7. Event ingestion, tenancy & ordering

### Event envelope (producers send)
```json
{
  "event_id": "uuid",          // REQUIRED, idempotency key
  "external_id": "string",     // REQUIRED, the company's own customer id
  "type": "profile_created | progress | purchase | ...",
  "occurred_at": "ISO-8601",
  "attributes": { }
}
```
> The workspace is **not** in the payload — it's derived from the **API key** (so a company can't spoof another's workspace).

### Producer rules (source-side queue)
- Authenticate with the workspace's **API key** (issued via API Gateway usage plan).
- Send **strictly sequentially per `external_id`**; retry with backoff until `2xx`; reuse `event_id` across retries.

### API Gateway REST (ingest)
- **Per-workspace API key + usage plan** → identifies the workspace and provides per-tenant rate limiting/throttling.
- **Request validator** (JSON-schema model) rejects malformed payloads at the gateway.
- **WAF** on the stage for abuse protection.

### Ingest Lambda
- Resolve `workspace_id` from the API key (via `workspace_api_keys`; the key id is in the request context).
- Resolve/Upsert the internal `profile_id` from `(workspace_id, external_id)`.
- Send to SQS FIFO: `MessageGroupId = profile_id`, `MessageDeduplicationId = event_id`, body carries `workspace_id`.
- Return `200` only after SQS accepts (durable boundary).
- Increment `usage_counters` (`events_ingested`) — or derive later from `events`.

### Processor Lambda (FIFO, idempotent) — **always scope by `workspace_id`**
1. `INSERT events ... ON CONFLICT (event_id) DO NOTHING`.
2. Upsert profile by `(workspace_id, external_id)` (creates a stub if a `progress` arrives first).
3. Update `profile_features` (scoped).
4. Re-evaluate the profile's **workspace's** active segments; diff vs memberships.
5. On change: update memberships, append `segment_change_log`. Segment entry then drives **campaign enrollment** (§9B) and is available to **broadcasts** (§9A); a campaign `action` produces the actual `outbox` send.
6. Ack on success; repeated failures → **DLQ**.

> Ordering is per profile (`MessageGroupId = profile_id`); different profiles/workspaces process in parallel. `workspace_id` is a scoping attribute, not the ordering key.

---

## 8. Segmentation engine (per workspace)

PostgreSQL queries; **every query filters by `workspace_id`**, and the SQL compiler injects it as a mandatory predicate (RLS is the backstop for user-context reads).

### Rule AST (`segments.definition`)
```json
{ "op": "and", "conditions": [
  { "field": "features.counters.purchase_30d", "operator": ">=", "value": 3 },
  { "op": "not", "conditions": [ { "field": "features.counters.open_7d", "operator": ">", "value": 0 } ] },
  { "field": "attributes.country", "operator": "in", "value": ["IL","US"] }
] }
```
- Compile to a **parameterized SQL `WHERE`** over `profiles JOIN profile_features` **with `workspace_id = $ws`** always prepended. **Whitelist** fields/operators; never interpolate raw input.

- **Dynamic realtime** (`kind=dynamic_realtime`): evaluated by the Processor on each profile change.
- **Dynamic batch** (`kind=dynamic_batch`): an EventBridge-scheduled Lambda evaluates time-based segments per workspace periodically; diff + emit enter/exit.
- **Manual** (`kind=manual`): no evaluation — membership rows in `segment_memberships` (`source='manual'`) are added/removed directly by the user (hand-pick or CSV import). Used as audiences for broadcasts/campaigns just like dynamic segments.

---

## 9. Dispatch core (shared by broadcasts & campaigns, per workspace)

Both broadcasts (§9A) and campaign actions (§9B) emit sends the same way: insert a `pending` `outbox` row (with `workspace_id`, `dedupe_key`) and enqueue its id onto a **second SQS queue** that triggers the Dispatcher (event-driven, near-real-time).

- **Dispatcher Lambda** (SQS-triggered):
  1. Load profile + template (scoped to workspace); refuse if workspace not `active`/verified.
  2. **Check `suppressions` for `(workspace_id, email)`** — skip if suppressed; also skip if in `global_hard_bounces`.
  3. **Frequency cap** (per workspace via `messages_log`).
  4. **Quiet hours** (defer/re-queue).
  5. Render template + inject `List-Unsubscribe` / `List-Unsubscribe-Post`.
  6. `SES SendEmail` with the **workspace's Configuration Set / sending identity** (§10), routed via shared pool or the workspace's dedicated IP.
  7. Success → `messages_log` (+ `usage_counters` `emails_sent`). Failure → bounded retries → DLQ.

---

## 9A. Broadcasts (one-off send)

A single email to a segment or manual group.
- A **Broadcast Lambda** (triggered on send / at `scheduled_at` via EventBridge) **resolves the audience** at send time: read `segment_memberships` for the target segment (dynamic or manual). Snapshot the member set so the send is well-defined.
- Enumerate in **batches** (paginate; large audiences enqueued in chunks) → insert `outbox` rows → the Dispatcher (§9) handles per-recipient suppression/cap/quiet-hours and sending.
- Update `broadcasts.status` (`sending` → `sent`); record per-recipient sends in `messages_log`.
- Idempotent `dedupe_key` per `(broadcast_id, profile_id)` prevents double-sends on retry.

---

## 9B. Campaigns (multi-step workflow engine)

A campaign is a **durable per-profile state machine**: a graph of nodes — `trigger`, `wait`, `condition` (branch), `action` (e.g. send email, update attribute), `exit` — stored in `campaigns.definition`. (Exact node DSL defined in this phase.)

- **Engine choice:** a **table-driven state machine** (recommended at this scale/cost) over `campaign_enrollments`, advanced by a scheduled **Campaign-runner Lambda**. *(AWS Step Functions is the alternative but is costlier for long, multi-day waits and high enrollment counts — table-driven is the standard for marketing journeys.)*
- **Enrollment:** a trigger (segment entry via `segment_change_log`, an event, or manual) inserts a `campaign_enrollments` row at the start node.
- **Advancing (the "waits"):** the runner sweeps `WHERE status='active' AND next_run_at <= now()` (EventBridge every ~minute) and processes the current node:
  - `wait` → set `next_run_at = now() + delay` (or until a date/condition), stay.
  - `condition`/branch → evaluate against profile/features/segment membership (reuse the §8 compiler), pick the next node, process immediately.
  - `action` (send) → insert `outbox` row → Dispatcher (§9); advance.
  - `exit` → `status='completed'`.
- **Guards:** all sends still pass through Dispatcher suppression/cap/quiet-hours. Enrollments are workspace-scoped and idempotent (the runner must tolerate retries without double-advancing — use `updated_at`/optimistic checks).
- Re-enrollment policy (can a profile re-enter?) is defined per phase.

---

## 10. Email (SES) in a multi-tenant world

### Sending identity — each workspace uses its own verified domain (from the start)
- **Every workspace must verify and send from its own domain** before it can send. No shared default sender. Stored in `workspaces.sending_identity` (`from_domain`, `ses_identity`, `dkim_tokens`, `dmarc_status`, `verified`).
- **Gated onboarding flow:**
  1. Workspace created → `status='onboarding'`, sending **disabled**.
  2. Admin enters their sending domain → backend creates an **SES domain identity** + **Easy DKIM**, returns the **DNS records** (DKIM CNAMEs, SPF TXT, recommended DMARC TXT) for them to publish.
  3. A verification check (poll SES identity status) confirms DKIM verified + records present.
  4. On success → create the workspace's **dedicated Configuration Set**, set `verified=true`, move `status='active'`. The Dispatcher refuses to send for any workspace not `active`/verified.
- **Why required up front:** sending from each company's own domain gives proper DMARC alignment, branding, and — critically — **per-domain reputation separation** (a key part of multi-tenant deliverability). Note: domain reputation separates by this; **IP reputation is still shared** until a workspace gets its own dedicated IP pool (below).

### Engagement tracking
- **Open and click tracking are enabled** (via the workspace Configuration Set) — required for engagement segments like "no email opened in 7 days." Events flow to `email_events`.
- **Caveat:** Apple Mail Privacy Protection auto-loads tracking pixels, inflating "opens." Treat opens as a *soft* signal; prefer clicks for high-confidence engagement.

### IP strategy: shared by default, dedicated on recommendation
- **Default = SES shared IP pool** (AWS-managed, no extra cost). Best deliverability for low/moderate volume, since a workspace won't have enough traffic to warm/maintain a dedicated IP early on. Each workspace still sends from **its own verified domain**, so **domain reputation is per-workspace from day one**; only the IP is shared initially.
- **Opt-in upgrade to a dedicated IP** (standard, own pool, routed by the workspace's Configuration Set) when a workspace's volume/pattern justifies it — giving that workspace full IP-reputation isolation. ~$24.95/mo, a per-workspace direct cost (§20).
- **Migration (no cold cutover):** on upgrade, provision the dedicated IP and **warm it gradually (~2–4 weeks)** by routing an increasing share of the workspace's sends to the new IP while the rest continues via the shared pool; cut over fully once warm. Track `warmup_status` per workspace.

### Dedicated-IP recommendation engine
A scheduled **IP-advisor job** (EventBridge, monthly) evaluates each workspace from existing data and flags a recommendation in the UI when **all** hold:
- **Sustained volume:** ≥ ~100k emails/month for **2–3 consecutive months** (enough to keep an IP warm; one-off spikes don't count).
- **Consistent cadence:** sends on most days, not a single monthly blast (a dedicated IP needs regular traffic per ISP to hold reputation).
- **Healthy reputation:** low bounce/complaint (don't move a problematic sender onto a dedicated IP).

The recommendation surfaces in **workspace settings** with the rationale and the trade-off (+$24.95/mo, ~2–4 week warm-up, in exchange for IP-reputation isolation and control). The workspace owner triggers the migration; it is never automatic. Inputs come from `usage_counters` (volume/cadence) and `email_events` (reputation).

### Reputation isolation (and its limits)
- **On the shared pool**, IP reputation is shared across workspaces, so **per-workspace policing is the primary protection** (below). **Domain reputation is already isolated** per workspace via per-workspace domains.
- **After a dedicated-IP upgrade**, that workspace's IP reputation is isolated too.
- **The SES *account* is shared regardless** — AWS can review/pause the whole account on aggregate bounce/complaint. So keep these guards always:
  - **Per-workspace bounce/complaint metrics + alarms** (from `email_events`).
  - **Per-workspace quotas/throttles** and **auto-suspend a single workspace** (`workspaces.status='suspended'`) on threshold breach — stop the offender to protect the shared account, not everyone.
  - List hygiene + double opt-in per workspace.
  - (Full account-level isolation would need a separate AWS account per tenant — out of scope; §22.)

### Feedback pipeline
- Configuration Set → event publishing → **SNS** → **Feedback Lambda** (resolve workspace from the message/identity):
  - **Hard bounce** → `suppressions (workspace_id, email, 'hard_bounce')`, set `email_status='bounced'`; also add to `global_hard_bounces`.
  - **Complaint** → `suppressions (workspace_id, email, 'complaint')`, `email_status='complained'`.
  - **Soft bounce** → count; suppress after N.
  - Record in `email_events` (with `workspace_id`).
- Enable the SES **account-level suppression list** as a backstop for hard bounces/complaints.

### One-click unsubscribe
- **Unsubscribe Lambda** writes `suppressions (workspace_id, email, 'unsubscribe')` — scoped, so unsubscribing from Company A does not affect Company B.

### Monitoring
- CloudWatch alarms on account-wide `Reputation.BounceRate` (≥3% warn, ≥5% critical; SES pauses ~10%) and `Reputation.ComplaintRate` (≥0.1%; pause ~0.5%) **plus** per-workspace computed rates from `email_events`. Google Postmaster Tools per sending domain.

---

## 10A. Guided onboarding & domain verification wizard

A self-serve wizard that walks a new workspace through sending-domain setup and **validates the published DNS records live**, so "own domain from the start" is self-service rather than a support ticket. Drives the §10 gated flow.

### Wizard steps (UI)
1. **Enter sending domain** (e.g. `mail.theircompany.com`). Backend (Onboarding Lambda) calls SES to create the **domain identity + Easy DKIM** and a (recommended) **custom MAIL FROM** subdomain; SES returns the records to publish.
2. **Show records to publish**, each as a copy-paste row with name/type/value and a live status badge:
   - 3 × **DKIM CNAME** (SES Easy DKIM)
   - **SPF** TXT (includes `amazonses.com`)
   - **MAIL FROM** records (MX + SPF on the subdomain) for full SPF/DMARC alignment
   - **DMARC** TXT — start `v=DMARC1; p=none; rua=...`, with guidance to tighten to `quarantine`/`reject` later
3. **Live validation** — a "Check now" action (and light polling) runs DNS lookups and re-reads SES status; each record flips pending → found → mismatch with a clear fix hint. Greens appear as DNS propagates.
4. **Activate** — when SES reports DKIM **verified** and required records resolve: create the workspace's **Configuration Set** routing to the **shared IP pool** (default), then flip `workspaces.status` to `active` and enable sending. (A dedicated IP is a later, recommended upgrade — §10 — not part of onboarding.) Until verified, the Dispatcher refuses to send.

### How validation actually works (important)
- **You do not access their registrar.** That's neither possible nor desirable. The wizard validates two ways:
  - **SES verification status is the gate.** Poll SES (`GetIdentityVerificationAttributes` / DKIM attributes) — this is the source of truth for "can I send" and what flips the workspace to `active`.
  - **Live public DNS lookups power the per-record UX.** A Lambda queries `TXT`/`CNAME`/`MX` to show green checks before SES catches up and to validate SPF/DMARC (which SES doesn't verify). Use a resolver with low/no caching or query the domain's authoritative nameservers directly, so a stale cache doesn't show false negatives. SES status remains the definitive gate.
- Tell users plainly: the wizard checks their **published DNS** and **SES's status**, not their registrar account.

### Optional enhancement (not v1-blocking)
- **Registrar/DNS-host detection:** an `NS` lookup on the domain can identify the DNS host (Cloudflare, GoDaddy, Route 53, …) so the wizard can show tailored "where to paste this" instructions. Nice polish; ship the generic copy-paste wizard first and add provider hints later.

### Drift detection
- A scheduled re-check (reuse the EventBridge batch schedule) re-validates each active workspace's DKIM/SPF periodically and **warns** (and can auto-pause) if records are later removed — catching breakage before sends start failing.

### State & components
- Track per-step / per-record progress in the workspace record (extend `workspaces.sending_identity` jsonb: `{from_domain, ses_identity, dkim_tokens, mail_from, dmarc_status, record_checks, verified, config_set, ip_mode, dedicated_ip, ip_pool, warmup_status, ip_recommendation}`) — `ip_mode` defaults to `shared`; no new table needed.
- **Onboarding Lambda** + admin API endpoints: `start-domain` (create SES identity, return records), `check-domain` (run DNS + SES status, return per-record state), `activate` (gate + create Configuration Set on the **shared pool** + set `active`). A separate **`upgrade-ip`** endpoint handles the later dedicated-IP migration (§10).
- Frontend: a stepper UI in `/web` with copy buttons and live status badges.

---

## 11. WYSIWYG email editor & image pipeline

- **Core GrapesJS (BSD-3, free) + MJML plugin**, client-side. Emits MJML; a **Template Lambda** compiles MJML→HTML (`mjml`, MIT) at save time and stores both in `email_templates` (per workspace).
- **Images:** editor requests a **presigned S3 PUT URL** (Image Lambda) → browser uploads to **S3 under a `workspace_id/` key prefix** → S3-triggered Lambda makes `sharp` variants → served via **CloudFront**. Record bytes in `usage_counters` for cost attribution.
- Custom editor UI is fine, but it must **output MJML, not hand-rolled email HTML** (cross-client correctness lives in MJML). Spot-check each new template design in real clients (Outlook + Gmail) before large sends; a paid Litmus/Email-on-Acid pass is optional at this scale.
- The paid GrapesJS **Studio SDK** and **MJML App** are not used.

---

## 12. Frontend admin app (React/Preact)

Vite SPA on **S3 + CloudFront**. **Role-aware** (§3A): the UI shows only what the user's role permits, and is scoped to the active workspace.

- **Auth** (Supabase Auth). After login, resolve workspace memberships + role(s); a **workspace switcher** sets the active `workspace_id` claim. Switching re-issues the claim and re-scopes the app.
- **Workspace onboarding** — domain entry → SES DKIM/SPF/DMARC records → verification status (can't send until verified, §10A).
- **Workspace settings** (owner) — members + roles, sending domain status + dedicated-IP recommendation/upgrade (§10).
- **Segments** — builder for **dynamic** (rule AST) and **manual** (hand-pick + CSV import) segments, with live size preview (marketer+).
- **Broadcasts** (marketer+) — pick audience (segment/manual) + template → schedule/send (§9A).
- **Campaigns** (marketer+) — visual **workflow builder** (trigger / wait / condition / action / exit) (§9B).
- **Email editor** (GrapesJS+MJML), **dashboards** (deliverability, segment sizes, send volume), **suppression list**, **profile explorer**.
- **Billing/usage view** (owner + accounting) — per-workspace cost (§20).
- **System-admin console** (system-admin only) — cross-company list of workspaces, status, support views; all access written to `admin_audit_log`.
- **API:** **API Gateway REST** → API Lambdas. The **Lambda authorizer** validates the Supabase JWT, resolves workspace membership + role (or `is_platform_admin`), and injects them into the request context. API Lambdas **enforce role** and scope every query to the active `workspace_id` (system-admin excepted, audited).

---

## 13. Security, tenancy isolation & secrets

- **Tenant isolation is the top security property.** Enforced by: (1) app-level `workspace_id` filtering everywhere (mandatory in the segment SQL compiler and all queries), (2) **RLS** for user-context (admin app) connections, (3) workspace derived from **API key** at ingest (never from client payload), (4) authorizer-injected `workspace_id` for the admin API (never trust a client-sent workspace id).
- **Service-role Lambdas bypass RLS** → they must scope by `workspace_id` in code (see §3).
- **Role enforcement (§3A):** the authorizer resolves role; API Lambdas check the role's allowed capabilities per route. `system-admin` is the only cross-tenant role — its RLS exception is narrow and every access is written to `admin_audit_log`.
- Per-function **least-privilege IAM**. Secrets in **Secrets Manager**/SSM. **WAF** on the REST API.
- Whitelist segment-rule fields/operators; parameterized SQL only.

---

## 14. Infrastructure as Code (AWS CDK, TypeScript)

Define: Lambdas + IAM; **REST API** (resources, validators/models, **per-workspace usage plans + API keys**, Lambda authorizer, WAF); SQS FIFO + DLQ + mappings; SNS topics/subscriptions; S3 + CloudFront + ACM; EventBridge schedules (batch eval, soft-bounce retry, **usage rollups**); SES Configuration Set(s); CloudWatch alarms (account + per-workspace reputation, DLQ depth, Lambda errors, SQS age).

---

## 15. Local development

- **Node-on-Lambda parity** via SAM local / serverless-offline (+ LocalStack for SQS/S3/SNS/API GW). **Supabase CLI** for local Postgres + migrations + RLS testing.
- Seed multiple **workspaces** with overlapping `external_id`s and emails to test isolation; seed a `profile_created`-then-`progress` sequence for ordering.

---

## 16. Observability & operations

- Structured logs per Lambda (include `workspace_id` in every log line).
- Alarms: account + **per-workspace** bounce/complaint, DLQ > 0, Lambda errors, SQS oldest-message age.
- DLQ runbook; `/health`; synthetic end-to-end test event per workspace.

---

## 16A. Testing strategy (TDD)

Build **test-first**: for each unit of work, write a failing test, make it pass, refactor. The §18 acceptance criteria are the scenario backlog — each becomes a test before its code exists. Use a **serverless testing pyramid** (many fast unit tests, fewer DB-integration tests, a thin E2E layer) so the suite stays fast enough to run on every change.

### 1. Unit tests — the bulk (pure, fast, true red-green-refactor)
Keep each Lambda's logic in a **pure, injected function** the handler merely wires up, so logic is tested without the Lambda/AWS wrapper. Highest-value targets:
- **Segment rule-AST → SQL compiler:** given an AST, assert the exact parameterized SQL, that `workspace_id` is *always* injected, and that unknown fields/operators are rejected (security-critical).
- Feature/aggregate updates, frequency-cap logic, quiet-hours, suppression decisioning, bounce/complaint classification, and the **cost-allocation math** (direct usage + even-split of fixed costs; figures sum to the true total).

### 2. Integration tests — against real Postgres (do NOT mock the DB)
The ordering, idempotency, and isolation guarantees live in the database, so mocking it tests nothing real. Run against a **local Supabase/Postgres** (Supabase CLI or Testcontainers). Assert:
- `profile_created`→`progress` **and** `progress`-first both converge correctly.
- Same `event_id` twice → applied once.
- **Tenant isolation:** a Workspace-A JWT can't read Workspace-B rows under **RLS**, *and* service-role code paths (which bypass RLS) still scope by `workspace_id` in code.
- Per-workspace suppression scoping.
- Onboarding `check-domain` logic against mocked DNS/SES responses.

### 3. End-to-end tests — thin layer (LocalStack)
A *few* happy-path flows (SQS FIFO → Processor → outbox; SES feedback → suppression) via LocalStack — to catch wiring mistakes, not logic. Keep minimal; they're slow.

### What to mock vs. not
- **Mock** SES (assert `SendEmail` is called with the right Configuration Set and only after suppression/cap checks — never send real mail) and outbound HTTP.
- **Don't mock** Postgres in the integration tier — the bugs you care about are in the SQL and RLS.

### Stack-specific cautions
- **FIFO ordering is SQS's guarantee, not your code's** — don't unit-test "the queue delivered in order." Unit-test your code's **idempotency/convergence** (so order-independence holds) and verify real ordering once at the integration/E2E level.
- Prefer invoking handlers directly with a **synthetic SQS event** (fast, deterministic) over round-tripping a real queue, except in the few E2E tests.

### Tooling & CI
- **Vitest or Jest** (TypeScript); **Supabase CLI / Testcontainers** for ephemeral Postgres; **`aws-sdk-client-mock`** for AWS SDK; **LocalStack** for the slim E2E tier.
- Run the suite in **CI as a merge gate**. Optimize for *scenario* coverage (every §18 criterion backed by a test) over a raw coverage %, while keeping high line-coverage on the pure logic (compiler, capping, cost math).

---

## 17. Build order (phase by phase; verify each)

> **Work test-first throughout:** for each phase, write that phase's §18 criteria as failing tests *before* the implementation (§16A). A phase is "done" only when its tests are green in CI.

2. **Auth + authorizer + roles** — Supabase Auth, **multi-workspace membership + switcher**, active-`workspace_id` JWT claim, Lambda authorizer, **4-role model** (system-admin via `platform_admins` + `is_platform_admin` claim; owner/marketer/accounting per workspace), RLS + system-admin exception + `admin_audit_log`.
3. **Ingestion + tenancy + ordering** — REST API per-workspace keys → Ingest Lambda (workspace from key) → SQS FIFO + DLQ → Processor (workspace-scoped, idempotent upsert, dedupe). *Verify ordering + isolation tests (§18).*
4. **Profiles + features** (workspace-scoped).
5. **Segmentation** — AST + SQL compiler (mandatory `workspace_id`), dynamic realtime + batch eval, membership diff/log, **manual segments** (hand-pick + CSV import).
6. **Email infrastructure + guided domain onboarding (§10A)** — SES domain identity + Easy DKIM + MAIL FROM per workspace, **Onboarding Lambda** (start/check/activate) with live DNS + SES-status validation, per-workspace Configuration Set on the **shared IP pool** (default), open/click tracking, sends gated on `verified`/`active`, MJML compile.
7. **Dispatch core** (§9) — outbox + **second SQS queue → SQS-triggered Dispatcher**, per-workspace suppression + cap + quiet hours, messages_log.
8. **Feedback + compliance + reputation policing** — SNS → Feedback Lambda → per-workspace suppression + status; per-workspace reputation alarms + auto-suspend; Unsubscribe Lambda.
9. **Broadcasts** (§9A) — audience resolution (segment/manual), batched enumeration → outbox, scheduling, status tracking.
10. **Campaign workflow engine** (§9B) — `campaigns.definition` + `campaign_enrollments`, Campaign-runner sweep, node types (trigger/wait/condition/action/exit), enrollment via segment entry.
11. **Image pipeline + WYSIWYG** — presigned upload (workspace-prefixed), sharp, CloudFront, GrapesJS+MJML editor.
12. **Admin frontend** — role-aware, workspace-scoped UI: members/roles, segment builder (dynamic + manual), broadcast composer, campaign/workflow builder, dashboards; **system-admin cross-company console**.
13. **Usage metering + cost attribution + IP advisor** (§20, §10) — counters + rollup job + per-workspace cost view (accounting role); monthly **IP-advisor** recommendations; **`upgrade-ip`** migration flow.
14. **Hardening** — DLQ runbook, WAF, isolation pen-test (incl. system-admin audit), load test, acceptance tests.

---

## 18. Acceptance criteria (testable)

- **Tenant isolation:** a user in Workspace A cannot read/modify any Workspace B data via the admin API (authorizer + RLS); two workspaces with the same `external_id`/email keep fully separate profiles; an API key for Workspace A can only create events in Workspace A.
- **Ordering:** `profile_created` then immediately `progress` (same `external_id`, same workspace) → profile exists, progress applied, in order; `progress`-first → idempotent upsert still correct.
- **No loss:** forced Processor failures → retried then processed or DLQ; none vanish.
- **Idempotency:** repeated `event_id` applied once.
- **Segmentation:** crossing a predicate → exactly one `entered`; back → one `exited`; never matches another workspace's profiles.
- **Suppression scoping:** unsubscribe in Workspace A does not suppress the same email in Workspace B; a hard bounce suppresses in-workspace (and is recorded globally).
- **Reputation policing:** a workspace exceeding bounce/complaint thresholds is auto-suspended without pausing other workspaces.
- **IP strategy:** workspaces send on the **shared pool by default**; the **IP-advisor recommends** a dedicated IP only when sustained-volume + cadence + reputation criteria are met; the **`upgrade-ip`** flow provisions a dedicated IP/pool, warms it gradually (split routing), and cuts over — with `ip_mode`/`warmup_status` tracked per workspace.
- **Sending gated on verification:** a workspace whose domain isn't verified (`status != active`) cannot send; once DKIM verifies, sending is enabled from its own domain with aligned DKIM/SPF/DMARC.
- **Multi-workspace switching:** a user in two workspaces sees only the active workspace's data; switching changes the `workspace_id` claim and re-scopes all reads/writes; no cross-bleed.
- **Roles (§3A):** marketer cannot manage users/domains/billing; accounting can read billing but cannot edit segments/campaigns; owner can do both within the workspace; **system-admin** can view across companies and every cross-tenant access is recorded in `admin_audit_log`.
- **Segments:** dynamic segments auto-update on events/attributes; **manual** segments change only via user edit/CSV and are not touched by the evaluator; both are usable as audiences.
- **Broadcasts:** a broadcast to a segment/manual group sends once to the resolved audience, each recipient passing suppression/cap/quiet-hours; retries don't double-send (dedupe per `(broadcast_id, profile_id)`).
- **Campaigns:** an enrolled profile advances through trigger→wait→condition→action→exit; a `wait` defers until `next_run_at`; a branch routes correctly; the runner is idempotent (no double-advance on retry); sends pass through Dispatcher guards.
- **Frequency cap / quiet hours / compliance** (one-click unsubscribe) hold.
- **Cost attribution:** per-workspace `emails_sent`/`events_ingested` reconcile with `messages_log`/`events`; the cost view = direct usage cost + an equal share of fixed costs, and per-workspace figures sum to the true total.

---

## 19. Suggested repository structure

```
/infra                 # CDK — all resources, per-workspace usage plans, RLS-aware setup
/services
  /ingest              # workspace-from-API-key → SQS
  /processor           # FIFO consumer: profiles, features, segments, outbox (workspace-scoped)
  /dispatcher          # outbox → SES (per-workspace suppression/identity)
  /broadcast           # one-off send: resolve audience (segment/manual) → outbox (§9A)
  /campaign-runner     # workflow engine: enroll + sweep enrollments + advance nodes (§9B)
  /feedback            # SNS → per-workspace suppression/status + reputation
  /unsubscribe         # one-click unsubscribe (workspace-scoped)
  /image               # presigned upload (workspace-prefixed) + sharp
  /onboarding          # domain verification wizard: start/check/activate (DNS + SES status)
  /batch-eval          # scheduled batch segment eval + DKIM drift re-check
  /metering            # usage rollups + cost attribution + IP-advisor
  /api                 # admin CRUD/read API (workspace-scoped, role-enforced)
  /authorizer          # Lambda authorizer: validate Supabase JWT + resolve workspace + role
/packages
  /shared              # types, env/config, logging (workspace-aware)
  /db                  # schema, migrations, RLS policies, pooled client
  /segments            # rule AST + SQL compiler (mandatory workspace_id)
  /email               # SES client, MJML compile, header builders
  /tenancy             # workspace context helpers, role checks
/web                   # Preact/React SPA (workspace-scoped), GrapesJS + MJML, onboarding wizard UI
/scripts               # seed multi-workspace data, ordering/isolation tests, DLQ replay
/tests                 # unit + integration (real Postgres) + thin E2E (LocalStack); colocated *.test.ts also allowed
```

---

## 20. Cost attribution per workspace

**The principle:** AWS bills you the *total* for shared infrastructure; it cannot break the bill down per tenant in a pooled model. You attribute cost by **metering usage yourself** and applying unit prices.

### What to meter (into `usage_counters`, monthly bucket)
- **`emails_sent`** — the dominant variable cost; derive from `messages_log`. × $0.10/1k.
- **`dedicated_ip`** — $24.95/mo, **only for workspaces upgraded to a dedicated IP** (default shared pool = $0).
- **`events_ingested`** — from `events`/ingest counter.
- **`image_storage_bytes`, `image_egress_bytes`** — per `workspace_id/` S3 prefix + CloudFront logs.
- (Lambda/SQS compute is negligible — fold into a small flat per-workspace overhead.)

### Cost model (a scheduled `metering` job computes per-workspace monthly cost) — **hybrid policy**
- **Direct/variable costs → attributed to the workspace:** `emails_sent × $0.0001`, **its dedicated IP $24.95 if upgraded**, plus image storage/egress by its bytes.
- **Fixed costs → split evenly across active workspaces:** Supabase base (~$30) + baseline compute (~$5–15). Each active workspace pays `fixed_total / active_workspace_count`.
- Per-workspace monthly cost = direct (email + IP-if-upgraded + images) **+** equal share of the fixed pool.
- *Worked example:* fixed ≈ $40/mo; with 5 active workspaces that's $8 each. A small workspace on the **shared pool** sending 10k emails: `$1 + $0 IP + $8 ≈ **$9**`. A large workspace **upgraded** to a dedicated IP sending 300k: `$30 + $24.95 IP + $8 ≈ **$63**`. The shared-default keeps small tenants cheap; the IP cost only lands where it's earned.

### Whole-system cost (shared default keeps the baseline low)
| Layer | Today | 5-year |
|---|---|---|
| Supabase (Pro + small compute) | ~$30 | ~$30 |
| AWS compute (Lambda ~free tier, REST API <$1, SQS ~free, S3 ~$1) | ~$5–15 | ~$10–25 |
| CloudFront egress | ~$5–15 | ~$15–40 |
| SES email sending (shared IP = no extra) | ~$50 | ~$250 |
| Dedicated IPs — $24.95 × **upgraded** workspaces only | $0 + $25/upgrade | $0 + $25/upgrade |
| **Total** | **~$115–135/mo** | **~$305–345/mo** |

Baseline returns to **~$115–135/mo**; each *upgraded* workspace adds $25. Email volume remains the main per-workspace driver — `emails_sent` is the primary metering metric and the trigger for the dedicated-IP recommendation (§10).

---

## 21. How to drive Claude Code through this

- Work **test-first** (§16A): for each phase, write its §18 criteria as failing tests, then implement to green — red → refactor, one criterion at a time. Don't mock Postgres in the integration tier; mock SES.
- Work **phase by phase** (§17); verify each against §18 before continuing — **isolation tests are pass/fail gates**, not optional.
- Build **tenancy first** (workspaces, `workspace_id` everywhere, RLS, authorizer) before features, so nothing has to be retrofitted.
- Keep **prerequisites** (§5) ready; Claude Code can't create accounts, approve SES, or add DNS records.
- Every Lambda handler: **idempotent, stateless, workspace-scoped**, with logic in a pure injected function for unit-testing.

---

## 22. Resolved decisions & remaining minor items

**Resolved (v4):** multi-workspace users (switcher) ✓ · own verified sending domain per workspace from the start ✓ · hybrid cost attribution (direct by usage + fixed split evenly) ✓ · event-driven SQS dispatch ✓ · open/click tracking enabled ✓ · standard SES warm-up ramp ✓.
**Added (v5):** guided onboarding & domain-verification wizard (§10A) ✓ · TDD testing strategy (§16A), test-first build ✓.
**Changed (v6→v7):** **shared IP by default with an opt-in dedicated-IP upgrade the system recommends** (volume + cadence + reputation criteria), replacing unconditional per-workspace IPs — best deliverability for small tenants, IP cost only where earned ✓.

**Added (v8):** **4-role model** (system-admin cross-tenant + owner/marketer/accounting per workspace, §3A) ✓ · **core features** scoped — **segments** (dynamic + manual), **broadcasts** (§9A), **campaigns** as a multi-step **workflow engine** (§9B) ✓.

**Remaining (minor / to define in-phase):**
1. **Campaign node DSL & re-enrollment policy** — exact workflow node types/options and whether a profile can re-enter a campaign — defined in the §9B phase.
2. **IP-recommendation thresholds** — tunable defaults (≥~100k/mo, cadence, reputation ceiling); confirm against observed deliverability.
3. **Account-level isolation** — shared SES *account* couples workspaces regardless of IP; full isolation needs a separate AWS account per tenant (heavy). Per-workspace policing is the guard.
4. **GrapesJS → Unlayer fallback** — only if core GrapesJS integration runs long.
5. **Apple Mail Privacy Protection** — how heavily to weight "opens" given inflation (prefer clicks).
