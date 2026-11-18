import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

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

async function runVendorChunkWatchdog(bundleSource, existingChunks) {
  const script = await readFile(path.join(repoRoot, "infra/frontend.dev.entrypoint.sh"), "utf8");
  const start = script.indexOf("next_cache_has_missing_vendor_chunk() {");
  const end = script.indexOf("\nnext_cache_ready() {");
  const fn = script.slice(start, end);

  const cwd = await mkdtemp(path.join(os.tmpdir(), "watchdog-"));
  const appDir = path.join(cwd, "frontend/.next/dev/server/app");
  const chunkDir = path.join(cwd, "frontend/.next/dev/server/vendor-chunks");
  await mkdir(appDir, { recursive: true });
  await mkdir(chunkDir, { recursive: true });
  await writeFile(path.join(appDir, "page.js"), bundleSource);
  for (const chunk of existingChunks) {
    await writeFile(path.join(chunkDir, `${chunk}.js`), "");
  }
  try {
    const output = execFileSync("sh", ["-c", `${fn}\nnext_cache_has_missing_vendor_chunk`], {
      cwd,
      encoding: "utf8",
    });
    return { missing: true, output };
  } catch (error) {
    if (error.status === 1) return { missing: false, output: error.stdout };
    throw error;
  }
}

// Dev bundles embed chunk requires inside a JSON-escaped string, so the name is followed by `\"`.
const escapedBundle =
  'eval("__webpack_require__(\\"../vendor-chunks/@example+client@1.0.22\\"); ' +
  'require(\\"../vendor-chunks/example-client\\")");';

test("vendor chunk watchdog does not flag chunks referenced through JSON-escaped quotes", async () => {
  const result = await runVendorChunkWatchdog(escapedBundle, ["@example+client@1.0.22", "example-client"]);
  assert.equal(result.missing, false, result.output);
});

test("vendor chunk watchdog reports a chunk that is really missing", async () => {
  const result = await runVendorChunkWatchdog(escapedBundle, ["example-client"]);
  assert.equal(result.missing, true);
  assert.match(result.output, /missing server\/vendor-chunks\/@example\+client@1\.0\.22\.js/);
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
