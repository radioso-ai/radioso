#!/usr/bin/env bash
# Build the radioso-sync WordPress plugin zip and write it to
# frontend/public/radioso-sync.zip so the dashboard can hand the file to
# users via a plain static download link.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
out="$repo_root/frontend/public/radioso-sync.zip"

# WordPress expects the plugin to extract into a folder matching its slug.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/radioso-sync"
cp "$here/radioso-sync.php" "$here/README.md" "$work/radioso-sync/"

rm -f "$out"
(cd "$work" && zip -qr "$out" radioso-sync)

echo "wrote $out"
