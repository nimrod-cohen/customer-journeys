# Phone as a core identity field (2026-07-17)

## Goal

Profiles can be identified by **email and/or phone**. Both are **core, reserved** fields
(not dynamic attributes). Each alone is optional; **at least one is required**. Phones are
**normalized to E.164** so `+972541111111` == `054-1111111` (IL). Extends the email-only
identity model (`UNIQUE(workspace_id, email)`).

## Decisions (confirmed)

1. **Identity conflict** — *prefer email, don't steal the phone*: a record with both keys is
   identified by its email (match/create by email); the phone is attached ONLY if free (not
   already on another profile) — never auto-merge, never move a phone off another profile.
2. **Default country** — a per-workspace setting `default_phone_country` (ISO-2) normalizes
   national numbers on write.
3. **Bad phone** — reject the phone; if the record also has a valid email, keep the record
   and just drop the phone (only a phone-only record with an un-normalizable number is
   rejected outright).
4. **Backfill + remove** `attributes.phone`, BUT `attributes.email`/`attributes.phone` must
   still RESOLVE (they are core fields, just not dynamic) — the resolver aliases them.

## Model

- `profiles.phone text` (E.164, nullable). Partial `UNIQUE(workspace_id, phone) WHERE phone
  IS NOT NULL`. `email` becomes optional. `CHECK (email IS NOT NULL OR phone IS NOT NULL)`.
- **Reserved fields** (`@cdp/shared` customer.ts): add `phone`. The `customer.*` resolver +
  `customerMerge` treat `email`, `phone`, and their `attributes.email`/`attributes.phone`
  spellings as the CORE columns (so `{{customer.phone}}`, `{{customer.attributes.phone}}`,
  and a segment rule `customer.phone` all hit the column). Attribute editor + create/import
  reject a DYNAMIC attribute keyed `email`/`phone` (reserved).
- **Normalization** — reuse `@cdp/channels normalizePhone(raw, defaultCountry)` (E.164 or
  null). A tiny shared wrapper `normalizeIdentityPhone` centralizes it.
- **Default country** — `workspaces.settings.default_phone_country` (ISO-2, validated), read
  in the identity path + the admin UI. No column (jsonb settings, no migration).

## Identity / upsert (the heart)

One shared resolver `resolveProfileIdentity(pool, ws, { email, phone }, defaultCountry)`:
- Normalize phone (drop if invalid *and* email present; reject if invalid *and* phone-only).
- Require ≥1 key (else 400).
- If email present: upsert by `(ws, email)` (existing behavior). Then set `phone` on that
  row ONLY if phone is present AND not already owned by a different profile.
- Else (phone only): upsert by `(ws, phone)`.
- Used by: ingest `/v1/identify` + `/v1/track`, `POST /profiles`, `PATCH /profiles/:id`,
  the processor's stub upsert, and CSV import.

## Surfaces to change

- **Ingest** (`ingestTrack`/`ingestIdentify`): accept `email` and/or `phone`; ≥1 required.
- **Manual CRUD** (`createProfile`/`updateProfile`/`importProfilesCsv`): phone field +
  reserved-word guard; uniqueness → 409.
- **Segments** (`@cdp/segments` compiler): `phone` joins the whitelisted core fields.
- **Dispatcher**: `{{customer.phone}}` To for sms/whatsapp now resolves the column
  (automatic via the resolver) — the text-recipient path already reads `customer.phone`.
- **UI**: profile create/edit drawer + detail header get a Phone field; Workspace settings
  gets a Default phone country selector; the attribute editor blocks `email`/`phone` keys.
- **Delete/merge**: merge already reassigns children; extend merge-key to phone.

## Migration + backfill (0062)

- `0062`: add `phone` + partial unique index + CHECK. (No data change — every existing row
  has an email, so CHECK holds.)
- **Backfill** (JS, not SQL — needs libphonenumber + per-workspace default country):
  `POST /admin/backfill-phone` or a script — per workspace, for each profile with
  `attributes.phone`: normalize with the workspace default country; if it normalizes AND is
  free, set `profiles.phone` and DELETE `attributes.phone`; on collision/failure leave the
  attribute (logged). Idempotent. (Prod run after deploy.)

## Phasing

1. Schema + shared resolver + normalization + identity resolver + workspace setting (+ unit/integration tests).
2. Ingest + CRUD + processor + CSV wired to the resolver; segments core field; reserved-word guards.
3. UI (profile phone field, workspace default-country, attribute guard).
4. Backfill script + prod run; docs.

## Tests

- `@cdp/shared`: resolver treats phone + attributes.email/phone as core.
- `@cdp/channels`: normalizePhone already covered; add identity edge cases.
- local-api integration: identify by phone only; identify by both (don't steal phone);
  phone-only bad number → 409/400; email + bad phone → record kept, phone dropped;
  uniqueness; CSV; PATCH. Segment on customer.phone. Merge on phone.
- e2e: create a phone-only profile; edit phone; default-country setting; reserved-word block.
