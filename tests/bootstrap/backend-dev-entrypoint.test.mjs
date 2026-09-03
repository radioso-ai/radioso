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

test("backend dev image stamps the install state it seeds into the Compose volumes", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "infra/backend.dev.Dockerfile"), "utf8");

  assert.match(dockerfile, /pnpm install --frozen-lockfile[^\n]*\\\n\s*&& backend-dev-install-state\.sh write/);
});

test("development Compose installs the complete workspace before runtime services start", async () => {
  const compose = await readFile(path.join(repoRoot, "docker-compose.dev.yml"), "utf8");
  const dependencyService = compose.match(/  workspace-deps:\n[\s\S]*?(?=\n  backend:)/)?.[0] ?? "";
  const backendService = compose.match(/  backend:\n[\s\S]*?(?=\n  backend-worker:)/)?.[0] ?? "";

  assert.match(dependencyService, /pnpm install --force --frozen-lockfile/);
  assert.match(dependencyService, /backend-dev-install-state\.sh write/);
  assert.match(dependencyService, /\.\/backend:\/app\/backend/);
  assert.match(dependencyService, /\.\/frontend:\/app\/frontend/);
  assert.match(dependencyService, /\.\/packages:\/app\/packages/);
  assert.match(dependencyService, /radioso_workspace_node_modules:\/app\/node_modules/);
  assert.match(dependencyService, /radioso_backend_node_modules:\/app\/backend\/node_modules/);
  assert.match(dependencyService, /radioso_frontend_node_modules:\/app\/frontend\/node_modules/);
  assert.match(backendService, /workspace-deps:\n\s+condition: service_completed_successfully/);
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
