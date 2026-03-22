#!/bin/sh
set -eu

cd /app/backend

LOCKFILE_HASH_FILE="node_modules/.package-lock.sha256"
CURRENT_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
SAVED_HASH=""

if [ -f "$LOCKFILE_HASH_FILE" ]; then
  SAVED_HASH="$(cat "$LOCKFILE_HASH_FILE")"
fi

if [ ! -d node_modules ] || [ "$CURRENT_HASH" != "$SAVED_HASH" ]; then
  echo "Installing backend dependencies..."
  npm ci
  printf '%s' "$CURRENT_HASH" > "$LOCKFILE_HASH_FILE"
fi

exec npm run dev
