import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("frontend dev entrypoint invalidates persisted Next cache when runtime dependencies change", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "infra/frontend.dev.entrypoint.sh"), "utf8");

  assert.match(entrypoint, /NEXT_CACHE_STATE_FILE="frontend\/\.next\/\.install-state"/);
  assert.match(entrypoint, /clear_next_cache\(\) \{/);
  assert.match(entrypoint, /find frontend\/\.next -mindepth 1 -maxdepth 1 -exec rm -rf \{\} \+/);
  assert.match(entrypoint, /printf '%s' "\$CURRENT_INSTALL_STATE" > "\$NEXT_CACHE_STATE_FILE"/);
});

test("frontend dev entrypoint builds frontend workspace dependencies before starting Next", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "infra/frontend.dev.entrypoint.sh"), "utf8");

  assert.match(entrypoint, /build_frontend_workspace_dependencies\(\) \{/);
  assert.match(entrypoint, /pnpm --dir frontend run build:workspace-deps/);
  assert.match(
    entrypoint,
    /build_frontend_workspace_dependencies[\s\S]+if ! next_cache_ready[\s\S]+start_next_dev/,
  );
});
