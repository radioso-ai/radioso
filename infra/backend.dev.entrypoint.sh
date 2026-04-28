#!/bin/sh
set -eu

cd /app/backend

TARGET_SCRIPT="${1:-dev:http}"

LOCKFILE_HASH_FILE="node_modules/.package-lock.sha256"
CURRENT_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
SAVED_HASH=""
ESBUILD_PLATFORM_PACKAGE="@esbuild/linux-$(node -p 'process.arch')"

if [ -f "$LOCKFILE_HASH_FILE" ]; then
  SAVED_HASH="$(cat "$LOCKFILE_HASH_FILE")"
fi

if [ ! -d node_modules ] || [ "$CURRENT_HASH" != "$SAVED_HASH" ] || [ ! -d "node_modules/$ESBUILD_PLATFORM_PACKAGE" ]; then
  echo "Installing backend dependencies..."
  npm ci
  printf '%s' "$CURRENT_HASH" > "$LOCKFILE_HASH_FILE"
fi

exec npm run "$TARGET_SCRIPT"
