#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "${CONDUCTOR_PORT:-}" =~ ^[0-9]+$ ]]; then
  export RADIOSO_FRONTEND_PORT="${RADIOSO_FRONTEND_PORT:-$CONDUCTOR_PORT}"
  export RADIOSO_BACKEND_PORT="${RADIOSO_BACKEND_PORT:-$((CONDUCTOR_PORT + 1))}"
  export RADIOSO_POSTGRES_PORT="${RADIOSO_POSTGRES_PORT:-$((CONDUCTOR_PORT + 2))}"
fi

if [[ -n "${RADIOSO_FRONTEND_PORT:-}" ]]; then
  export PUBLIC_CHAT_BASE_URL="${PUBLIC_CHAT_BASE_URL:-http://localhost:${RADIOSO_FRONTEND_PORT}/chat}"
fi

if [[ -n "${CONDUCTOR_WORKSPACE_NAME:-}" ]]; then
  WORKSPACE_PROJECT_NAME="$(
    printf 'radioso_%s' "$CONDUCTOR_WORKSPACE_NAME" |
      tr '[:upper:]' '[:lower:]' |
      tr -c 'a-z0-9_-' '_'
  )"
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$WORKSPACE_PROJECT_NAME}"
fi

node "$ROOT_DIR/scripts/sync-ee-frontend-routes.mjs" disable

exec node "$ROOT_DIR/scripts/bootstrap/index.mjs" "$@"
