#!/bin/sh
set -eu

cd /app

if [ "${RADIOSO_EDITION:-oss}" != "enterprise" ]; then
  rm -rf frontend/app/embed frontend/app/api/embed frontend/app/radioso-embed.js
fi

INSTALL_STATE_FILE="frontend/node_modules/.install-state"
NEXT_CACHE_STATE_FILE="frontend/.next/.install-state"
CURRENT_HASH="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
NODE_VERSION="$(node -p 'process.version')"
EXPECTED_SWC_PACKAGE="$(
  node -e '
    const platform = process.platform;
    const arch = process.arch;
    const report = process.report?.getReport?.();
    const isMusl = platform === "linux" && !report?.header?.glibcVersionRuntime;
    const abi = isMusl ? "musl" : "gnu";
    const map = {
      darwin: {
        arm64: "@next/swc-darwin-arm64",
        x64: "@next/swc-darwin-x64",
      },
      linux: {
        arm64: `@next/swc-linux-arm64-${abi}`,
        x64: `@next/swc-linux-x64-${abi}`,
      },
      win32: {
        arm64: "@next/swc-win32-arm64-msvc",
        x64: "@next/swc-win32-x64-msvc",
      },
    };
    process.stdout.write(map[platform]?.[arch] ?? "");
  '
)"
EXPECTED_LIGHTNINGCSS_PACKAGE="$(
  node -e '
    const platform = process.platform;
    const arch = process.arch;
    const report = process.report?.getReport?.();
    const isMusl = platform === "linux" && !report?.header?.glibcVersionRuntime;
    const suffix =
      platform === "linux"
        ? arch === "arm"
          ? "gnueabihf"
          : isMusl
            ? "musl"
            : "gnu"
        : platform === "win32"
          ? "msvc"
          : "";
    const name = [platform, arch, suffix].filter(Boolean).join("-");
    process.stdout.write(name ? `lightningcss-${name}` : "");
  '
)"
EXPECTED_TAILWIND_OXIDE_PACKAGE="$(
  node -e '
    const platform = process.platform;
    const arch = process.arch;
    const report = process.report?.getReport?.();
    const isMusl = platform === "linux" && !report?.header?.glibcVersionRuntime;
    const suffix =
      platform === "linux"
        ? arch === "arm"
          ? "gnueabihf"
          : isMusl
            ? "musl"
            : "gnu"
        : platform === "win32"
          ? "msvc"
          : "";
    const name = [platform, arch, suffix].filter(Boolean).join("-");
    process.stdout.write(name ? `@tailwindcss/oxide-${name}` : "");
  '
)"
CURRENT_INSTALL_STATE="${CURRENT_HASH}:${NODE_VERSION}:${EXPECTED_SWC_PACKAGE}:${EXPECTED_LIGHTNINGCSS_PACKAGE}:${EXPECTED_TAILWIND_OXIDE_PACKAGE}"
SAVED_INSTALL_STATE=""
SAVED_NEXT_CACHE_STATE=""

if [ -f "$INSTALL_STATE_FILE" ]; then
  SAVED_INSTALL_STATE="$(cat "$INSTALL_STATE_FILE")"
fi

if [ -f "$NEXT_CACHE_STATE_FILE" ]; then
  SAVED_NEXT_CACHE_STATE="$(cat "$NEXT_CACHE_STATE_FILE")"
fi

clear_next_cache() {
  echo "Clearing frontend Next.js dev cache..."
  mkdir -p frontend/.next
  find frontend/.next -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  SAVED_NEXT_CACHE_STATE=""
}

mark_next_cache_ready() {
  mkdir -p frontend/.next
  printf '%s' "$CURRENT_INSTALL_STATE" > "$NEXT_CACHE_STATE_FILE"
  SAVED_NEXT_CACHE_STATE="$CURRENT_INSTALL_STATE"
}

next_cache_looks_incomplete() {
  if [ -d frontend/.next/dev ] && [ ! -f frontend/.next/dev/routes-manifest.json ]; then
    return 0
  fi

  return 1
}

next_cache_ready() {
  if [ "$CURRENT_INSTALL_STATE" != "$SAVED_NEXT_CACHE_STATE" ]; then
    return 1
  fi

  if next_cache_looks_incomplete; then
    return 1
  fi

  return 0
}

module_is_ready() {
  node -e "require.resolve(process.argv[1], { paths: ['/app/frontend'] })" "$1" >/dev/null 2>&1
}

module_can_load() {
  node -e "require(require.resolve(process.argv[1], { paths: ['/app/frontend'] }))" "$1" >/dev/null 2>&1
}

frontend_modules_ready() {
  if [ ! -d frontend/node_modules ]; then
    return 1
  fi

  if [ ! -x frontend/node_modules/.bin/next ]; then
    return 1
  fi

  if [ -n "$EXPECTED_SWC_PACKAGE" ]; then
    module_can_load "$EXPECTED_SWC_PACKAGE" || return 1
  fi

  if [ -n "$EXPECTED_LIGHTNINGCSS_PACKAGE" ]; then
    module_can_load "lightningcss" || return 1
  fi

  if [ -n "$EXPECTED_TAILWIND_OXIDE_PACKAGE" ]; then
    module_can_load "$EXPECTED_TAILWIND_OXIDE_PACKAGE" || return 1
  fi

  for required_module in \
    "next/package.json" \
    "next/dist/pages/_error" \
    "next/dist/build/webpack/loaders/next-app-loader" \
    "next/dist/build/webpack/loaders/next-flight-client-entry-loader" \
    "next/dist/compiled/jest-worker/processChild.js" \
    "@swc/helpers/package.json"
  do
    module_is_ready "$required_module" || return 1
  done

  return 0
}

frontend_dependencies_ready() {
  if [ "$CURRENT_INSTALL_STATE" != "$SAVED_INSTALL_STATE" ]; then
    return 1
  fi

  frontend_modules_ready
}

install_frontend_dependencies() {
  echo "Installing frontend workspace dependencies..."
  pnpm install --frozen-lockfile --filter radioso-frontend...
  mkdir -p frontend/node_modules
  printf '%s' "$CURRENT_INSTALL_STATE" > "$INSTALL_STATE_FILE"
  SAVED_INSTALL_STATE="$CURRENT_INSTALL_STATE"
}

if [ ! -f "$INSTALL_STATE_FILE" ] && frontend_modules_ready; then
  printf '%s' "$CURRENT_INSTALL_STATE" > "$INSTALL_STATE_FILE"
  SAVED_INSTALL_STATE="$CURRENT_INSTALL_STATE"
fi

if ! frontend_dependencies_ready; then
  if ! install_frontend_dependencies || ! frontend_dependencies_ready; then
    echo "Frontend dependency install incomplete; pruning pnpm store and retrying..."
    pnpm store prune

    if ! install_frontend_dependencies || ! frontend_dependencies_ready; then
      echo "Frontend dependency install failed; the Compose node_modules volumes may need to be recreated." >&2
      exit 1
    fi
  fi
fi

if ! next_cache_ready; then
  clear_next_cache
  mark_next_cache_ready
fi

cd frontend
exec node_modules/.bin/next dev --webpack -H 0.0.0.0 -p 3000
