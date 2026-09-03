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

test("frontend dev entrypoint restarts Next when dev manifests are missing at runtime", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "infra/frontend.dev.entrypoint.sh"), "utf8");

  assert.match(entrypoint, /next_cache_has_missing_dev_manifest\(\) \{/);
  assert.match(entrypoint, /frontend\/\.next\/dev\/routes-manifest\.json/);
  assert.match(entrypoint, /frontend\/\.next\/dev\/server\/middleware-manifest\.json/);
  assert.match(
    entrypoint,
    /while kill -0 "\$NEXT_PID"[\s\S]+if next_cache_looks_incomplete[\s\S]+Restarting frontend Next\.js dev server after incomplete cache\./,
  );
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

test("frontend dev image contains the workspace packages used by its isolated install", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "infra/frontend.dev.Dockerfile"), "utf8");
  const installOffset = dockerfile.indexOf("pnpm install --frozen-lockfile --filter radioso-frontend...");

  assert.notEqual(installOffset, -1);
  for (const workspace of [
    "packages/routine-definition",
    "packages/routine-document",
    "packages/ui",
    "packages/workspace-invalidation-contract",
  ]) {
    const manifestOffset = dockerfile.indexOf(`COPY ${workspace}/package.json`);
    assert.notEqual(manifestOffset, -1, `${workspace} manifest should be copied`);
    assert.equal(manifestOffset < installOffset, true, `${workspace} manifest should be copied before install`);
    assert.match(dockerfile, new RegExp(`COPY ${workspace.replaceAll("/", "\\/")} \\.\\/${workspace.replaceAll("/", "\\/")}`));
  }
});
