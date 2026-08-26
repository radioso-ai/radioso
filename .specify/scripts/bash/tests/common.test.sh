#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/../common.sh"

assert_valid_branch() {
    check_feature_branch "$1" true >/dev/null
}

assert_invalid_branch() {
    if check_feature_branch "$1" true >/dev/null 2>&1; then
        echo "expected invalid feature branch: $1" >&2
        exit 1
    fi
}

assert_valid_branch "001-existing-feature"
assert_valid_branch "1042-scalable-realtime-updates"
assert_valid_branch "codex/1042-scalable-realtime-updates"
assert_invalid_branch "42-too-short"
assert_invalid_branch "codex/7-too-short"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/specify-common-test.XXXXXX")"
mkdir -p "$test_root/specs/001-existing-feature"
mkdir -p "$test_root/specs/1042-scalable-realtime-updates"
trap 'rmdir "$test_root/specs/001-existing-feature" "$test_root/specs/1042-scalable-realtime-updates" "$test_root/specs" "$test_root"' EXIT

test "$(find_feature_dir_by_prefix "$test_root" "001-other-name")" = "$test_root/specs/001-existing-feature"
test "$(find_feature_dir_by_prefix "$test_root" "1042-other-name")" = "$test_root/specs/1042-scalable-realtime-updates"

echo "common.sh feature-number tests passed"
