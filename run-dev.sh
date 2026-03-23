#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_ENV="$ROOT_DIR/backend/.env"

# Override this if your source env file lives somewhere else.
DEFAULT_MAIN_ENV="/Users/dm/code/radioso/backend/.env"
SOURCE_ENV="${RADIOSO_MAIN_ENV:-$DEFAULT_MAIN_ENV}"

if [[ -f "$SOURCE_ENV" ]]; then
  cp "$SOURCE_ENV" "$TARGET_ENV"
  echo "Copied $SOURCE_ENV -> $TARGET_ENV"
elif git -C "$ROOT_DIR" show main:backend/.env.example >/dev/null 2>&1; then
  git -C "$ROOT_DIR" show main:backend/.env.example >"$TARGET_ENV"
  echo "No main backend/.env found; copied main:backend/.env.example -> $TARGET_ENV"
else
  echo "Could not find a source env file." >&2
  echo "Set RADIOSO_MAIN_ENV=/absolute/path/to/backend/.env and rerun." >&2
  exit 1
fi

exec docker compose \
  -f "$ROOT_DIR/infra/docker-compose.yml" \
  -f "$ROOT_DIR/infra/docker-compose.dev.yml" \
  up --build
