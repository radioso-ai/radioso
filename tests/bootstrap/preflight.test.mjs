import test from "node:test";
import assert from "node:assert/strict";

import { classifyEnvState } from "../../scripts/bootstrap/env-file.mjs";
import { getComposeArgs, runPreflightChecks } from "../../scripts/bootstrap/preflight.mjs";

test("classifyEnvState marks missing required provider key as partial", () => {
  const state = classifyEnvState({
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_SECRET: "secret-secret-secret",
    CONNECTOR_ENCRYPTION_KEY: "secret-secret-secret",
  });

  assert.equal(state, "partial");
});

test("classifyEnvState marks legacy gcs storage config without a driver as partial", () => {
  const state = classifyEnvState({
    PORT: "8080",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://db",
    INTEGRATION_DATABASE_URL: "postgres://db",
    OPENAI_API_KEY: "sk-test",
    OPENAI_CHAT_MODEL: "gpt-test",
    OPENAI_RERANK_MODEL: "gpt-rerank",
    OPENAI_VECTOR_MODEL: "text-embedding-test",
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret-secret-secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret-secret",
    WEBSITE_EMBED_SECRET: "embed-secret-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "secret-secret-secret",
    DOCUMENT_STORAGE_BUCKET: "legacy-bucket",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  assert.equal(state, "partial");
});

test("classifyEnvState marks gcs storage without a bucket as partial", () => {
  const state = classifyEnvState({
    PORT: "8080",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://example",
    INTEGRATION_DATABASE_URL: "postgres://example",
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test",
    OPENAI_CHAT_MODEL: "gpt-5.2",
    OPENAI_RERANK_MODEL: "gpt-5.2",
    OPENAI_VECTOR_MODEL: "text-embedding-3-small",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret-secret-secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret-secret",
    WEBSITE_EMBED_SECRET: "embed-secret-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "connector-secret",
    DOCUMENT_STORAGE_DRIVER: "gcs",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
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
  const composePsKey = ["docker", ...getComposeArgs(), "ps", "--services", "--status", "running"].join(" ");
  const responses = {
    "docker --version": { ok: true, stdout: "Docker version", stderr: "" },
    "docker compose version": { ok: true, stdout: "Docker Compose version", stderr: "" },
    "docker info": { ok: true, stdout: "info", stderr: "" },
    [composePsKey]: { ok: true, stdout: "", stderr: "" },
  };

  const results = await runPreflightChecks({
    run: async (command, args) => responses[[command, ...args].join(" ")],
    portCheck: async (port) => port !== 3000,
  });

  const blockedPort = results.find((result) => result.name === "port-3000");
  assert.equal(blockedPort?.status, "fail");
});

test("runPreflightChecks fails fast when docker info times out", async () => {
  const results = await runPreflightChecks({
    run: async (command, args) => {
      const key = [command, ...args].join(" ");
      if (key === "docker info") {
        return { ok: false, stdout: "", stderr: "Command timed out after 100ms", timedOut: true };
      }

      return { ok: true, stdout: "ok", stderr: "", timedOut: false };
    },
    commandTimeoutMs: 100,
  });

  const dockerDaemon = results.find((result) => result.name === "docker-daemon");
  assert.equal(dockerDaemon?.status, "fail");
  assert.match(dockerDaemon?.summary ?? "", /timed out/);
  assert.match(dockerDaemon?.recoveryAction ?? "", /docker info/);
});
