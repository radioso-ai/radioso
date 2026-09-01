import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main, resolveGeneratedValues } from "../../scripts/bootstrap/index.mjs";

test("bootstrap generates and preserves a strong worker task authentication token", () => {
  const generated = resolveGeneratedValues({});
  assert.ok(generated.WORKER_TASK_AUTH_TOKEN.length >= 32);

  const existing = "existing-worker-token-with-at-least-32-characters";
  assert.equal(
    resolveGeneratedValues({ WORKER_TASK_AUTH_TOKEN: existing }).WORKER_TASK_AUTH_TOKEN,
    existing,
  );
});

test("main secures an existing env file before a blocking preflight exit", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-main-"));
  const envPath = path.join(tempDir, ".env");
  await fs.writeFile(envPath, "SESSION_COOKIE_SECRET=existing-secret\n", { mode: 0o644 });
  await fs.chmod(envPath, 0o644);

  try {
    const exitCode = await main([], {
      detectEnvState: async () => ({
        values: { SESSION_COOKIE_SECRET: "existing-secret" },
        state: "valid",
      }),
      runPreflightChecks: async () => [{
        name: "docker",
        status: "fail",
        summary: "Docker is unavailable.",
        recoveryAction: null,
        isBlocking: true,
      }],
      stdout: { write: () => {} },
      envPath,
    });

    assert.equal(exitCode, 1);
    const stats = await fs.stat(envPath);
    assert.equal(stats.mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("main auto-completes a partial env file during non-interactive startup", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-main-"));
  const envPath = path.join(tempDir, ".env");

  await fs.writeFile(
    envPath,
    [
      "PORT=8080",
      "NODE_ENV=development",
      "DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso",
      "INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso",
      "OPENAI_API_KEY=sk-test",
      "OPENAI_CHAT_MODEL=gpt-5.4-mini",
      "OPENAI_RERANK_MODEL=gpt-5.4-nano",
      "OPENAI_VECTOR_MODEL=text-embedding-3-small",
      "LLM_PROVIDER=openai",
      "SESSION_COOKIE_NAME=radioso_session",
      "SESSION_COOKIE_SECRET=existing-session-secret",
      "WORKSPACE_TOKEN_SECRET=existing-workspace-secret",
      "WEBSITE_EMBED_SECRET=existing-embed-secret",
      "SESSION_TTL_HOURS=168",
      "CONNECTOR_ENCRYPTION_KEY=existing-connector-secret",
      "DOCUMENT_UPLOAD_MAX_BYTES=10485760",
      "PUBLIC_CHAT_BASE_URL=http://localhost:3000/chat",
      "",
    ].join("\n"),
    "utf8",
  );

  const writes = [];
  const stdoutChunks = [];
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

    const exitCode = await main([], {
      detectEnvState: async () => ({
        values: {
          PORT: "8080",
          NODE_ENV: "development",
          DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso",
          INTEGRATION_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso",
          OPENAI_API_KEY: "sk-test",
          OPENAI_CHAT_MODEL: "gpt-5.4-mini",
          OPENAI_RERANK_MODEL: "gpt-5.4-nano",
          OPENAI_VECTOR_MODEL: "text-embedding-3-small",
          LLM_PROVIDER: "openai",
          SESSION_COOKIE_NAME: "radioso_session",
          SESSION_COOKIE_SECRET: "existing-session-secret",
          WORKSPACE_TOKEN_SECRET: "existing-workspace-secret",
          WEBSITE_EMBED_SECRET: "existing-embed-secret",
          SESSION_TTL_HOURS: "168",
          CONNECTOR_ENCRYPTION_KEY: "existing-connector-secret",
          DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
          PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
        },
        state: "partial",
      }),
      runPreflightChecks: async () => [],
      writeEnvFileAtomic: async (filePath, source) => {
        writes.push({ filePath, source });
      },
      startComposeStack: async () => ({
        ok: true,
        readyServices: ["frontend", "backend"],
        failedServices: [],
        applicationUrls: ["http://127.0.0.1:3000", "http://127.0.0.1:8080"],
      }),
      stdout: { write: (chunk) => stdoutChunks.push(chunk) },
      envPath,
    });

    assert.equal(exitCode, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].filePath, envPath);
    assert.match(writes[0].source, /DOCUMENT_STORAGE_DRIVER=local/);
    assert.match(writes[0].source, /DOCUMENT_STORAGE_LOCAL_PATH=\.\.\/\.context\/document-storage/);
    assert.match(writes[0].source, /WORKER_DISPATCH_DRIVER=noop/);
    assert.match(writes[0].source, /DOCUMENT_PROCESSING_JOB_LEASE_MS=300000/);
    assert.doesNotMatch(writes[0].source, /AUTH_SKIP_EMAIL_VERIFICATION=/);
    assert.match(writes[0].source, /PUBLIC_CHAT_SESSION_SECRET=existing-embed-secret/);
    assert.match(writes[0].source, /WORKER_TASK_AUTH_TOKEN=[A-Za-z0-9+/=]{32,}/);
    assert.doesNotMatch(writes[0].source, /WEBSITE_EMBED_SECRET=/);
    assert.match(stdoutChunks.join(""), /Auto-completed \.env for non-interactive startup/);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("main rewrites a valid legacy env file to remove the retired integration database URL", async () => {
  const writes = [];
  const stdoutChunks = [];
  const legacySource = [
    "# Keep this operator note exactly as written.",
    "CUSTOM_DEPLOYMENT_SETTING = preserve-me",
    "INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso_test",
    "# This comment follows the retired setting.",
    "PORT=8080",
    "",
  ].join("\n");

  const exitCode = await main([], {
    detectEnvState: async () => ({
      values: {
        PORT: "8080",
        NODE_ENV: "development",
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso",
        INTEGRATION_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso_test",
        LLM_PROVIDER: "openai",
        SESSION_COOKIE_NAME: "radioso_session",
        SESSION_COOKIE_SECRET: "session-secret",
        WORKSPACE_TOKEN_SECRET: "workspace-secret",
        PUBLIC_CHAT_SESSION_SECRET: "public-session-secret",
        SESSION_TTL_HOURS: "168",
        CONNECTOR_ENCRYPTION_KEY: "connector-secret",
        WORKER_TASK_AUTH_TOKEN: "worker-task-token",
        DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
        WORKER_DISPATCH_DRIVER: "noop",
        DOCUMENT_PROCESSING_JOB_LEASE_MS: "300000",
        DOCUMENT_STORAGE_DRIVER: "local",
        DOCUMENT_STORAGE_LOCAL_PATH: "../.context/document-storage",
        PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
      },
      state: "valid",
    }),
    runPreflightChecks: async () => [],
    readEnvFileSource: async () => legacySource,
    writeEnvFileAtomic: async (filePath, source) => writes.push({ filePath, source }),
    startComposeStack: async () => ({
      ok: true,
      readyServices: ["frontend", "backend"],
      failedServices: [],
      applicationUrls: ["http://127.0.0.1:3000", "http://127.0.0.1:8080"],
    }),
    stdout: { write: (chunk) => stdoutChunks.push(chunk) },
    envPath: "/tmp/radioso-valid-legacy.env",
  });

  assert.equal(exitCode, 0);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].source,
    [
      "# Keep this operator note exactly as written.",
      "CUSTOM_DEPLOYMENT_SETTING = preserve-me",
      "# This comment follows the retired setting.",
      "PORT=8080",
      "",
    ].join("\n"),
  );
  assert.match(stdoutChunks.join(""), /Removed retired configuration from \.env/);
});
