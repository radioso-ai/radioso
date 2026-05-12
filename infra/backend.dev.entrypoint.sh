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

CRAWLER_DIR="../packages/crawler"
CRAWLER_LOCKFILE_HASH_FILE="$CRAWLER_DIR/node_modules/.package-lock.sha256"
CRAWLER_CURRENT_HASH="$(sha256sum "$CRAWLER_DIR/package-lock.json" | awk '{print $1}')"
CRAWLER_SAVED_HASH=""

if [ -f "$CRAWLER_LOCKFILE_HASH_FILE" ]; then
  CRAWLER_SAVED_HASH="$(cat "$CRAWLER_LOCKFILE_HASH_FILE")"
fi

if [ ! -d "$CRAWLER_DIR/node_modules" ] || [ "$CRAWLER_CURRENT_HASH" != "$CRAWLER_SAVED_HASH" ]; then
  echo "Installing crawler dependencies..."
  npm --prefix "$CRAWLER_DIR" ci
  printf '%s' "$CRAWLER_CURRENT_HASH" > "$CRAWLER_LOCKFILE_HASH_FILE"
fi

exec npm run "$TARGET_SCRIPT"
