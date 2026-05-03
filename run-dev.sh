#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

node "$ROOT_DIR/scripts/sync-ee-frontend-routes.mjs" disable

exec node "$ROOT_DIR/scripts/bootstrap/index.mjs" "$@"
