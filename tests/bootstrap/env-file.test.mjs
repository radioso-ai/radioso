import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEnvValues,
  enforceEnvFilePermissions,
  parseEnvFile,
  renderEnvFile,
  writeEnvFileAtomic,
} from "../../scripts/bootstrap/env-file.mjs";
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
  assert.equal(values.WORKER_TASK_AUTH_TOKEN, "");
});

test("buildEnvValues removes the retired integration database URL", () => {
  const values = buildEnvValues(
    {
      LLM_PROVIDER: "openai",
      INTEGRATION_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/radioso_test",
    },
    {},
  );

  assert.equal(values.INTEGRATION_DATABASE_URL, undefined);
});

test("renderEnvFile includes the worker task authentication token", () => {
  const content = renderEnvFile({
    WORKER_TASK_AUTH_TOKEN: "a".repeat(64),
  });

  assert.match(content, new RegExp(`WORKER_TASK_AUTH_TOKEN=${"a".repeat(64)}`));
});

test("env bootstrap includes default auth mail settings", () => {
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
  assert.equal(values.MAIL_DRIVER, "log");
  assert.equal(values.MAIL_FROM_EMAIL, "noreply@example.com");
  assert.equal(values.MAIL_FROM_NAME, "Radioso");
  assert.equal(values.PASSWORD_RESET_TOKEN_TTL_MINUTES, "30");
  assert.equal(values.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES, "30");
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
    MAIL_DRIVER: "log",
    PASSWORD_RESET_TOKEN_TTL_MINUTES: "30",
    EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: "30",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  await writeEnvFileAtomic(filePath, content);
  const written = await fs.readFile(filePath, "utf8");
  assert.match(written, /OPENAI_API_KEY=sk-test/);
  assert.match(written, /MAIL_DRIVER=log/);
  assert.match(written, /PASSWORD_RESET_TOKEN_TTL_MINUTES=30/);
  assert.match(written, /EMAIL_VERIFICATION_TOKEN_TTL_MINUTES=30/);
});

test("writeEnvFileAtomic creates secret-bearing env files with owner-only permissions under a permissive umask", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-"));
  const filePath = path.join(tempDir, ".env");
  const previousUmask = process.umask(0o022);

  try {
    await writeEnvFileAtomic(filePath, "SESSION_COOKIE_SECRET=generated-secret\n");
  } finally {
    process.umask(previousUmask);
  }

  const stats = await fs.stat(filePath);
  assert.equal(stats.mode & 0o777, 0o600);
});

test("writeEnvFileAtomic corrects an existing env file to owner-only permissions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-"));
  const filePath = path.join(tempDir, ".env");
  await fs.writeFile(filePath, "SESSION_COOKIE_SECRET=old-secret\n", { mode: 0o644 });
  await fs.chmod(filePath, 0o644);

  await writeEnvFileAtomic(filePath, "SESSION_COOKIE_SECRET=new-secret\n");

  const stats = await fs.stat(filePath);
  assert.equal(stats.mode & 0o777, 0o600);
});

test("enforceEnvFilePermissions corrects a valid existing env file without rewriting it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-"));
  const filePath = path.join(tempDir, ".env");
  const source = "SESSION_COOKIE_SECRET=existing-secret\n";
  await fs.writeFile(filePath, source, { mode: 0o644 });
  await fs.chmod(filePath, 0o644);

  await enforceEnvFilePermissions(filePath);

  const stats = await fs.stat(filePath);
  assert.equal(stats.mode & 0o777, 0o600);
  assert.equal(await fs.readFile(filePath, "utf8"), source);
});

test("enforceEnvFilePermissions tolerates a missing first-boot env file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-"));
  const filePath = path.join(tempDir, ".env");

  try {
    await assert.doesNotReject(enforceEnvFilePermissions(filePath));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
    WORKER_TASKS_CRAWL_QUEUE_NAME: "website-crawls",
    WORKER_TASKS_SERVICE_URL: "https://worker.example.com",
    WORKER_TASKS_INVOKER_SERVICE_ACCOUNT: "worker@example.iam.gserviceaccount.com",
    DOCUMENT_PROCESSING_JOB_LEASE_MS: "300000",
    WEBSITE_CRAWL_JOB_LEASE_MS: "900000",
    WEBSITE_CRAWL_WORKER_POLL_INTERVAL_MS: "5000",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  assert.match(content, /GOOGLE_CLOUD_PROJECT=radioso-test/);
  assert.match(content, /WORKER_DISPATCH_DRIVER=cloud-tasks/);
  assert.match(content, /WORKER_TASKS_QUEUE_LOCATION=europe-west1/);
  assert.match(content, /WORKER_TASKS_QUEUE_NAME=document-jobs/);
  assert.match(content, /WORKER_TASKS_CRAWL_QUEUE_NAME=website-crawls/);
  assert.match(content, /WORKER_TASKS_SERVICE_URL=https:\/\/worker.example.com/);
  assert.match(content, /WORKER_TASKS_INVOKER_SERVICE_ACCOUNT=worker@example.iam.gserviceaccount.com/);
  assert.match(content, /DOCUMENT_PROCESSING_JOB_LEASE_MS=300000/);
  assert.match(content, /WEBSITE_CRAWL_JOB_LEASE_MS=900000/);
});

test("listRequiredKeys requires Cloud Tasks settings only when Cloud Tasks dispatch is enabled", () => {
  const noopRequired = listRequiredKeys({
    LLM_PROVIDER: "openai",
    DOCUMENT_STORAGE_DRIVER: "local",
    WORKER_DISPATCH_DRIVER: "noop",
  });
  assert.ok(!noopRequired.includes("GOOGLE_CLOUD_PROJECT"));
  assert.ok(!noopRequired.includes("WORKER_TASKS_QUEUE_NAME"));
  assert.ok(!noopRequired.includes("WORKER_TASKS_CRAWL_QUEUE_NAME"));

  const cloudTasksRequired = listRequiredKeys({
    LLM_PROVIDER: "openai",
    DOCUMENT_STORAGE_DRIVER: "local",
    WORKER_DISPATCH_DRIVER: "cloud-tasks",
  });
  assert.ok(cloudTasksRequired.includes("GOOGLE_CLOUD_PROJECT"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_QUEUE_LOCATION"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_QUEUE_NAME"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_CRAWL_QUEUE_NAME"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_SERVICE_URL"));
  assert.ok(cloudTasksRequired.includes("WORKER_TASKS_INVOKER_SERVICE_ACCOUNT"));
  assert.ok(cloudTasksRequired.includes("DOCUMENT_PROCESSING_JOB_LEASE_MS"));
});
