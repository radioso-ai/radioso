#!/bin/sh
set -eu

cd /app

INSTALL_STATE_FILE="node_modules/.install-state"
CURRENT_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
NODE_VERSION="$(node -p 'process.version')"
EXPECTED_SWC_PACKAGE="$(
  node -p '
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
CURRENT_INSTALL_STATE="${CURRENT_HASH}:${NODE_VERSION}:${EXPECTED_SWC_PACKAGE}"
SAVED_INSTALL_STATE=""
SWC_READY=1

if [ -f "$INSTALL_STATE_FILE" ]; then
  SAVED_INSTALL_STATE="$(cat "$INSTALL_STATE_FILE")"
fi

if [ -n "$EXPECTED_SWC_PACKAGE" ]; then
  if ! node -e "require.resolve('${EXPECTED_SWC_PACKAGE}/package.json')" >/dev/null 2>&1; then
    SWC_READY=0
  fi
fi

if [ ! -d node_modules ] || [ "$CURRENT_INSTALL_STATE" != "$SAVED_INSTALL_STATE" ] || [ "$SWC_READY" -ne 1 ]; then
  echo "Installing frontend dependencies..."
  npm ci
  printf '%s' "$CURRENT_INSTALL_STATE" > "$INSTALL_STATE_FILE"
fi

exec npx next dev --webpack -H 0.0.0.0 -p 3000
