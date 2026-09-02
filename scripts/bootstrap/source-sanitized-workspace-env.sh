#!/usr/bin/env bash

BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source_sanitized_workspace_env() {
  local workspace_root="$1"
  local restore_nounset=false

  unset INTEGRATION_DATABASE_URL

  (
    cd "$workspace_root"
    node "$BOOTSTRAP_DIR/retire-integration-database-url.mjs"
  )

  if [[ -f "$workspace_root/.env" ]]; then
    if [[ $- == *u* ]]; then
      set +u
      restore_nounset=true
    fi
    set -a
    # shellcheck disable=SC1090
    source "$workspace_root/.env"
    set +a
    if [[ "$restore_nounset" == true ]]; then
      set -u
    fi
  fi

  unset INTEGRATION_DATABASE_URL
}
