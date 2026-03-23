import test from "node:test";
import assert from "node:assert/strict";

import { classifyEnvState } from "../../scripts/bootstrap/env-file.mjs";
import { runPreflightChecks } from "../../scripts/bootstrap/preflight.mjs";

test("classifyEnvState marks missing required provider key as partial", () => {
  const state = classifyEnvState({
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_SECRET: "secret-secret-secret",
    CONNECTOR_ENCRYPTION_KEY: "secret-secret-secret",
  });

  assert.equal(state, "partial");
});

test("runPreflightChecks fails when docker is missing", async () => {
  const results = await runPreflightChecks({
    run: async () => ({ ok: false, stdout: "", stderr: "" }),
  });

  assert.equal(results[0].status, "fail");
  assert.equal(results[0].name, "docker");
});

test("runPreflightChecks reports port conflicts when project is not already running", async () => {
  const responses = {
    "docker --version": { ok: true, stdout: "Docker version", stderr: "" },
    "docker compose version": { ok: true, stdout: "Docker Compose version", stderr: "" },
    "docker info": { ok: true, stdout: "info", stderr: "" },
    "docker compose -f /Users/dm/conductor/workspaces/radioso/lima/infra/docker-compose.yml -f /Users/dm/conductor/workspaces/radioso/lima/infra/docker-compose.dev.yml ps --services --status running": { ok: true, stdout: "", stderr: "" },
  };

  const results = await runPreflightChecks({
    run: async (command, args) => responses[[command, ...args].join(" ")],
    portCheck: async (port) => port !== 3000,
  });

  const blockedPort = results.find((result) => result.name === "port-3000");
  assert.equal(blockedPort?.status, "fail");
});
