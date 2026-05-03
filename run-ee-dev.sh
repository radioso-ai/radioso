#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec node "$ROOT_DIR/scripts/run-ee-dev.mjs" "$@"
