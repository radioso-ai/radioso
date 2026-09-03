import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { main, resolveRunDevEnvironment } from "../../scripts/run-dev.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("run-dev resolves Conductor ports and public URLs once for every host launcher", () => {
  const resolved = resolveRunDevEnvironment({ CONDUCTOR_PORT: "4100" });

  assert.equal(resolved.RADIOSO_FRONTEND_PORT, "4100");
  assert.equal(resolved.RADIOSO_BACKEND_PORT, "4101");
  assert.equal(resolved.RADIOSO_POSTGRES_PORT, "4102");
  assert.equal(resolved.APP_BASE_URL, "http://localhost:4100");
  assert.equal(resolved.PUBLIC_CHAT_BASE_URL, "http://localhost:4100/chat");
});

test("run-dev preserves explicit ports and public URLs", () => {
  const resolved = resolveRunDevEnvironment({
    CONDUCTOR_PORT: "4100",
    RADIOSO_FRONTEND_PORT: "4400",
    RADIOSO_BACKEND_PORT: "4401",
    RADIOSO_POSTGRES_PORT: "4402",
    APP_BASE_URL: "https://app.example.com",
    PUBLIC_CHAT_BASE_URL: "https://chat.example.com",
  });

  assert.equal(resolved.RADIOSO_FRONTEND_PORT, "4400");
  assert.equal(resolved.RADIOSO_BACKEND_PORT, "4401");
  assert.equal(resolved.RADIOSO_POSTGRES_PORT, "4402");
  assert.equal(resolved.APP_BASE_URL, "https://app.example.com");
  assert.equal(resolved.PUBLIC_CHAT_BASE_URL, "https://chat.example.com");
});

test("run-dev synchronizes OSS routes before forwarding arguments to the bootstrap", async () => {
  const calls = [];
  const env = { CONDUCTOR_PORT: "4100" };

  const exitCode = await main(["--attach"], {
    env,
    disableEnterpriseFrontendRoutes: async () => calls.push("sync"),
    bootstrapMain: async (argv) => {
      calls.push({ argv, frontendPort: env.RADIOSO_FRONTEND_PORT });
      return 0;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    "sync",
    { argv: ["--attach"], frontendPort: "4100" },
  ]);
});

test("run-dev does not start the stack when OSS route synchronization fails", async () => {
  let bootstrapCalled = false;

  await assert.rejects(
    main([], {
      env: {},
      disableEnterpriseFrontendRoutes: async () => {
        throw new Error("route sync failed");
      },
      bootstrapMain: async () => {
        bootstrapCalled = true;
        return 0;
      },
    }),
    /route sync failed/,
  );
  assert.equal(bootstrapCalled, false);
});

test("host wrappers contain no duplicated startup policy", async () => {
  const shellLauncher = await fs.readFile(path.join(repoRoot, "run-dev.sh"), "utf8");
  const windowsLauncher = await fs.readFile(path.join(repoRoot, "run-dev.cmd"), "utf8");

  assert.match(shellLauncher, /scripts\/run-dev\.mjs/);
  assert.match(windowsLauncher, /scripts\\run-dev\.mjs/);
  for (const launcher of [shellLauncher, windowsLauncher]) {
    assert.doesNotMatch(launcher, /CONDUCTOR_PORT|APP_BASE_URL|sync-ee-frontend-routes/);
  }
});

test("Windows checkouts preserve LF endings for Linux container scripts", async () => {
  const attributes = await fs.readFile(path.join(repoRoot, ".gitattributes"), "utf8");

  assert.match(attributes, /^\*\.sh text eol=lf$/m);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/m);
});
