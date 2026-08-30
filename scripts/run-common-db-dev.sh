#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

FRONTEND_PORT="${RADIOSO_FRONTEND_PORT:-${CONDUCTOR_PORT:-3000}}"
BACKEND_PORT="${RADIOSO_BACKEND_PORT:-$((FRONTEND_PORT + 1))}"
POSTGRES_PORT="${RADIOSO_COMMON_POSTGRES_PORT:-5432}"

export NODE_ENV=development
export PORT="$BACKEND_PORT"
if [[ -n "${RADIOSO_COMMON_POSTGRES_PORT:-}" ]]; then
  export DATABASE_URL="postgres://postgres:postgres@localhost:${POSTGRES_PORT}/radioso"
  export INTEGRATION_DATABASE_URL="$DATABASE_URL"
else
  export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:${POSTGRES_PORT}/radioso}"
  export INTEGRATION_DATABASE_URL="${INTEGRATION_DATABASE_URL:-$DATABASE_URL}"
fi
if [[ -n "${RADIOSO_FRONTEND_PORT:-}${CONDUCTOR_PORT:-}" ]]; then
  export APP_BASE_URL="http://localhost:${FRONTEND_PORT}"
  export PUBLIC_CHAT_BASE_URL="http://localhost:${FRONTEND_PORT}/chat"
else
  export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${FRONTEND_PORT}}"
  export PUBLIC_CHAT_BASE_URL="${PUBLIC_CHAT_BASE_URL:-http://localhost:${FRONTEND_PORT}/chat}"
fi
export BACKEND_INTERNAL_URL="${BACKEND_INTERNAL_URL:-http://localhost:${BACKEND_PORT}}"

node "$ROOT_DIR/scripts/sync-ee-frontend-routes.mjs" disable

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

(
  cd "$ROOT_DIR/backend"
  pnpm run dev
) &
pids+=("$!")

(
  cd "$ROOT_DIR/frontend"
  pnpm exec next dev --webpack --port "$FRONTEND_PORT"
) &
pids+=("$!")

printf 'Frontend: http://localhost:%s\n' "$FRONTEND_PORT"
printf 'Backend:  http://localhost:%s\n' "$BACKEND_PORT"
printf 'Database: localhost:%s/radioso (common)\n' "$POSTGRES_PORT"

wait -n "${pids[@]}"
