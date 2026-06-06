#!/usr/bin/env bash
# Start local Postgres via the Supabase CLI and apply all migrations.
# Migrations live in packages/db/supabase/migrations. See CDP-BUILD-SPEC.md §15.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_DIR="$ROOT_DIR/packages/db"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI not found. Install it: https://supabase.com/docs/guides/cli" >&2
  exit 1
fi

supabase start --workdir "$DB_DIR"
# `supabase start` applies migrations on a fresh DB; `db reset` re-applies them.
echo "Local Postgres up. Run 'pnpm db:migrate' to reset + re-apply migrations."
