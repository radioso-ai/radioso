import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const installStateScript = path.join(repoRoot, "infra/backend.dev.install-state.sh");

const STAMPED_TREES = [
  "node_modules",
  "backend/node_modules",
  "packages/crawler/node_modules",
  "packages/document-parser/node_modules"
];

const runInstallState = async (appDir, command) => {
  try {
    const { stdout } = await execFileAsync("sh", [installStateScript, command], {
      env: { ...process.env, APP_DIR: appDir }
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "" };
  }
};

const createAppDir = async (lockfileContents = "lockfileVersion: '9.0'\n") => {
  const appDir = await mkdtemp(path.join(tmpdir(), "radioso-install-state-"));
  await writeFile(path.join(appDir, "pnpm-lock.yaml"), lockfileContents);
  for (const tree of STAMPED_TREES) {
    await mkdir(path.join(appDir, tree), { recursive: true });
  }
  return appDir;
};

test("backend dev entrypoint serializes shared dependency installs", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "infra/backend.dev.entrypoint.sh"), "utf8");

  assert.match(entrypoint, /INSTALL_LOCK_DIR="node_modules\/\.backend-install\.lock"/);
  assert.match(entrypoint, /acquire_install_lock\(\) \{/);
  assert.match(entrypoint, /Waiting for another backend dependency install to finish/);
  assert.match(entrypoint, /backend_modules_ready \|\| return 1/);
  assert.match(entrypoint, /backend-dev-install-state\.sh check/);
  assert.match(entrypoint, /backend-dev-install-state\.sh write/);
});

test("every backend dev process builds MCP source dependencies in its own container", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "backend/package.json"), "utf8"));

  assert.match(packageJson.scripts["build:workspace-deps"], /pnpm run build:mcp/);
  for (const scriptName of [
    "predev:http",
    "predev:worker",
    "predev:worker-server",
    "predev:crawler-worker",
    "predev:crawler-worker-server",
  ]) {
    assert.equal(packageJson.scripts[scriptName], "pnpm run build:workspace-deps");
  }
});

test("backend dev image stamps the install state it seeds into the Compose volumes", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "infra/backend.dev.Dockerfile"), "utf8");

  assert.match(dockerfile, /pnpm install --frozen-lockfile[^\n]*\\\n\s*&& backend-dev-install-state\.sh write/);
  for (const workspace of [
    "frontend",
    "packages/census",
    "packages/integration-test-support",
    "packages/routine-definition",
    "packages/routine-document",
    "packages/ui",
    "packages/workspace-invalidation-contract",
  ]) {
    assert.match(dockerfile, new RegExp(`COPY ${workspace}/package\\.json`));
  }
});

test("development Compose installs the complete workspace before runtime services start", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.dev.yml"), "utf8");
  const dependencyService = compose.match(/ {2}workspace-deps:\n[\s\S]*?(?=\n {2}backend:)/)?.[0] ?? "";
  const backendService = compose.match(/ {2}backend:\n[\s\S]*?(?=\n {2}backend-worker:)/)?.[0] ?? "";

  assert.match(dependencyService, /pnpm install --force --frozen-lockfile/);
  assert.match(dependencyService, /backend-dev-install-state\.sh write/);
  assert.match(dependencyService, /volumes: \*workspace-deps-volumes/);
  assert.match(compose, /radioso_workspace_node_modules:\/app\/node_modules/);
  assert.match(compose, /radioso_backend_node_modules:\/app\/backend\/node_modules/);
  assert.match(compose, /radioso_frontend_node_modules:\/app\/frontend\/node_modules/);
  assert.match(backendService, /workspace-deps:\n\s+condition: service_completed_successfully/);

  for (const overlappingBind of [
    "./backend:/app/backend",
    "./frontend:/app/frontend",
    "./packages:/app/packages",
  ]) {
    assert.doesNotMatch(compose, new RegExp(overlappingBind.replaceAll("/", "\\/")));
  }
  assert.match(backendService, /volumes: \*backend-dev-volumes/);
  assert.match(compose, /\.\/backend\/src:\/app\/backend\/src/);
  assert.match(compose, /\.\/frontend\/app:\/app\/frontend\/app/);
  assert.match(compose, /\.\/packages\/conversation-engine\/src:\/app\/packages\/conversation-engine\/src/);
});

test("development Compose never nests a dependency volume below a bind mount", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.dev.yml"), "utf8");
  const mappings = [...compose.matchAll(/^\s+- ([^:\n]+):([^:\n]+)(?::[^\n]+)?$/gm)]
    .map((match) => ({ source: match[1], target: match[2] }));
  const bindTargets = mappings.filter(({ source }) => source.startsWith(".")).map(({ target }) => target);
  const dependencyTargets = mappings
    .filter(({ source }) => source.startsWith("radioso_"))
    .map(({ target }) => target);

  for (const bindTarget of bindTargets) {
    for (const dependencyTarget of dependencyTargets) {
      assert.equal(
        dependencyTarget.startsWith(`${bindTarget}/`),
        false,
        `${dependencyTarget} must not be nested below bind mount ${bindTarget}`,
      );
    }
  }
});

test("install state check fails until every node_modules tree is stamped", async (t) => {
  const appDir = await createAppDir();
  t.after(() => rm(appDir, { recursive: true, force: true }));

  assert.equal((await runInstallState(appDir, "check")).code, 1);

  assert.equal((await runInstallState(appDir, "write")).code, 0);
  assert.equal((await runInstallState(appDir, "check")).code, 0);
});

test("install state check fails when one tree drifts behind the others", async (t) => {
  const appDir = await createAppDir();
  t.after(() => rm(appDir, { recursive: true, force: true }));

  await runInstallState(appDir, "write");

  // The crawler tree is its own Compose volume, so it can be left behind at an
  // older lockfile while the workspace volume is reinstalled around it.
  await writeFile(path.join(appDir, "packages/crawler/node_modules/.backend-install-state"), "stale");

  assert.equal((await runInstallState(appDir, "check")).code, 1);
});

test("install state changes when the lockfile changes", async (t) => {
  const appDir = await createAppDir();
  t.after(() => rm(appDir, { recursive: true, force: true }));

  const before = (await runInstallState(appDir, "print")).stdout;
  await writeFile(path.join(appDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# bumped\n");
  const after = (await runInstallState(appDir, "print")).stdout;

  assert.notEqual(before, after);
});

test("a tree stamped for an older lockfile is not adopted as current", async (t) => {
  const appDir = await createAppDir();
  t.after(() => rm(appDir, { recursive: true, force: true }));

  await runInstallState(appDir, "write");
  await writeFile(path.join(appDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# bumped\n");

  assert.equal((await runInstallState(appDir, "check")).code, 1);
});
