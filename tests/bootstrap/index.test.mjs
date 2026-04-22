import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main } from "../../scripts/bootstrap/index.mjs";

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
    assert.match(writes[0].source, /AUTH_SKIP_EMAIL_VERIFICATION=true/);
    assert.match(stdoutChunks.join(""), /Auto-completed backend\/.env for non-interactive startup/);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: originalStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutIsTTY, configurable: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
