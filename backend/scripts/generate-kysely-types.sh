#!/usr/bin/env bash
#
# Generate the Kysely database schema types from the migrations.
#
# The migration files in backend/src/db/migrations/ remain the system of record.
# This script does NOT change how the schema is built — it applies every migration,
# in order, to a throwaway Postgres and introspects the *resulting* schema with
# kysely-codegen to produce backend/src/shared/infra/kysely/schema.ts.
#
# It is authoritative by construction: the generated types can never silently drift
# from the migrations, because they are derived from a fresh replay of them. The
# throwaway Postgres is a container this script owns (same image as db:schema), so the
# behaviour is identical locally and in CI — the only requirement is Docker. It does
# not touch the dev database and does not need the compose stack running.
#
# Usage:
#   pnpm --dir backend run db:types          # regenerate and write schema.ts
#   pnpm --dir backend run db:types:check     # fail if the committed file is stale (CI)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/backend/src/db/migrations"
OUT_DIR="$ROOT/backend/src/shared/infra/kysely"
OUT="$OUT_DIR/schema.ts"
CODEGEN="$ROOT/backend/node_modules/.bin/kysely-codegen"

IMAGE="pgvector/pgvector:pg16"
CONTAINER="radioso-kysely-codegen-$$"
DB="radioso"

# vector/tsvector are pgvector / full-text types kysely-codegen doesn't know; the
# repositories serialize/parse them as strings (see serializeVector), so map them to
# string. numeric stays a string (driver returns BIGINT/NUMERIC as strings, matching the
# coercion the row mappers already do).
TYPE_MAPPING='{"vector":"string","tsvector":"string"}'

CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
fi

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Starting throwaway Postgres ($IMAGE) ..." >&2
docker run -d --name "$CONTAINER" -p 127.0.0.1::5432 \
  -e POSTGRES_DB="$DB" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  "$IMAGE" >/dev/null

# The official Postgres image briefly accepts connections during its init phase, then
# restarts. Wait for init to complete before trusting pg_isready (see db:schema).
ready=0
for _ in $(seq 1 90); do
  if docker logs "$CONTAINER" 2>&1 | grep -q "PostgreSQL init process complete; ready for start up." \
    && docker exec "$CONTAINER" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Throwaway Postgres did not finish initialization in time." >&2
  exit 1
fi

psql_db() {
  docker exec -i -e PGOPTIONS="-c client_min_messages=warning" \
    "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" "$@"
}

echo "Applying migrations ..." >&2
for migration in "$MIGRATIONS_DIR"/*.sql; do
  psql_db < "$migration" >/dev/null
done

HOST_PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
URL="postgresql://postgres:postgres@127.0.0.1:${HOST_PORT}/${DB}"

mkdir -p "$OUT_DIR"

run_codegen() {
  local out_target="$1"
  shift
  "$CODEGEN" \
    --url "$URL" \
    --dialect postgres \
    --type-mapping "$TYPE_MAPPING" \
    --numeric-parser string \
    --exclude-pattern schema_migrations \
    --out-file "$out_target" \
    --log-level warn "$@"
}

if [[ "$CHECK" -eq 1 ]]; then
  echo "Verifying schema.ts is up to date ..." >&2
  TMP="$(mktemp)"
  run_codegen "$TMP"
  if ! diff -u "$OUT" "$TMP"; then
    rm -f "$TMP"
    echo "" >&2
    echo "Kysely schema types are stale. Run: pnpm --dir backend run db:types" >&2
    exit 1
  fi
  rm -f "$TMP"
  echo "Kysely schema types are up to date." >&2
else
  run_codegen "$OUT"
  echo "Wrote $OUT" >&2
fi
