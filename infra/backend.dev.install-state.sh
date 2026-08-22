#!/bin/sh
set -eu

# Identity of a backend dependency install: the lockfile it was resolved from,
# the Node it was built for, and the esbuild platform binary it needs.
#
# Compose gives the backend four independent node_modules volumes, each seeded
# from the image the first time it is created. They drift apart afterwards: a
# volume gets recreated on its own, or another container writes the shared
# workspace volume without mounting the rest. A tree left behind at an older
# lockfile still looks populated, so every tree carries its own stamp and one
# stale stamp reinstalls all of them.

APP_DIR="${APP_DIR:-/app}"
STATE_FILENAME=".backend-install-state"
STATE_DIRS="node_modules backend/node_modules packages/crawler/node_modules packages/document-parser/node_modules"

cd "$APP_DIR"

current_state() {
  node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const lockfileHash = createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex");
    process.stdout.write(`${lockfileHash}:${process.version}:@esbuild/linux-${process.arch}`);
  '
}

case "${1:-check}" in
  print)
    current_state
    ;;
  check)
    expected="$(current_state)"
    for state_dir in $STATE_DIRS; do
      [ "$(cat "$state_dir/$STATE_FILENAME" 2>/dev/null)" = "$expected" ] || exit 1
    done
    ;;
  write)
    expected="$(current_state)"
    for state_dir in $STATE_DIRS; do
      mkdir -p "$state_dir"
      printf '%s' "$expected" > "$state_dir/$STATE_FILENAME"
    done
    ;;
  *)
    echo "usage: backend-dev-install-state.sh [print|check|write]" >&2
    exit 2
    ;;
esac
