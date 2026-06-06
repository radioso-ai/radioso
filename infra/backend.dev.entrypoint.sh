#!/bin/sh
set -eu

cd /app

TARGET_SCRIPT="${1:-dev:http}"

INSTALL_STATE_FILE="node_modules/.backend-install-state"
INSTALL_LOCK_DIR="node_modules/.backend-install.lock"
INSTALL_LOCK_TIMEOUT_SECONDS=300
INSTALL_LOCK_HELD=0
CURRENT_HASH="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
NODE_VERSION="$(node -p 'process.version')"
ESBUILD_PLATFORM_PACKAGE="@esbuild/linux-$(node -p 'process.arch')"
CURRENT_INSTALL_STATE="${CURRENT_HASH}:${NODE_VERSION}:${ESBUILD_PLATFORM_PACKAGE}"
SAVED_INSTALL_STATE=""

if [ -f "$INSTALL_STATE_FILE" ]; then
  SAVED_INSTALL_STATE="$(cat "$INSTALL_STATE_FILE")"
fi

refresh_saved_install_state() {
  if [ -f "$INSTALL_STATE_FILE" ]; then
    SAVED_INSTALL_STATE="$(cat "$INSTALL_STATE_FILE")"
  else
    SAVED_INSTALL_STATE=""
  fi
}

cleanup_install_lock() {
  if [ "$INSTALL_LOCK_HELD" = "1" ]; then
    rm -rf "$INSTALL_LOCK_DIR"
    INSTALL_LOCK_HELD=0
  fi
}

trap cleanup_install_lock EXIT INT TERM

acquire_install_lock() {
  mkdir -p node_modules

  while ! mkdir "$INSTALL_LOCK_DIR" 2>/dev/null; do
    now="$(date +%s)"
    created_at="$(cat "$INSTALL_LOCK_DIR/created_at" 2>/dev/null || echo 0)"
    case "$created_at" in
      ''|*[!0-9]*) created_at=0 ;;
    esac

    if [ $((now - created_at)) -gt "$INSTALL_LOCK_TIMEOUT_SECONDS" ]; then
      echo "Removing stale backend dependency install lock..."
      rm -rf "$INSTALL_LOCK_DIR"
      continue
    fi

    echo "Waiting for another backend dependency install to finish..."
    sleep 2
  done

  date +%s > "$INSTALL_LOCK_DIR/created_at"
  INSTALL_LOCK_HELD=1
}

release_install_lock() {
  cleanup_install_lock
}

module_is_ready() {
  node -e "require.resolve(process.argv[1], { paths: ['/app/backend'] })" "$1" >/dev/null 2>&1
}

module_is_ready_from() {
  node -e "
    const path = require('node:path');
    const owner = path.dirname(require.resolve(process.argv[1], { paths: ['/app/backend'] }));
    require.resolve(process.argv[2], { paths: [owner] });
  " "$1" "$2" >/dev/null 2>&1
}

backend_modules_ready() {
  if [ ! -d node_modules ] || [ ! -d backend/node_modules ] || [ ! -d packages/crawler/node_modules ]; then
    return 1
  fi

  if [ ! -x backend/node_modules/.bin/tsx ]; then
    return 1
  fi

  for workspace_package in \
    "backend/node_modules/@radioso/conversation-engine" \
    "backend/node_modules/@radioso/conversation-defaults" \
    "backend/node_modules/@radioso/crawler"
  do
    [ -f "$workspace_package/package.json" ] || return 1
  done

  for required_module in "tsx/package.json" "zod/package.json"
  do
    module_is_ready "$required_module" || return 1
  done

  module_is_ready_from "tsx/package.json" "$ESBUILD_PLATFORM_PACKAGE/package.json" || return 1
  [ -f packages/conversation-defaults/node_modules/@radioso/conversation-contract/package.json ]
}

backend_dependencies_ready() {
  if [ "$CURRENT_INSTALL_STATE" != "$SAVED_INSTALL_STATE" ]; then
    return 1
  fi

  backend_modules_ready
}

install_backend_dependencies() {
  echo "Installing backend workspace dependencies..."
  pnpm install --frozen-lockfile --filter radioso-backend... --filter @radioso/crawler... --filter @radioso/mcp-server... --filter @radioso/conversation-engine... --filter @radioso/conversation-defaults...
  mkdir -p node_modules
  mkdir -p backend/node_modules
  backend_modules_ready || return 1
  printf '%s' "$CURRENT_INSTALL_STATE" > "$INSTALL_STATE_FILE"
  SAVED_INSTALL_STATE="$CURRENT_INSTALL_STATE"
}

if [ ! -f "$INSTALL_STATE_FILE" ] && backend_modules_ready; then
  printf '%s' "$CURRENT_INSTALL_STATE" > "$INSTALL_STATE_FILE"
  SAVED_INSTALL_STATE="$CURRENT_INSTALL_STATE"
fi

if ! backend_dependencies_ready; then
  acquire_install_lock
  refresh_saved_install_state

  if ! backend_dependencies_ready && { ! install_backend_dependencies || ! backend_dependencies_ready; }; then
    echo "Backend dependency install incomplete; pruning pnpm store and retrying..."
    pnpm store prune

    if ! install_backend_dependencies || ! backend_dependencies_ready; then
      release_install_lock
      echo "Backend dependency install failed; the Compose node_modules volumes may need to be recreated." >&2
      exit 1
    fi
  fi

  release_install_lock
fi

exec pnpm --dir backend run "$TARGET_SCRIPT"
