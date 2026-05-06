import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildEnvValues, parseEnvFile, renderEnvFile, writeEnvFileAtomic } from "../../scripts/bootstrap/env-file.mjs";
import { listRequiredKeys } from "../../scripts/bootstrap/support/env-contract.mjs";

test("parseEnvFile ignores comments and reads values", () => {
  const values = parseEnvFile("# comment\nOPENAI_API_KEY=test\nLLM_PROVIDER=openai\n");
  assert.equal(values.OPENAI_API_KEY, "test");
  assert.equal(values.LLM_PROVIDER, "openai");
});

test("buildEnvValues preserves existing values unless overridden", () => {
  const values = buildEnvValues(
    { OPENAI_API_KEY: "existing", LLM_PROVIDER: "openai" },
    {
      SESSION_COOKIE_SECRET: "generated",
      WORKSPACE_TOKEN_SECRET: "workspace-secret",
      PUBLIC_CHAT_SESSION_SECRET: "public-session-secret",
      CONNECTOR_ENCRYPTION_KEY: "connector",
    },
  );

  assert.equal(values.OPENAI_API_KEY, "existing");
  assert.equal(values.SESSION_COOKIE_SECRET, "generated");
  assert.equal(values.WORKSPACE_TOKEN_SECRET, "workspace-secret");
  assert.equal(values.PUBLIC_CHAT_SESSION_SECRET, "public-session-secret");
});

test("env contract does not include OSS mail settings", () => {
  const values = buildEnvValues(
    { OPENAI_API_KEY: "existing", LLM_PROVIDER: "openai" },
    {
      SESSION_COOKIE_SECRET: "generated",
      WORKSPACE_TOKEN_SECRET: "workspace-secret",
      PUBLIC_CHAT_SESSION_SECRET: "public-session-secret",
      CONNECTOR_ENCRYPTION_KEY: "connector",
    },
  );

  assert.equal(values.AUTH_SKIP_EMAIL_VERIFICATION, undefined);
  assert.equal(values.MAIL_DRIVER, undefined);
});

test("writeEnvFileAtomic writes rendered env content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-"));
  const filePath = path.join(tempDir, ".env");
  const content = renderEnvFile({
    PORT: "8080",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://example",
    INTEGRATION_DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    OPENAI_CHAT_MODEL: "gpt-5.2",
    OPENAI_RERANK_MODEL: "gpt-5.2",
    OPENAI_VECTOR_MODEL: "text-embedding-3-small",
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
    PUBLIC_CHAT_SESSION_SECRET: "public-session-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "connector",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  await writeEnvFileAtomic(filePath, content);
  const written = await fs.readFile(filePath, "utf8");
  assert.match(written, /OPENAI_API_KEY=sk-test/);
});

test("renderEnvFile omits blank optional values", () => {
  const content = renderEnvFile({
    PORT: "8080",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://example",
    INTEGRATION_DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    OPENAI_COMPATIBLE_API_KEY: "",
    OPENAI_COMPATIBLE_BASE_URL: "",
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
    PUBLIC_CHAT_SESSION_SECRET: "public-session-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "connector",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  assert.match(content, /OPENAI_API_KEY=sk-test/);
  assert.doesNotMatch(content, /OPENAI_COMPATIBLE_API_KEY=/);
  assert.doesNotMatch(content, /OPENAI_COMPATIBLE_BASE_URL=/);
});

test("renderEnvFile preserves autoscaling worker env keys", () => {
  const content = renderEnvFile({
    PORT: "8080",
    NODE_ENV: "development",
    GOOGLE_CLOUD_PROJECT: "radioso-test",
    DATABASE_URL: "postgres://example",
    INTEGRATION_DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    OPENAI_CHAT_MODEL: "gpt-5.2",
    OPENAI_RERANK_MODEL: "gpt-5.2",
    OPENAI_VECTOR_MODEL: "text-embedding-3-small",
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
    PUBLIC_CHAT_SESSION_SECRET: "public-session-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "connector",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    WORKER_DISPATCH_DRIVER: "cloud-tasks",
    WORKER_TASKS_QUEUE_LOCATION: "europe-west1",
    WORKER_TASKS_QUEUE_NAME: "document-jobs",
    WORKER_TASKS_SERVICE_URL: "https://worker.example.com",
    WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "worker@example.iam.gserviceaccount.com",
    DOCUMENT_PROCESSING_JOB_LEASE_MS: "300000",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  assert.match(content, /GOOGLE_CLOUD_PROJECT=radioso-test/);
  assert.match(content, /WORKER_DISPATCH_DRIVER=cloud-tasks/);
  assert.match(content, /WORKER_TASKS_QUEUE_LOCATION=europe-west1/);
  assert.match(content, /WORKER_TASKS_QUEUE_NAME=document-jobs/);
  assert.match(content, /WORKER_TASKS_SERVICE_URL=https:\/\/worker.example.com/);
  assert.match(content, /WORKER_TASKS_INVOKER_SERVICE_ACCOUNT=worker@example.iam.gserviceaccount.com/);
  assert.match(content, /DOCUMENT_PROCESSING_JOB_LEASE_MS=300000/);
});

test("listRequiredKeys requires Cloud Tasks settings only when Cloud Tasks dispatch is enabled", () => {
  const noopRequired = listRequiredKeys({
    LLM_PROVIDER: "openai",
    DOCUMENT_STORAGE_DRIVER: "local",
    WORKER_DISPATCH_DRIVER: "noop",
  });
  assert.ok(!noopRequired.includes("GOOGLE_CLOUD_PROJECT"));
  assert.ok(!noopRequired.includes("WORKER_TASKS_QUEUE_NAME"));

  const cloudTasksRequired = listRequiredKeys({
    LLM_PROVIDER: "openai",
    DOCUMENT_STORAGE_DRIVER: "local",
    WORKER_DISPATCH_DRIVER: "cloud-tasks",
  });
  assert.ok(cloudTasksRequired.includes("GOOGLE_CLOUD_PROJECT"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_QUEUE_LOCATION"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_QUEUE_NAME"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_SERVICE_URL"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"));
  assert.ok(cloudTasksRequired.includes("DOCUMENT_PROCESSING_JOB_LEASE_MS"));
});
