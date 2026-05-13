#!/bin/sh
set -eu

cd /app

TARGET_SCRIPT="${1:-dev:http}"

LOCKFILE_HASH_FILE="node_modules/.pnpm-lock.sha256"
CURRENT_HASH="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
SAVED_HASH=""
ESBUILD_PLATFORM_PACKAGE="@esbuild/linux-$(node -p 'process.arch')"

if [ -f "$LOCKFILE_HASH_FILE" ]; then
  SAVED_HASH="$(cat "$LOCKFILE_HASH_FILE")"
fi

if [ ! -d node_modules ] \
  || [ "$CURRENT_HASH" != "$SAVED_HASH" ] \
  || [ ! -d "backend/node_modules/$ESBUILD_PLATFORM_PACKAGE" ] \
  || [ ! -d "packages/crawler/node_modules" ]; then
  echo "Installing backend workspace dependencies..."
  pnpm install --frozen-lockfile --filter radioso-backend... --filter @radioso/crawler...
  mkdir -p node_modules
  printf '%s' "$CURRENT_HASH" > "$LOCKFILE_HASH_FILE"
fi

exec pnpm --dir backend run "$TARGET_SCRIPT"
