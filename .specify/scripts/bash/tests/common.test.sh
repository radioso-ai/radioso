#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/../common.sh"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/specify-common-test.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/project/.specify/templates" "$test_root/project/specs/001-existing-feature"
test_project="$(CDPATH="" cd -- "$test_root/project" 2>/dev/null && pwd)"
printf 'feature template\n' > "$test_root/project/.specify/templates/spec-template.md"

test "$(find_specify_root "$test_root/project/specs/001-existing-feature")" = "$test_project"
test "$(get_repo_root)" = "$(CDPATH="" cd -- "$script_dir/../../../.." && pwd)"

printf '{"feature_directory":"specs/001-existing-feature"}\n' > "$test_root/project/.specify/feature.json"
test "$(read_feature_json_feature_directory "$test_root/project")" = "specs/001-existing-feature"

paths="$(SPECIFY_INIT_DIR="$test_project" get_feature_paths --no-persist)"
eval "$paths"
test "$FEATURE_DIR" = "$test_project/specs/001-existing-feature"
test "$FEATURE_SPEC" = "$test_project/specs/001-existing-feature/spec.md"

test "$(format_speckit_command specify "$test_project")" = '$speckit.specify'
test "$(format_speckit_command specify "$(get_repo_root)")" = '$speckit-specify'
test "$(resolve_template spec-template "$test_project")" = "$test_project/.specify/templates/spec-template.md"
test "$(resolve_template_content spec-template "$test_project")" = 'feature template'

echo "common.sh tests passed"
